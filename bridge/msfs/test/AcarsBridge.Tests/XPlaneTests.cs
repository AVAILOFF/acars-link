using System.Collections.Concurrent;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using AcarsBridge;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;

namespace AcarsBridge.Tests;

public class XPlaneStateTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.FromUnixTimeMilliseconds(1791374400000);

    /// <summary>Ids as a fake X-Plane would give them: the position in <see cref="XPlaneDatarefs.All"/> + 100.</summary>
    internal static readonly IReadOnlyDictionary<long, string> Names =
        XPlaneDatarefs.All.Select((d, i) => (Id: (long)(i + 100), d.Name)).ToDictionary(p => p.Id, p => p.Name);

    internal static long Id(string name) => Names.Single(p => p.Value == name).Key;

    internal static string B64(string s) => Convert.ToBase64String(Encoding.UTF8.GetBytes(s + "\0\0\0"));

    /// <summary>A parked A320 at EDDF in X-Plane units, as the first update after subscribing (every value).</summary>
    internal static JsonObject Parked() => new()
    {
        [Id(XPlaneDatarefs.Lat).ToString()] = 50.03790012,
        [Id(XPlaneDatarefs.Lon).ToString()] = 8.56219987,
        [Id(XPlaneDatarefs.Elevation).ToString()] = 111.0, // 364.17 ft
        [Id(XPlaneDatarefs.Agl).ToString()] = 0.1,
        [Id(XPlaneDatarefs.Ias).ToString()] = 0.02,
        [Id(XPlaneDatarefs.Gs).ToString()] = 0,
        [Id(XPlaneDatarefs.Vs).ToString()] = -0.4,
        [Id(XPlaneDatarefs.Hdg).ToString()] = 250.41,
        [Id(XPlaneDatarefs.OnGround).ToString()] = 1,
        [Id(XPlaneDatarefs.ParkingBrake).ToString()] = 1.0,
        [Id(XPlaneDatarefs.Beacon).ToString()] = 0,
        [Id(XPlaneDatarefs.Engines).ToString()] = 2,
        [Id(XPlaneDatarefs.EngRunning).ToString()] = new JsonArray(0, 0, 0, 0),
        [Id(XPlaneDatarefs.N2).ToString()] = new JsonArray(0, 0, 0, 0),
        [Id(XPlaneDatarefs.Fuel).ToString()] = 6420.3,
        [Id(XPlaneDatarefs.Gear).ToString()] = 1,
        [Id(XPlaneDatarefs.FlapHandle).ToString()] = 0.0,
        [Id(XPlaneDatarefs.FlapDetents).ToString()] = 4,
        [Id(XPlaneDatarefs.Doors).ToString()] = new JsonArray(1.0, 0, 0, 0),
        [Id(XPlaneDatarefs.Xpdr).ToString()] = 1,
        [Id(XPlaneDatarefs.Paused).ToString()] = 0,
        [Id(XPlaneDatarefs.SimSpeed).ToString()] = 1,
        [Id(XPlaneDatarefs.UiName).ToString()] = B64("Airbus A320neo"),
        [Id(XPlaneDatarefs.Descrip).ToString()] = B64("A320"),
        [Id(XPlaneDatarefs.Icao).ToString()] = B64("A20N"),
    };

    private static void Apply(XPlaneState s, JsonObject data)
    {
        using var doc = JsonDocument.Parse(data.ToJsonString());
        s.Apply(doc.RootElement, Names);
    }

    private static TelemetrySnapshot Map(XPlaneState s) => TelemetryMapper.Map(s.Frame(), s.Paused, Now);

    [Fact]
    public void Every_dataref_is_unique_and_in_the_frame_layout()
    {
        Assert.Equal(XPlaneDatarefs.All.Count, XPlaneDatarefs.All.Select(d => d.Name).Distinct().Count());
        Assert.All(XPlaneDatarefs.All.Where(d => d.Index is not null), d => Assert.True(d.Index!.Length <= 4));
    }

    [Fact]
    public void Parked_aircraft_maps_to_msfs_units()
    {
        var s = new XPlaneState();
        Apply(s, Parked());
        var t = Map(s);
        Assert.Equal(50.0379, t.Lat);
        Assert.Equal(8.5622, t.Lon);
        Assert.Equal(364, t.AltFt); // 111 m
        Assert.Equal(0, t.AglFt);
        Assert.Equal(250.4, t.HdgTrue);
        Assert.True(t.OnGround);
        Assert.True(t.ParkingBrake);
        Assert.False(t.Beacon);
        Assert.Equal([false, false], t.EngRunning);
        Assert.Equal(6420, t.FuelKg);
        Assert.True(t.GearDown);
        Assert.Equal(0, t.FlapsIdx);
        Assert.Equal([100, 0, 0, 0], t.DoorsOpen);
        Assert.Equal(1, t.XpdrState);
        Assert.Equal(1, t.SimRate);
        Assert.False(t.Paused);
        Assert.Equal(0, t.TouchdownFpm);
        Assert.Null(t.SimUtcMs); // decided 2026-10-22: no sim clock from X-Plane
        Assert.Equal("Airbus A320neo (A20N)", t.AircraftTitle);
    }

    [Fact]
    public void Later_updates_change_only_what_they_carry()
    {
        var s = new XPlaneState();
        Apply(s, Parked());
        Apply(s, new JsonObject
        {
            [Id(XPlaneDatarefs.Gs).ToString()] = 10.0, // m/s
            [Id(XPlaneDatarefs.ParkingBrake).ToString()] = 0.3,
            [Id(XPlaneDatarefs.EngRunning).ToString()] = new JsonArray(1, 1, 0, 0),
            [Id(XPlaneDatarefs.N2).ToString()] = new JsonArray(60.12, 59.98, 0, 0),
            [Id(XPlaneDatarefs.FlapHandle).ToString()] = 0.5,
        });
        var t = Map(s);
        Assert.Equal(19.4, t.GsKt);
        Assert.False(t.ParkingBrake); // below 0.5
        Assert.Equal([true, true], t.EngRunning);
        Assert.Equal([60.1, 60], t.EngN2);
        Assert.Equal(2, t.FlapsIdx); // 0.5 × 4 detents
        Assert.Equal(8.5622, t.Lon); // kept from the first update
    }

    [Theory]
    [InlineData(0, 0)] // off
    [InlineData(1, 1)] // standby
    [InlineData(2, 3)] // on (mode A) → On
    [InlineData(3, 4)] // alt (mode C) → Alt
    [InlineData(4, 2)] // test
    [InlineData(5, 5)] // GND (mode S) → Ground
    [InlineData(6, 4)] // TA only → Alt
    [InlineData(7, 4)] // TA/RA → Alt
    public void Transponder_modes_map_to_msfs_states(int xplane, int msfs) =>
        Assert.Equal(msfs, XPlaneDatarefs.Transponder(xplane));

    [Theory]
    [InlineData("Boeing 737-800", "", "B738", "Boeing 737-800 (B738)")]
    [InlineData("Zibo B738", "", "B738", "Zibo B738")]
    [InlineData("", "Boeing 787-9", "B789", "Boeing 787-9 (B789)")]
    [InlineData("", "", "B77W", "B77W")]
    [InlineData("Cessna 172", "", "", "Cessna 172")]
    public void Title_prefers_ui_name_and_adds_the_icao_type(string ui, string descrip, string icao, string title) =>
        Assert.Equal(title, XPlaneDatarefs.Title(ui, descrip, icao));

    [Fact]
    public void Bad_base64_and_unknown_ids_are_ignored()
    {
        Assert.Equal("", XPlaneDatarefs.DecodeString("not base64!"));
        var s = new XPlaneState();
        Apply(s, new JsonObject { ["99999"] = 5, ["x"] = 1, [Id(XPlaneDatarefs.UiName).ToString()] = "%%%" });
        Assert.Equal("", s.Frame().Title);
    }

    [Fact]
    public void Pause_comes_from_paused_or_sim_speed_zero()
    {
        var s = new XPlaneState();
        Apply(s, Parked());
        Assert.False(s.Paused);
        Apply(s, new JsonObject { [Id(XPlaneDatarefs.Paused).ToString()] = 1 });
        Assert.True(s.Paused);
        Apply(s, new JsonObject { [Id(XPlaneDatarefs.Paused).ToString()] = 0, [Id(XPlaneDatarefs.SimSpeed).ToString()] = 0 });
        Assert.True(s.Paused);
        Assert.Equal(1, Map(s).SimRate);
        Apply(s, new JsonObject { [Id(XPlaneDatarefs.SimSpeed).ToString()] = 4 });
        Assert.False(s.Paused);
        Assert.Equal(4, Map(s).SimRate);
    }

    [Fact]
    public void Touchdown_rate_is_the_last_airborne_vertical_speed()
    {
        var s = new XPlaneState();
        var parked = Parked();
        parked[Id(XPlaneDatarefs.OnGround).ToString()] = 0;
        parked[Id(XPlaneDatarefs.Vs).ToString()] = -700.0;
        Apply(s, parked);
        Assert.Equal(0, Map(s).TouchdownFpm); // no touchdown yet
        Apply(s, new JsonObject { [Id(XPlaneDatarefs.Vs).ToString()] = -182.4 });
        // The update that lands already has a smaller rate: the one before counts.
        Apply(s, new JsonObject { [Id(XPlaneDatarefs.OnGround).ToString()] = 1, [Id(XPlaneDatarefs.Vs).ToString()] = -20.0 });
        Assert.Equal(182, Map(s).TouchdownFpm);
        Apply(s, new JsonObject { [Id(XPlaneDatarefs.Vs).ToString()] = 0.0 });
        Assert.Equal(182, Map(s).TouchdownFpm); // kept until the next touchdown

        // A bounce: airborne again, lands at 90 fpm.
        Apply(s, new JsonObject { [Id(XPlaneDatarefs.OnGround).ToString()] = 0, [Id(XPlaneDatarefs.Vs).ToString()] = -90.0 });
        Apply(s, new JsonObject { [Id(XPlaneDatarefs.OnGround).ToString()] = 1 });
        Assert.Equal(90, Map(s).TouchdownFpm);
    }

    [Fact]
    public void Starting_on_the_ground_is_not_a_touchdown()
    {
        var s = new XPlaneState();
        Apply(s, Parked());
        Apply(s, new JsonObject { [Id(XPlaneDatarefs.OnGround).ToString()] = 1 });
        Assert.Equal(0, Map(s).TouchdownFpm);
    }

    [Fact]
    public void Subscribe_frame_lists_ids_and_indices()
    {
        var ids = new Dictionary<long, DatarefSpec>
        {
            [7] = new(XPlaneDatarefs.Doors, [0, 1, 2, 3]),
            [3] = new(XPlaneDatarefs.Lat, Required: true),
        };
        var o = JsonNode.Parse(XPlaneSource.Subscribe(ids))!;
        Assert.Equal("dataref_subscribe_values", (string)o["type"]!);
        Assert.Equal("""[{"id":3},{"id":7,"index":[0,1,2,3]}]""", o["params"]!["datarefs"]!.ToJsonString());
    }
}

