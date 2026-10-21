using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using AcarsBridge;
using Microsoft.AspNetCore.Builder;

namespace AcarsBridge.Tests;

public class CommandCatalogTests
{
    [Fact]
    public void Ping_is_whitelisted_and_parsed()
    {
        var (cmd, id, error) = CommandCatalog.Parse("""{"type":"command","id":"c1","command":"ping"}""");
        Assert.Null(error);
        Assert.Equal("c1", id);
        Assert.Equal("ping", cmd!.Name);
        Assert.Empty(cmd.Args);
        Assert.Null(CommandCatalog.Parse("""{"type":"command","id":"c1","command":"ping","args":{}}""").Error);
    }

    [Theory]
    [InlineData("not json", null, CommandErrors.BadFrame)]
    [InlineData("[1]", null, CommandErrors.BadFrame)]
    [InlineData("""{"type":"command","command":"ping"}""", null, CommandErrors.BadFrame)]
    [InlineData("""{"type":"command","id":"has space","command":"ping"}""", null, CommandErrors.BadFrame)]
    [InlineData("""{"type":"command","id":7,"command":"ping"}""", null, CommandErrors.BadFrame)]
    [InlineData("""{"type":"cmd","id":"a","command":"ping"}""", "a", CommandErrors.BadFrame)]
    [InlineData("""{"type":"command","id":"a","command":"Ping!"}""", "a", CommandErrors.BadFrame)]
    [InlineData("""{"type":"command","id":"a","command":"ping","extra":1}""", "a", CommandErrors.BadFrame)]
    [InlineData("""{"type":"command","id":"a","command":"ping","args":null}""", "a", CommandErrors.BadFrame)]
    [InlineData("""{"type":"command","id":"a","command":"ping","args":[1]}""", "a", CommandErrors.BadFrame)]
    [InlineData("""{"type":"command","id":"a","command":"ping","args":{"x":{"y":1}}}""", "a", CommandErrors.BadFrame)]
    [InlineData("""{"type":"command","id":"a","command":"ping","args":{"x":null}}""", "a", CommandErrors.BadFrame)]
    [InlineData("""{"type":"command","id":"a","command":"ping","args":{"Bad-Name":1}}""", "a", CommandErrors.BadFrame)]
    [InlineData("""{"type":"command","id":"a","command":"ping","args":{"x":1}}""", "a", CommandErrors.BadArgs)]
    [InlineData("""{"type":"command","id":"a","command":"set_lvar","args":{"name":"X"}}""", "a", CommandErrors.UnknownCommand)]
    public void Bad_frames_are_refused_with_the_id_when_readable(string text, string? id, string error)
    {
        var r = CommandCatalog.Parse(text);
        Assert.Null(r.Command);
        Assert.Equal(id, r.Id);
        Assert.Equal(error, r.Error!.Error);
    }

    [Fact]
    public void Long_string_args_are_refused()
    {
        var text = $$$"""{"type":"command","id":"a","command":"ping","args":{"s":"{{{new string('x', CommandCatalog.MaxStringArg + 1)}}}"}}""";
        Assert.Equal(CommandErrors.BadFrame, CommandCatalog.Parse(text).Error!.Error);
    }

    [Fact]
    public void Ack_frames()
    {
        Assert.Equal("""{"type":"ack","id":"a","ok":true}""", Protocol.Ack("a", CommandResult.Success));
        Assert.Equal("""{"type":"ack","id":null,"ok":false,"error":"bad_frame","detail":"not JSON"}""",
            Protocol.Ack(null, CommandResult.Fail(CommandErrors.BadFrame, "not JSON")));
        Assert.Equal("""{"type":"ack","id":"b","ok":false,"error":"rate_limited"}""",
            Protocol.Ack("b", CommandResult.Fail(CommandErrors.RateLimited)));
    }

    [Theory]
    [InlineData(null, 1)]
    [InlineData("", 1)]
    [InlineData("1", 1)]
    [InlineData("2", 2)]
    [InlineData("9", 2)]
    [InlineData("0", 1)]
    [InlineData("-2", 1)]
    [InlineData("two", 1)]
    public void Protocol_negotiation(string? requested, int expected) =>
        Assert.Equal(expected, Protocol.Negotiate(requested));

    [Fact]
    public void V1_hello_is_unchanged_and_v2_lists_commands()
    {
        var v1 = JsonNode.Parse(Protocol.Hello("0.1.0", "fake", 1, ["ping"]))!.AsObject();
        Assert.Equal(["type", "protocol", "telemetryVersion", "bridge", "version", "source"], v1.Select(p => p.Key));
        Assert.Equal(1, (int)v1["protocol"]!);

        var v2 = JsonNode.Parse(Protocol.Hello("0.1.0", "fake", 2, ["ping"]))!.AsObject();
        Assert.Equal(2, (int)v2["protocol"]!);
        Assert.Equal(["ping"], v2["commands"]!.AsArray().Select(n => (string)n!));
    }
}

