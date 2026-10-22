using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace AcarsBridge;

/// <summary>
/// X-Plane 12 via its built-in Web API (T18; developer.x-plane.com/article/x-plane-web-api, checked 2026-10-22):
/// REST and WebSocket on <c>http://localhost:8086</c> (port: X-Plane's <c>--web_server_port</c>), local connections
/// only, WebSocket since v1 (X-Plane 12.1.1).
/// <list type="number">
/// <item><c>GET /api/capabilities</c> (not versioned) → the highest API version both sides know; v1 if it is missing.</item>
/// <item><c>GET /api/vN/datarefs?filter[name]=…</c> per dataref → id (ids may change between sim sessions, so
///   they are looked up for every connection). No datarefs exist until the first flight is loaded: while a
///   required one is missing the bridge reports <c>connected</c>, not running, and looks again every
///   <see cref="FlightPoll"/>. Missing optional ones read as 0.</item>
/// <item><c>ws://localhost:port/api/vN</c>, <c>dataref_subscribe_values</c>; updates come at ~10 Hz, the first
///   with every value, later ones with the changed values only (<see cref="XPlaneState"/>).</item>
/// </list>
/// "Running" = the datarefs are there and subscribed (approved 2026-10-22: X-Plane has no "in a menu" signal).
/// A 403 means "Disable Incoming Traffic" in Settings > Network. Commands: <c>ping</c> only.
/// </summary>
public sealed class XPlaneSource(TimeProvider clock, int port = XPlaneSource.DefaultPort, ReconnectPolicy? policy = null, string host = "localhost")
    : ISimSource, ICommandTarget
{
    public const int DefaultPort = 8086;
    /// <summary>API versions this source can speak, newest first. All of them have what is used here (v1 subset).</summary>
    public static readonly string[] Versions = ["v3", "v2", "v1"];

    public static readonly TimeSpan FlightPoll = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan TickEvery = TimeSpan.FromMilliseconds(250);
    private static readonly TimeSpan HttpTimeout = TimeSpan.FromSeconds(5);

    private readonly ReconnectPolicy _policy = policy ?? new ReconnectPolicy();
    private readonly Uri _base = new($"http://{host}:{port}/");
    private volatile bool _open;

    /// <summary>How long to wait between flight look-ups (tests make it short).</summary>
    public TimeSpan FlightPollInterval { get; init; } = FlightPoll;

    public string Name => "xplane";

    public IReadOnlyCollection<string> Commands { get; } = ["ping"];

    public Task<CommandResult> ExecuteAsync(SimCommand command, CancellationToken ct) =>
        Task.FromResult(command.Name == "ping"
            ? _open ? CommandResult.Success : CommandResult.Fail(CommandErrors.Unavailable, "sim not connected")
            : CommandResult.Fail(CommandErrors.UnknownCommand, command.Name));

    public async Task RunAsync(ISimSink sink, CancellationToken ct)
    {
        using var http = new HttpClient { BaseAddress = _base, Timeout = HttpTimeout };
        http.DefaultRequestHeaders.Accept.ParseAdd("application/json");
        while (!ct.IsCancellationRequested)
        {
            sink.OnStatus(BridgeStatus.Initial with { Sim = SimLink.Connecting });
            string reason;
            try
            {
                reason = await RunSessionAsync(http, sink, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception e) when (e is HttpRequestException or WebSocketException or TaskCanceledException or JsonException or XPlaneApiException)
            {
                reason = Describe(e);
            }
            finally
            {
                _open = false;
            }
            if (ct.IsCancellationRequested) break;

            var delay = _policy.NextDelay();
            sink.OnStatus(BridgeStatus.Initial with { Detail = reason, RetryInMs = (int)delay.TotalMilliseconds });
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

    private string Describe(Exception e) => e switch
    {
        XPlaneApiException x => x.Message,
        HttpRequestException { StatusCode: null } or WebSocketException { WebSocketErrorCode: WebSocketError.Faulted } =>
            $"x-plane: no web API on port {port} (is X-Plane 12.1.1 or later running?)",
        TaskCanceledException => "x-plane: request timed out",
        _ => $"x-plane: {e.Message}",
    };

    /// <returns>Why the session ended.</returns>
    private async Task<string> RunSessionAsync(HttpClient http, ISimSink sink, CancellationToken ct)
    {
        var version = await NegotiateAsync(http, ct);
        Dictionary<long, DatarefSpec> ids;
        while (true)
        {
            (ids, var missing) = await LookUpAsync(http, version, ct);
            if (missing is null) break;
            sink.OnStatus(new BridgeStatus(SimLink.Connected, false, false, 1, Detail: $"waiting for a flight in X-Plane ({missing})"));
            await Task.Delay(FlightPollInterval, clock, ct);
        }

        using var ws = new ClientWebSocket();
        await ws.ConnectAsync(new Uri($"ws://{_base.Authority}/api/{version}"), ct);
        await SendAsync(ws, Subscribe(ids), ct);

        var names = ids.ToDictionary(p => p.Key, p => p.Value.Name);
        var state = new XPlaneState();
        var pump = new SnapshotPump(clock, sink.OnTelemetry);
        var gate = new object();
        var subscribed = false;

        void Publish() => sink.OnStatus(new BridgeStatus(SimLink.Connected, pump.Running, pump.Paused, pump.SimRate));

        using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var ticker = Task.Run(async () =>
        {
            using var timer = new PeriodicTimer(TickEvery, clock);
            try
            {
                while (await timer.WaitForNextTickAsync(stop.Token))
                    lock (gate) pump.Tick();
            }
            catch (OperationCanceledException)
            {
            }
        }, CancellationToken.None);

        try
        {
            while (true)
            {
                var text = await ReceiveAsync(ws, ct);
                if (text is null) return "x-plane closed the connection";
                if (text.Length == 0) continue; // a binary frame: not part of the API
                using var doc = JsonDocument.Parse(text);
                var root = doc.RootElement;
                var type = root.TryGetProperty("type", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
                switch (type)
                {
                    case "result" when root.TryGetProperty("success", out var ok) && ok.ValueKind == JsonValueKind.False:
                        return $"x-plane refused the subscription: {ErrorText(root)}";
                    case "result":
                        if (subscribed) break;
                        subscribed = true;
                        _open = true;
                        _policy.Reset();
                        lock (gate) pump.OnSimRunning(true);
                        Publish();
                        break;
                    case "dataref_update_values" when root.TryGetProperty("data", out var data):
                        bool changed;
                        lock (gate)
                        {
                            state.Apply(data, names);
                            changed = pump.OnPauseFlags(state.Paused ? 1u : 0u);
                            pump.OnFrame(state.Frame());
                        }
                        if (changed) Publish();
                        break;
                }
            }
        }
        finally
        {
            stop.Cancel();
            await ticker;
            if (ws.State == WebSocketState.Open)
            {
                try
                {
                    await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(1));
                }
                catch (Exception e) when (e is WebSocketException or TimeoutException or OperationCanceledException)
                {
                }
            }
        }
    }

    /// <summary>The newest version in <see cref="Versions"/> that X-Plane lists; v1 when it has no capabilities endpoint (404).</summary>
    private static async Task<string> NegotiateAsync(HttpClient http, CancellationToken ct)
    {
        using var res = await http.GetAsync("api/capabilities", ct);
        if (res.StatusCode == HttpStatusCode.NotFound) return "v1";
        await EnsureOk(res, ct);
        var node = JsonNode.Parse(await res.Content.ReadAsStringAsync(ct));
        var api = node?["api"] ?? node?["data"]?["api"];
        var listed = (api?["versions"] as JsonArray)?.Select(v => v?.GetValueKind() == JsonValueKind.String ? (string)v! : null).ToHashSet() ?? [];
        return Versions.FirstOrDefault(listed.Contains) ?? "v1";
    }

    /// <returns>Ids of the datarefs found; <c>missing</c> = a required one that is not there (no flight loaded), else null.</returns>
    private static async Task<(Dictionary<long, DatarefSpec> Ids, string? Missing)> LookUpAsync(HttpClient http, string version, CancellationToken ct)
    {
        var ids = new Dictionary<long, DatarefSpec>();
        foreach (var spec in XPlaneDatarefs.All)
        {
            using var res = await http.GetAsync($"api/{version}/datarefs?filter[name]={Uri.EscapeDataString(spec.Name)}", ct);
            if (res.StatusCode == HttpStatusCode.NotFound)
            {
                if (spec.Required) return (ids, spec.Name);
                continue;
            }
            await EnsureOk(res, ct);
            var item = (JsonNode.Parse(await res.Content.ReadAsStringAsync(ct))?["data"] as JsonArray)?.FirstOrDefault();
            if (item?["id"] is JsonValue idv && idv.TryGetValue<long>(out var id) && id > 0) ids[id] = spec;
            else if (spec.Required) return (ids, spec.Name);
        }
        return (ids, null);
    }

    private static async Task EnsureOk(HttpResponseMessage res, CancellationToken ct)
    {
        if (res.IsSuccessStatusCode) return;
        if (res.StatusCode == HttpStatusCode.Forbidden)
            throw new XPlaneApiException("x-plane: web API forbidden (Settings > Network: allow incoming traffic)");
        var body = await res.Content.ReadAsStringAsync(ct);
        string detail;
        try
        {
            using var doc = JsonDocument.Parse(body);
            detail = ErrorText(doc.RootElement);
        }
        catch (JsonException)
        {
            detail = ((int)res.StatusCode).ToString(System.Globalization.CultureInfo.InvariantCulture);
        }
        throw new XPlaneApiException($"x-plane: {detail}");
    }

    private static string ErrorText(JsonElement e) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty("error_message", out var m) && m.ValueKind == JsonValueKind.String
            ? m.GetString()!
            : e.ValueKind == JsonValueKind.Object && e.TryGetProperty("error_code", out var c) ? c.ToString() : "error";

    /// <summary><c>{"req_id":1,"type":"dataref_subscribe_values","params":{"datarefs":[{"id":…,"index"?:[…]},…]}}</c></summary>
    public static string Subscribe(IReadOnlyDictionary<long, DatarefSpec> ids)
    {
        var list = new JsonArray();
        foreach (var (id, spec) in ids.OrderBy(p => p.Key))
        {
            var o = new JsonObject { ["id"] = id };
            if (spec.Index is not null) o["index"] = new JsonArray([.. spec.Index.Select(i => (JsonNode)i)]);
            list.Add(o);
        }
        return new JsonObject
        {
            ["req_id"] = 1,
            ["type"] = "dataref_subscribe_values",
            ["params"] = new JsonObject { ["datarefs"] = list },
        }.ToJsonString();
    }

    private static Task SendAsync(ClientWebSocket ws, string text, CancellationToken ct) =>
        ws.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, ct);

    /// <summary>One whole text message; null when the server closes.</summary>
    private static async Task<string?> ReceiveAsync(ClientWebSocket ws, CancellationToken ct)
    {
        var buffer = new byte[8192];
        using var message = new MemoryStream();
        while (true)
        {
            var r = await ws.ReceiveAsync(buffer, ct);
            if (r.MessageType == WebSocketMessageType.Close) return null;
            message.Write(buffer, 0, r.Count);
            if (message.Length > 1 << 20) throw new XPlaneApiException("x-plane: message over 1 MB");
            if (r.EndOfMessage) return r.MessageType == WebSocketMessageType.Text ? Encoding.UTF8.GetString(message.ToArray()) : "";
        }
    }
}

/// <summary>An answer of the X-Plane Web API that ends the session; the message goes to <c>status.detail</c>.</summary>
public sealed class XPlaneApiException(string message) : Exception(message);