/// <summary>A fake X-Plane Web API on a free loopback port: capabilities, dataref look-up and the WebSocket.</summary>
internal sealed class FakeXPlane : IAsyncDisposable
{
    private readonly WebApplication _app;
    public int Port { get; } = Repo.FreePort();
    /// <summary>False: no flight loaded, every look-up is 404.</summary>
    public volatile bool FlightLoaded = true;
    public volatile bool Forbidden;
    public ConcurrentQueue<string> Received { get; } = new();
    /// <summary>Updates to send after the subscription result, in order.</summary>
    public List<JsonObject> Updates { get; } = [];
    public int Lookups;

    public FakeXPlane()
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.ConfigureKestrel(o => o.Listen(IPAddress.Loopback, Port));
        _app = builder.Build();
        _app.UseWebSockets();
        _app.Use(async (ctx, next) =>
        {
            if (Forbidden)
            {
                ctx.Response.StatusCode = 403;
                return;
            }
            await next();
        });
        _app.MapGet("/api/capabilities", () => Results.Json(new { api = new { versions = new[] { "v1", "v2" } }, x_plane = new { version = "12.1.4" } }));
        _app.MapGet("/api/v2/datarefs", (HttpContext ctx) =>
        {
            Interlocked.Increment(ref Lookups);
            var name = ctx.Request.Query["filter[name]"].ToString();
            var hit = XPlaneStateTests.Names.Where(p => p.Value == name).ToList();
            if (!FlightLoaded || hit.Count == 0)
                return Results.Json(new { error_code = "invalid_dataref_name", error_message = $"Dataref {name} doesn't exist." }, statusCode: 404);
            return Results.Json(new { data = new[] { new { id = hit[0].Key, name, value_type = "float" } } });
        });
        _app.Map("/api/v2", async ctx =>
        {
            if (!ctx.WebSockets.IsWebSocketRequest)
            {
                ctx.Response.StatusCode = 400;
                return;
            }
            using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
            var buf = new byte[65536];
            var r = await ws.ReceiveAsync(buf, ctx.RequestAborted);
            var sub = Encoding.UTF8.GetString(buf, 0, r.Count);
            Received.Enqueue(sub);
            var reqId = (int)JsonNode.Parse(sub)!["req_id"]!;
            await Send(ws, new JsonObject { ["req_id"] = reqId, ["type"] = "result", ["success"] = true });
            foreach (var u in Updates) await Send(ws, new JsonObject { ["type"] = "dataref_update_values", ["data"] = u.DeepClone() });
            try
            {
                while (!ctx.RequestAborted.IsCancellationRequested)
                {
                    var m = await ws.ReceiveAsync(buf, ctx.RequestAborted);
                    if (m.MessageType == WebSocketMessageType.Close) break;
                }
            }
            catch (Exception e) when (e is OperationCanceledException or WebSocketException)
            {
            }
        });
    }

    private static Task Send(WebSocket ws, JsonNode o) =>
        ws.SendAsync(Encoding.UTF8.GetBytes(o.ToJsonString()), WebSocketMessageType.Text, true, CancellationToken.None);

    public Task StartAsync() => _app.StartAsync();

    public async ValueTask DisposeAsync()
    {
        await _app.StopAsync();
        await _app.DisposeAsync();
    }
}

