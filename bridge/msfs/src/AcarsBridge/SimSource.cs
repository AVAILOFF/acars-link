namespace AcarsBridge;

/// <summary>Receives what a sim source produces. Implemented by <see cref="BridgeHub"/>.</summary>
public interface ISimSink
{
    void OnStatus(BridgeStatus status);
    void OnTelemetry(TelemetrySnapshot snapshot);
}

/// <summary>A telemetry source (SimConnect, X-Plane, auto, fake). Runs until cancelled, reconnecting on its own.</summary>
public interface ISimSource
{
    string Name { get; }
    Task RunAsync(ISimSink sink, CancellationToken ct);
}

/// <summary>How one session with a simulator ended. <c>Answered</c>: the sim was there (the backoff starts over).</summary>
public readonly record struct SessionEnd(string Reason, bool Answered);

/// <summary>
/// A simulator the bridge connects to (SimConnect, X-Plane), one session at a time; <see cref="SimLoop"/> reconnects.
/// The session reports <c>connected</c> statuses and telemetry; <c>connecting</c> and the wait before a retry are
/// the loop's.
/// </summary>
public interface ISimSession
{
    /// <summary>Wire name: <c>hello.source</c> and <c>status.source</c>.</summary>
    string Name { get; }

    /// <summary>Connects once and runs until the sim goes away. Expected failures are a <see cref="SessionEnd"/>,
    /// not an exception; cancellation ends it.</summary>
    Task<SessionEnd> RunSessionAsync(ISimSink sink, CancellationToken ct);
}