public class CommandDispatcherTests
{
    private sealed class Target(Func<SimCommand, CancellationToken, Task<CommandResult>> run, params string[] commands) : ICommandTarget
    {
        public IReadOnlyCollection<string> Commands => commands;
        public Task<CommandResult> ExecuteAsync(SimCommand command, CancellationToken ct) => run(command, ct);
    }

    private const string Ping = """{"type":"command","id":"p","command":"ping"}""";

    private static JsonNode Ack(string frame) => JsonNode.Parse(frame)!;

    [Fact]
    public void Rate_limiter_allows_a_burst_then_refills()
    {
        var clock = ManualClock.At(0);
        var limit = new CommandRateLimiter(clock, burst: 3, perSecond: 2);
        Assert.True(limit.TryTake() && limit.TryTake() && limit.TryTake());
        Assert.False(limit.TryTake());
        clock.Advance(TimeSpan.FromMilliseconds(500));
        Assert.True(limit.TryTake());
        Assert.False(limit.TryTake());
        clock.Advance(TimeSpan.FromSeconds(60));
        Assert.True(limit.TryTake() && limit.TryTake() && limit.TryTake());
        Assert.False(limit.TryTake());
    }

    [Fact]
    public async Task Fake_source_confirms_and_records()
    {
        var fake = new FakeSimSource(TimeProvider.System);
        var d = new CommandDispatcher(fake, TimeProvider.System);
        Assert.Equal(["ping", "rescue_start", "rescue_stop", "smoke_start", "smoke_stop"], d.Commands);
        var ack = Ack(await d.HandleAsync(Guid.NewGuid(), Ping, CancellationToken.None));
        Assert.True((bool)ack["ok"]!);
        Assert.Equal("p", (string)ack["id"]!);
        Assert.Equal("ping", Assert.Single(fake.Executed).Name);
    }

    [Fact]
    public async Task Source_without_the_command_or_without_commands()
    {
        var none = new CommandDispatcher(null, TimeProvider.System);
        Assert.Empty(none.Commands);
        Assert.Equal(CommandErrors.UnknownCommand, (string)Ack(await none.HandleAsync(Guid.NewGuid(), Ping, default))["error"]!);

        var other = new CommandDispatcher(new Target((_, _) => Task.FromResult(CommandResult.Success), "something_else"), TimeProvider.System);
        Assert.Empty(other.Commands);
    }

    [Fact]
    public async Task Source_failure_exception_and_timeout_become_acks()
    {
        var unavailable = new CommandDispatcher(
            new Target((_, _) => Task.FromResult(CommandResult.Fail(CommandErrors.Unavailable, "sim not connected")), "ping"),
            TimeProvider.System);
        var a = Ack(await unavailable.HandleAsync(Guid.NewGuid(), Ping, default));
        Assert.Equal(CommandErrors.Unavailable, (string)a["error"]!);
        Assert.Equal("sim not connected", (string)a["detail"]!);

        var throws = new CommandDispatcher(new Target((_, _) => throw new InvalidOperationException("boom"), "ping"), TimeProvider.System);
        a = Ack(await throws.HandleAsync(Guid.NewGuid(), Ping, default));
        Assert.Equal(CommandErrors.Failed, (string)a["error"]!);
        Assert.Equal("boom", (string)a["detail"]!);

        var hangs = new CommandDispatcher(
            new Target(async (_, ct) =>
            {
                await Task.Delay(Timeout.Infinite, ct);
                return CommandResult.Success;
            }, "ping"),
            TimeProvider.System, TimeSpan.FromMilliseconds(50));
        a = Ack(await hangs.HandleAsync(Guid.NewGuid(), Ping, default));
        Assert.Equal(CommandErrors.Failed, (string)a["error"]!);
        Assert.Equal("timeout", (string)a["detail"]!);
    }

    [Fact]
    public async Task Rate_limit_is_per_client()
    {
        var d = new CommandDispatcher(new FakeSimSource(TimeProvider.System), ManualClock.At(0));
        var a = Guid.NewGuid();
        for (var i = 0; i < CommandRateLimiter.Burst; i++)
            Assert.True((bool)Ack(await d.HandleAsync(a, Ping, default))["ok"]!);
        Assert.Equal(CommandErrors.RateLimited, (string)Ack(await d.HandleAsync(a, Ping, default))["error"]!);
        Assert.True((bool)Ack(await d.HandleAsync(Guid.NewGuid(), Ping, default))["ok"]!);
    }
}

public sealed class CommandServerTests : IAsyncLifetime
{
    private readonly int _port = Repo.FreePort();
    private readonly CancellationTokenSource _cts = new();
    private readonly FakeSimSource _fake = new(TimeProvider.System);
    private BridgeHub _hub = null!;
    private WebApplication _app = null!;
    private Task _source = Task.CompletedTask;