public class XPlaneSourceTests
{
    private sealed class SyncSink : ISimSink
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

    private static async Task Until(Func<bool> done, int ms = 10_000)
    {
        var until = DateTime.UtcNow.AddMilliseconds(ms);
        while (!done())
        {
            if (DateTime.UtcNow > until) throw new TimeoutException("condition not met");
            await Task.Delay(20);
        }
    }

    [Fact]
    public async Task Streams_telemetry_from_the_web_api()
    {
        await using var xp = new FakeXPlane();
        xp.Updates.Add(XPlaneStateTests.Parked());
        await xp.StartAsync();

        var source = new XPlaneSource(TimeProvider.System, xp.Port, host: "127.0.0.1");
        var sink = new SyncSink();
        using var cts = new CancellationTokenSource();
        var run = source.RunAsync(sink, cts.Token);

        await Until(() => sink.Telemetry.Length > 0);
        var t = sink.Telemetry[0];
        Assert.Equal(50.0379, t.Lat);
        Assert.Equal("Airbus A320neo (A20N)", t.AircraftTitle);
        Assert.Contains(sink.Statuses, s => s is { Sim: SimLink.Connected, Running: true });
        Assert.True((await source.ExecuteAsync(new SimCommand("p", "ping", new Dictionary<string, JsonValue>()), default)).Ok);

        var sub = JsonNode.Parse(xp.Received.Single())!;
        Assert.Equal("dataref_subscribe_values", (string)sub["type"]!);
        Assert.Equal(XPlaneDatarefs.All.Count, sub["params"]!["datarefs"]!.AsArray().Count);

        cts.Cancel();
        await run;
        Assert.Equal("stopped", sink.Statuses[^1].Detail);
        Assert.False((await source.ExecuteAsync(new SimCommand("p", "ping", new Dictionary<string, JsonValue>()), default)).Ok);
    }

