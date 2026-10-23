using System.Text.Json.Nodes;
using AcarsBridge;
using Xunit;

namespace AcarsBridge.Tests;

/// <summary>T59: source <c>auto</c> — MSFS and X-Plane in turn, the first to answer is used until it closes.</summary>
public class AutoSourceTests
{
    private sealed class Sink : ISimSink
    {
        private readonly object _gate = new();
        private readonly List<BridgeStatus> _statuses = [];
        private readonly List<TelemetrySnapshot> _telemetry = [];

        public void OnStatus(BridgeStatus status)
        {
            lock (_gate) _statuses.Add(status);
        }

        public void OnTelemetry(TelemetrySnapshot snapshot)
        {
            lock (_gate) _telemetry.Add(snapshot);
        }

        public BridgeStatus[] Statuses
        {
            get { lock (_gate) return [.. _statuses]; }
        }

        public TelemetrySnapshot[] Telemetry
        {
            get { lock (_gate) return [.. _telemetry]; }
        }
    }

    /// <summary>
    /// A sim that is absent (the session ends at once, not answered) until <see cref="Up"/>; then a session is
    /// connected until <see cref="Close"/>.
    /// </summary>
    private sealed class ScriptedSim(string name, params string[] commands) : ISimSession, ICommandTarget
    {
        private TaskCompletionSource _closed = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public volatile bool Up;
        public int Tries;
        public readonly List<string> Ran = [];

        public string Name => name;
        public IReadOnlyCollection<string> Commands => commands;

        public void Close()
        {
            Up = false;
            _closed.TrySetResult();
        }

        public async Task<SessionEnd> RunSessionAsync(ISimSink sink, CancellationToken ct)
        {
            Interlocked.Increment(ref Tries);
            if (!Up) return new SessionEnd($"{name}: not running", false);
            _closed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            sink.OnStatus(new BridgeStatus(SimLink.Connected, true, false, 1));
            await _closed.Task.WaitAsync(ct);
            return new SessionEnd($"{name} quit", true);
        }

        public Task<CommandResult> ExecuteAsync(SimCommand command, CancellationToken ct)
        {
            lock (Ran) Ran.Add(command.Name);
            return Task.FromResult(CommandResult.Success);
        }
    }

    private static ReconnectPolicy Fast() => new(TimeSpan.FromMilliseconds(10), TimeSpan.FromMilliseconds(10));

    private static SimCommand Cmd(string name) => new("c", name, new Dictionary<string, JsonValue>());

    private static async Task Until(Func<bool> done, int ms = 10_000)
    {
        var until = DateTime.UtcNow.AddMilliseconds(ms);
        while (!done())
        {
            if (DateTime.UtcNow > until) throw new TimeoutException("condition not met");
            await Task.Delay(10);
        }
    }

    [Fact]
    public async Task Without_sims_both_are_tried_again_and_again()
    {
        var msfs = new ScriptedSim("simconnect");
        var xp = new ScriptedSim("xplane");
        var auto = new AutoSimSource([msfs, xp], TimeProvider.System, Fast());
        var sink = new Sink();
        using var cts = new CancellationTokenSource();
        var run = auto.RunAsync(sink, cts.Token);

        await Until(() => msfs.Tries >= 3 && xp.Tries >= 3);
        cts.Cancel();
        await run;

        var retry = sink.Statuses.First(s => s.RetryInMs is not null);
        Assert.Equal("simconnect: not running; xplane: not running", retry.Detail);
        Assert.Equal(SimLink.Disconnected, retry.Sim);
        Assert.DoesNotContain(sink.Statuses, s => s.Source is not null);
        Assert.Equal("stopped", sink.Statuses[^1].Detail);
        Assert.Equal("auto", auto.Name);
    }

    [Fact]
    public async Task Backoff_is_shared_and_grows_while_no_sim_answers()
    {
        var auto = new AutoSimSource([new ScriptedSim("simconnect"), new ScriptedSim("xplane")], TimeProvider.System,
            new ReconnectPolicy(TimeSpan.FromMilliseconds(5), TimeSpan.FromMilliseconds(20)));
        var sink = new Sink();
        using var cts = new CancellationTokenSource();
        var run = auto.RunAsync(sink, cts.Token);
        await Until(() => sink.Statuses.Count(s => s.RetryInMs is not null) >= 4);
        cts.Cancel();
        await run;
        // One wait per round (not per sim): 5, 10, 20, 20 ms.
        Assert.Equal([5, 10, 20, 20], sink.Statuses.Where(s => s.RetryInMs is not null).Take(4).Select(s => s.RetryInMs!.Value));
    }

