using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using AcarsBridge;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;

namespace AcarsBridge.Tests;

public class BridgeHubTests
{
    private static List<JsonNode> Drain(System.Threading.Channels.ChannelReader<string> r)
    {
        var list = new List<JsonNode>();
        while (r.TryRead(out var s)) list.Add(JsonNode.Parse(s)!);
        return list;
    }

    [Fact]
    public void New_client_gets_hello_status_and_last_telemetry()
    {
        var hub = new BridgeHub("0.1.0", "fake");
        hub.OnStatus(new BridgeStatus(SimLink.Connected, true, false, 1));
        hub.OnTelemetry(FakeSimSource.Parked);

        var (_, reader) = hub.Subscribe();
        var frames = Drain(reader);
        Assert.Equal(["hello", "status", "telemetry"], frames.Select(f => (string)f["type"]!));
        Assert.Equal(1, (int)frames[0]["protocol"]!); // no version asked for: v1
        Assert.Equal(TelemetrySnapshot.Version, (int)frames[0]["telemetryVersion"]!);
        Assert.Equal("connected", (string)frames[1]["sim"]!);
        Assert.Equal("FenixA320_DLH", (string)frames[2]["data"]!["aircraftTitle"]!);

        var (_, v2) = new BridgeHub("0.1.0", "fake", ["ping"]).Subscribe(2);
        var hello = Drain(v2)[0];
        Assert.Equal(Protocol.ProtocolVersion, (int)hello["protocol"]!);
        Assert.Equal("ping", (string)hello["commands"]![0]!);
    }

    [Fact]
    public void Duplicate_status_is_not_rebroadcast_and_disconnect_drops_cached_telemetry()
    {
        var hub = new BridgeHub("0.1.0", "fake");
        var (_, reader) = hub.Subscribe();
        Drain(reader);

        var s = new BridgeStatus(SimLink.Connected, true, true, 4);
        hub.OnStatus(s);
        hub.OnStatus(s with { });
        hub.OnTelemetry(FakeSimSource.Parked);
        hub.OnStatus(BridgeStatus.Initial with { Detail = "sim quit", RetryInMs = 1000 });
        var frames = Drain(reader);
        Assert.Equal(["status", "telemetry", "status"], frames.Select(f => (string)f["type"]!));
        Assert.Equal(1000, (int)frames[2]["retryInMs"]!);

        var (_, late) = hub.Subscribe();
        Assert.Equal(["hello", "status"], Drain(late).Select(f => (string)f["type"]!));
    }

    [Fact]
    public void Slow_client_queue_drops_oldest_instead_of_blocking()
    {
        var hub = new BridgeHub("0.1.0", "fake");
        var (id, reader) = hub.Subscribe();
        for (var i = 0; i < 1000; i++) hub.OnTelemetry(FakeSimSource.Parked with { T = i });
        var frames = Drain(reader);
        Assert.True(frames.Count <= 32);
        Assert.Equal(999, (long)frames[^1]["data"]!["t"]!);

        hub.Unsubscribe(id);
        Assert.Equal(0, hub.ClientCount);
    }
}

public sealed class BridgeServerTests : IAsyncLifetime
{
    private readonly int _port = Repo.FreePort();
    private readonly CancellationTokenSource _cts = new();
    private BridgeHub _hub = null!;
    private WebApplication _app = null!;
    private Task _source = Task.CompletedTask;

    public async Task InitializeAsync()
    {
        _hub = new BridgeHub("0.1.0", "fake");
        _app = BridgeServer.Build(_hub, _port);
        await _app.StartAsync();
        _source = new FakeSimSource(TimeProvider.System).RunAsync(_hub, _cts.Token);
    }

    public async Task DisposeAsync()
    {
        await _cts.CancelAsync();
        await _source;
        _hub.Complete();
        await _app.StopAsync();
        await _app.DisposeAsync();
    }

    [Fact]
    public void Listens_on_ipv4_loopback_only()
    {
        var addresses = _app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses;
        Assert.Equal([$"http://127.0.0.1:{_port}"], addresses);
    }

    [Fact]
    public async Task Streams_hello_status_and_telemetry()
    {
        using var ws = new ClientWebSocket();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await ws.ConnectAsync(new Uri($"ws://127.0.0.1:{_port}/"), timeout.Token);

        var types = new List<string>();
        while (!types.Contains("telemetry"))
        {
            var frame = await Receive(ws, timeout.Token);
            types.Add((string)frame["type"]!);
            if ((string)frame["type"]! == "telemetry")
            {
                Assert.Equal(1, (int)frame["data"]!["v"]!);
                Assert.True((long)frame["data"]!["t"]! > 1_700_000_000_000);
            }
        }
        Assert.Equal("hello", types[0]);
        Assert.Contains("status", types);

        await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", timeout.Token);
    }

    [Fact]
    public async Task Foreign_origin_is_rejected()
    {
        using var ws = new ClientWebSocket();
        ws.Options.SetRequestHeader("Origin", "https://evil.example");
        var ex = await Assert.ThrowsAsync<WebSocketException>(() => ws.ConnectAsync(new Uri($"ws://127.0.0.1:{_port}/"), CancellationToken.None));
        Assert.Contains("403", ex.Message);
    }

    [Fact]
    public async Task Plain_http_gets_426()
    {
        using var http = new HttpClient();
        var r = await http.GetAsync($"http://127.0.0.1:{_port}/");
        Assert.Equal(HttpStatusCode.UpgradeRequired, r.StatusCode);
    }

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
}