/// <summary>
/// The reconnect loop around one or more simulators (T59). A round tries each in order: <c>connecting</c>, then a
/// session; the first that answers keeps the bridge until it goes away (a running session is not interrupted by the
/// others). After a round: <see cref="ReconnectPolicy"/> (shared by all, reset when one answered) with the reasons
/// of the round in <c>detail</c>. Connected statuses carry the session's <see cref="ISimSession.Name"/> as
/// <c>source</c>; <paramref name="active"/> learns which session runs (null between them).
/// </summary>
public static class SimLoop
{
    public static async Task RunAsync(IReadOnlyList<ISimSession> sims, ISimSink sink, ReconnectPolicy policy, TimeProvider clock,
        CancellationToken ct, Action<ISimSession?>? active = null)
    {
        var reasons = new List<string>(sims.Count);
        while (!ct.IsCancellationRequested)
        {
            reasons.Clear();
            var answered = false;
            foreach (var sim in sims)
            {
                if (ct.IsCancellationRequested) break;
                sink.OnStatus(BridgeStatus.Initial with { Sim = SimLink.Connecting });
                active?.Invoke(sim);
                SessionEnd end;
                try
                {
                    end = await sim.RunSessionAsync(new Tagged(sink, sim.Name), ct);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    break;
                }
                finally
                {
                    active?.Invoke(null);
                }
                if (end.Answered)
                {
                    // What the others said before this session is stale by now.
                    reasons.Clear();
                    answered = true;
                }
                reasons.Add(end.Reason);
            }
            if (ct.IsCancellationRequested) break;

            if (answered) policy.Reset();
            var delay = policy.NextDelay();
            sink.OnStatus(BridgeStatus.Initial with { Detail = string.Join("; ", reasons), RetryInMs = (int)delay.TotalMilliseconds });
            try
            {
                await Task.Delay(delay, clock, ct);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
        sink.OnStatus(BridgeStatus.Initial with { Detail = "stopped" });
    }

    /// <summary>Puts the session's name on its connected statuses.</summary>
    private sealed class Tagged(ISimSink sink, string source) : ISimSink
    {
        public void OnStatus(BridgeStatus status) =>
            sink.OnStatus(status.Sim == SimLink.Connected ? status with { Source = source } : status);

        public void OnTelemetry(TelemetrySnapshot snapshot) => sink.OnTelemetry(snapshot);
    }
}

/// <summary>
/// Source <c>auto</c> (T59, the default): MSFS and X-Plane 12 in turn, the one that answers first is used until it
/// closes, then both are looked for again (decisions of 2026-10-23: first to answer wins; one shared backoff;
/// <c>status.source</c> says which sim is connected, <c>hello.source</c> is <c>auto</c>). Commands: all the
/// sims' commands; each goes to the running sim if it offers it, else to the first that does (which says
/// <c>sim not connected</c> for a start and clears a standing request for a stop).
/// </summary>
public sealed class AutoSimSource(IReadOnlyList<ISimSession> sims, TimeProvider clock, ReconnectPolicy? policy = null)
    : ISimSource, ICommandTarget
{
    public const string SourceName = "auto";

    private readonly ReconnectPolicy _policy = policy ?? new ReconnectPolicy();
    private volatile ISimSession? _active;

    public string Name => SourceName;

    /// <summary>The sim whose session runs now (or is being tried); null between rounds.</summary>
    public ISimSession? Active => _active;

    public IReadOnlyCollection<string> Commands { get; } =
        sims.OfType<ICommandTarget>().SelectMany(t => t.Commands).Distinct().ToArray();

    public Task RunAsync(ISimSink sink, CancellationToken ct) =>
        SimLoop.RunAsync(sims, sink, _policy, clock, ct, s => _active = s);

    public Task<CommandResult> ExecuteAsync(SimCommand command, CancellationToken ct)
    {
        var target = _active is ICommandTarget a && a.Commands.Contains(command.Name)
            ? a
            : sims.OfType<ICommandTarget>().FirstOrDefault(t => t.Commands.Contains(command.Name));
        return target is null
            ? Task.FromResult(CommandResult.Fail(CommandErrors.UnknownCommand, command.Name))
            : target.ExecuteAsync(command, ct);
    }
}

/// <summary>
/// Reconnect delays: 1, 2, 4, 8, 16, 30, 30 … s (CLAUDE.md, invariant 6 in spirit: no tight retry loops).
/// Deterministic; <see cref="Reset"/> after a successful connection.
/// </summary>
public sealed class ReconnectPolicy(TimeSpan? initial = null, TimeSpan? max = null)
{
    private readonly TimeSpan _initial = initial ?? TimeSpan.FromSeconds(1);
    private readonly TimeSpan _max = max ?? TimeSpan.FromSeconds(30);
    private int _attempt;

    public TimeSpan NextDelay()
    {
        var factor = Math.Pow(2, Math.Min(_attempt, 16));
        _attempt++;
        var ms = Math.Min(_initial.TotalMilliseconds * factor, _max.TotalMilliseconds);
        return TimeSpan.FromMilliseconds(ms);
    }

    public void Reset() => _attempt = 0;
}

/// <summary>
/// Turns SimConnect callbacks into a steady ~1 Hz telemetry stream. Platform-neutral so pause and
/// sim-rate handling are unit-testable without the sim.
/// <list type="bullet">
/// <item>Frames are throttled to one per <see cref="MinInterval"/> of wall time (at sim rate ×4 the
///   SECOND period may fire faster than 1 Hz wall).</item>
/// <item>A pause change re-emits the last frame with the new <c>paused</c> flag: at once if the last
///   snapshot is older than <see cref="MinInterval"/>, otherwise on the next <see cref="Tick"/> once it
///   is. MSFS 2024 flips pause many times per second while a flight loads; the stream stays ≤ 1 Hz.</item>
/// <item><see cref="Tick"/> re-emits the last frame if the sim went quiet (data may stop while
///   paused), so the app keeps getting 1 Hz snapshots with <c>paused: true</c>.</item>
/// <item>Nothing is emitted while the sim is not running (menus, flight loading).</item>
/// </list>
/// Not thread-safe: call from the source's message loop only.
/// </summary>
public sealed class SnapshotPump(TimeProvider clock, Action<TelemetrySnapshot> emit)
{
    public static readonly TimeSpan MinInterval = TimeSpan.FromMilliseconds(900);
    public static readonly TimeSpan KeepAlive = TimeSpan.FromMilliseconds(1500);

    private SimFrame? _last;
    private DateTimeOffset _lastEmit = DateTimeOffset.MinValue;
    private bool _pending;

    public bool Running { get; private set; }
    public bool Paused { get; private set; }
    public double SimRate => _last is null ? 1 : _last[SimVars.SimRate];

    public void OnFrame(SimFrame frame)
    {
        _last = frame;
        _pending = true;
        EmitIfDue(MinInterval);
    }

    /// <summary>Pause_EX1 flags: any non-zero value (full, active or sim pause) counts as paused.</summary>
    /// <returns>True if the paused state changed.</returns>
    public bool OnPauseFlags(uint flags)
    {
        var paused = flags != 0;
        if (paused == Paused) return false;
        Paused = paused;
        _pending = true;
        EmitIfDue(MinInterval);
        return true;
    }

    /// <summary>SimConnect "Sim" event: 1 running, 0 not running.</summary>
    /// <returns>True if the running state changed.</returns>
    public bool OnSimRunning(bool running)
    {
        if (running == Running) return false;
        Running = running;
        if (!running) _last = null; // stale data from before a reload must not be replayed
        return true;
    }

    public void Tick()
    {
        if (!EmitIfDue(MinInterval)) EmitIfDue(KeepAlive, force: true);
    }

    public void Reset()
    {
        _last = null;
        _lastEmit = DateTimeOffset.MinValue;
        Running = false;
        Paused = false;
        _pending = false;
    }

    /// <summary>Emits when something is pending (or <paramref name="force"/>) and <paramref name="gap"/> has passed.</summary>
    private bool EmitIfDue(TimeSpan gap, bool force = false)
    {
        if (!Running || _last is null || !(_pending || force)) return false;
        var now = clock.GetUtcNow();
        if (now - _lastEmit < gap) return false;
        _lastEmit = now;
        _pending = false;
        emit(TelemetryMapper.Map(_last, Paused, now));
        return true;
    }
}