    [Fact]
    public async Task X_plane_answers_then_closes_and_MSFS_is_taken_without_a_restart()
    {
        var msfs = new ScriptedSim("simconnect", "ping", "smoke_start");
        var xp = new ScriptedSim("xplane", "ping") { Up = true };
        var auto = new AutoSimSource([msfs, xp], TimeProvider.System, Fast());
        var sink = new Sink();
        using var cts = new CancellationTokenSource();
        var run = auto.RunAsync(sink, cts.Token);

        await Until(() => sink.Statuses.Any(s => s.Source == "xplane"));
        Assert.Same(xp, auto.Active);
        var connected = sink.Statuses.Last();
        Assert.Equal(new BridgeStatus(SimLink.Connected, true, false, 1, Source: "xplane"), connected);

        // While X-Plane runs MSFS is not tried, even if it starts.
        msfs.Up = true;
        var triesWhileXPlane = msfs.Tries;
        await Task.Delay(100);
        Assert.Equal(triesWhileXPlane, msfs.Tries);

        // Commands: to the running sim if it has the command, else to the first that does.
        Assert.True((await auto.ExecuteAsync(Cmd("ping"), default)).Ok);
        Assert.True((await auto.ExecuteAsync(Cmd("smoke_start"), default)).Ok);
        Assert.Equal(["ping"], xp.Ran);
        Assert.Equal(["smoke_start"], msfs.Ran);
        Assert.Equal(["ping", "smoke_start"], auto.Commands);

        xp.Close();
        await Until(() => sink.Statuses.Any(s => s.Source == "simconnect"));
        Assert.Same(msfs, auto.Active);
        Assert.Contains(sink.Statuses, s => s.Detail == "xplane quit");
        Assert.True((await auto.ExecuteAsync(Cmd("ping"), default)).Ok);
        Assert.Equal(["smoke_start", "ping"], msfs.Ran);

        cts.Cancel();
        await run;
        Assert.Null(auto.Active);
    }

    [Fact]
    public async Task An_unknown_command_is_refused()
    {
        var auto = new AutoSimSource([new ScriptedSim("xplane", "ping")], TimeProvider.System, Fast());
        var r = await auto.ExecuteAsync(Cmd("rescue_start"), default);
        Assert.False(r.Ok);
        Assert.Equal(CommandErrors.UnknownCommand, r.Error);
    }

    [Fact]
    public async Task Streams_from_a_real_x_plane_web_api_with_source_xplane()
    {
        await using var xp = new FakeXPlane();
        xp.Updates.Add(XPlaneStateTests.Parked());
        await xp.StartAsync();

        var msfs = new ScriptedSim("simconnect");
        var auto = new AutoSimSource([msfs, new XPlaneSource(TimeProvider.System, xp.Port, Fast(), "127.0.0.1")], TimeProvider.System, Fast());
        var hub = new BridgeHub("0.0.0", auto.Name, auto.Commands.ToList());
        var sink = new Sink();
        using var cts = new CancellationTokenSource();
        var run = auto.RunAsync(new Both(hub, sink), cts.Token);

        await Until(() => sink.Telemetry.Length > 0);
        Assert.Contains(sink.Statuses, s => s is { Sim: SimLink.Connected, Running: true, Source: "xplane" });
        Assert.Contains("\"source\":\"xplane\"", Protocol.Status(hub.LastStatus));
        Assert.True(msfs.Tries >= 1);

        var (_, reader) = hub.Subscribe(2);
        Assert.True(reader.TryRead(out var hello));
        Assert.Equal("auto", (string)JsonNode.Parse(hello!)!["source"]!);

        cts.Cancel();
        await run;
    }

    [Fact]
    public void Status_has_no_source_while_not_connected()
    {
        Assert.DoesNotContain("source", Protocol.Status(BridgeStatus.Initial with { Sim = SimLink.Connecting }));
    }

    private sealed class Both(ISimSink a, ISimSink b) : ISimSink
    {
        public void OnStatus(BridgeStatus status)
        {
            a.OnStatus(status);
            b.OnStatus(status);
        }

        public void OnTelemetry(TelemetrySnapshot snapshot)
        {
            a.OnTelemetry(snapshot);
            b.OnTelemetry(snapshot);
        }
    }
}