    [Fact]
    public async Task Waits_for_a_flight_then_streams()
    {
        await using var xp = new FakeXPlane { FlightLoaded = false };
        xp.Updates.Add(XPlaneStateTests.Parked());
        await xp.StartAsync();

        var source = new XPlaneSource(TimeProvider.System, xp.Port, host: "127.0.0.1") { FlightPollInterval = TimeSpan.FromMilliseconds(50) };
        var sink = new SyncSink();
        using var cts = new CancellationTokenSource();
        var run = source.RunAsync(sink, cts.Token);

        await Until(() => sink.Statuses.Any(s => s.Detail?.StartsWith("waiting for a flight", StringComparison.Ordinal) == true));
        var waiting = sink.Statuses.Last(s => s.Detail is not null);
        Assert.Equal(SimLink.Connected, waiting.Sim);
        Assert.False(waiting.Running);
        Assert.Empty(sink.Telemetry);

        xp.FlightLoaded = true;
        await Until(() => sink.Telemetry.Length > 0);
        cts.Cancel();
        await run;
    }

    [Fact]
    public async Task No_sim_and_forbidden_end_the_session_with_a_reason()
    {
        var policy = new ReconnectPolicy(TimeSpan.FromMilliseconds(10), TimeSpan.FromMilliseconds(10));
        var sink = new SyncSink();
        using (var cts = new CancellationTokenSource())
        {
            var run = new XPlaneSource(TimeProvider.System, Repo.FreePort(), policy, "127.0.0.1").RunAsync(sink, cts.Token);
            await Until(() => sink.Statuses.Any(s => s.RetryInMs is not null));
            cts.Cancel();
            await run;
        }
        Assert.Contains("no web API on port", sink.Statuses.First(s => s.RetryInMs is not null).Detail);

        await using var xp = new FakeXPlane { Forbidden = true };
        await xp.StartAsync();
        var sink2 = new SyncSink();
        using var cts2 = new CancellationTokenSource();
        var run2 = new XPlaneSource(TimeProvider.System, xp.Port, policy, "127.0.0.1").RunAsync(sink2, cts2.Token);
        await Until(() => sink2.Statuses.Any(s => s.RetryInMs is not null));
        cts2.Cancel();
        await run2;
        Assert.Contains("allow incoming traffic", sink2.Statuses.First(s => s.RetryInMs is not null).Detail);
    }
}