    public async Task InitializeAsync()
    {
        var commands = new CommandDispatcher(_fake, TimeProvider.System);
        _hub = new BridgeHub("0.1.0", "fake", commands.Commands);
        _app = BridgeServer.Build(_hub, _port, commands);
        await _app.StartAsync();
        _source = _fake.RunAsync(_hub, _cts.Token);
    }

    public async Task DisposeAsync()
    {
        await _cts.CancelAsync();
        await _source;
        _hub.Complete();
        await _app.StopAsync();
        await _app.DisposeAsync();
    }

    private async Task<ClientWebSocket> Connect(string query)
    {
        var ws = new ClientWebSocket();
        await ws.ConnectAsync(new Uri($"ws://127.0.0.1:{_port}/{query}"), CancellationToken.None);
        return ws;
    }

    private static Task SendText(ClientWebSocket ws, string text) =>
        ws.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, CancellationToken.None);

    private static async Task<JsonNode> Receive(ClientWebSocket ws, CancellationToken ct)
    {
        var buffer = new byte[64 * 1024];
        using var ms = new MemoryStream();
        WebSocketReceiveResult r;
        do
        {
            r = await ws.ReceiveAsync(buffer, ct);
            ms.Write(buffer, 0, r.Count);
        } while (!r.EndOfMessage);
        return JsonNode.Parse(Encoding.UTF8.GetString(ms.ToArray()))!;
    }

    /// <summary>Next frame of <paramref name="type"/>, skipping status/telemetry.</summary>
    private static async Task<JsonNode> Next(ClientWebSocket ws, string type, CancellationToken ct)
    {
        while (true)
        {
            var f = await Receive(ws, ct);
            if ((string)f["type"]! == type) return f;
        }
    }

    [Fact]
    public async Task V2_client_pings_and_gets_its_ack()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var ws = await Connect("?protocol=2");
        var hello = await Receive(ws, timeout.Token);
        Assert.Equal(2, (int)hello["protocol"]!);
        Assert.Equal(["ping", "rescue_start", "rescue_stop", "smoke_start", "smoke_stop"], hello["commands"]!.AsArray().Select(n => (string)n!));

        await SendText(ws, """{"type":"command","id":"x1","command":"ping"}""");
        var ack = await Next(ws, "ack", timeout.Token);
        Assert.Equal("x1", (string)ack["id"]!);
        Assert.True((bool)ack["ok"]!);
        Assert.Contains(_fake.Executed, c => c.Id == "x1");

        await SendText(ws, "{oops");
        ack = await Next(ws, "ack", timeout.Token);
        Assert.Null(ack["id"]);
        Assert.Equal(CommandErrors.BadFrame, (string)ack["error"]!);

        await SendText(ws, new string(' ', CommandCatalog.MaxFrameBytes * 3));
        ack = await Next(ws, "ack", timeout.Token);
        Assert.Equal("frame too long", (string)ack["detail"]!);

        await ws.SendAsync(new byte[] { 1, 2 }, WebSocketMessageType.Binary, true, timeout.Token);
        ack = await Next(ws, "ack", timeout.Token);
        Assert.Equal("text frames only", (string)ack["detail"]!);

        // The connection still works after bad frames.
        await SendText(ws, """{"type":"command","id":"x2","command":"ping"}""");
        Assert.Equal("x2", (string)(await Next(ws, "ack", timeout.Token))["id"]!);
    }

    [Fact]
    public async Task V1_client_gets_v1_hello_and_its_messages_are_ignored()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var v1 = await Connect("");
        var hello = await Receive(v1, timeout.Token);
        Assert.Equal(1, (int)hello["protocol"]!);
        Assert.Null(hello["commands"]);

        await SendText(v1, """{"type":"command","id":"v1","command":"ping"}""");
        // Two telemetry frames later still no ack, and the command never reached the source.
        var seen = new List<string>();
        while (seen.Count(t => t == "telemetry") < 2) seen.Add((string)(await Receive(v1, timeout.Token))["type"]!);
        Assert.DoesNotContain("ack", seen);
        Assert.DoesNotContain(_fake.Executed, c => c.Id == "v1");
    }

    [Fact]
    public async Task Ack_goes_only_to_the_sender()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var a = await Connect("?protocol=2");
        using var b = await Connect("?protocol=2");
        await SendText(a, """{"type":"command","id":"only-a","command":"ping"}""");
        Assert.Equal("only-a", (string)(await Next(a, "ack", timeout.Token))["id"]!);

        await SendText(b, """{"type":"command","id":"only-b","command":"ping"}""");
        var first = await Next(b, "ack", timeout.Token);
        Assert.Equal("only-b", (string)first["id"]!);
    }
}
