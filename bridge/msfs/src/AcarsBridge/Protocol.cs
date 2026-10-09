using System.Text.Json;
using System.Text.Json.Serialization;

namespace AcarsBridge;

/// <summary>
/// TelemetrySnapshot v1 — mirrors packages/core/src/telemetry/types.ts and
/// docs/03-architecture.md. Property names are the wire names; keep them in sync with the TS type
/// (a test compares the key set with reference/telemetry.sample.json).
/// </summary>
public sealed record TelemetrySnapshot
{
    public const int Version = 1;

    [JsonPropertyName("v")] public int V { get; init; } = Version;
    /// <summary>Sample time, epoch ms UTC (bridge wall clock).</summary>
    [JsonPropertyName("t")] public long T { get; init; }
    [JsonPropertyName("lat")] public double Lat { get; init; }
    [JsonPropertyName("lon")] public double Lon { get; init; }
    [JsonPropertyName("altFt")] public double AltFt { get; init; }
    [JsonPropertyName("aglFt")] public double AglFt { get; init; }
    [JsonPropertyName("iasKt")] public double IasKt { get; init; }
    [JsonPropertyName("gsKt")] public double GsKt { get; init; }
    [JsonPropertyName("vsFpm")] public double VsFpm { get; init; }
    [JsonPropertyName("hdgTrue")] public double HdgTrue { get; init; }
    [JsonPropertyName("onGround")] public bool OnGround { get; init; }
    [JsonPropertyName("parkingBrake")] public bool ParkingBrake { get; init; }
    [JsonPropertyName("beacon")] public bool Beacon { get; init; }
    [JsonPropertyName("engRunning")] public bool[] EngRunning { get; init; } = [];
    [JsonPropertyName("engN2")] public double[] EngN2 { get; init; } = [];
    [JsonPropertyName("fuelKg")] public double FuelKg { get; init; }
    [JsonPropertyName("gearDown")] public bool GearDown { get; init; }
    [JsonPropertyName("flapsIdx")] public int FlapsIdx { get; init; }
    [JsonPropertyName("doorsOpen")] public double[] DoorsOpen { get; init; } = [];
    [JsonPropertyName("xpdrState")] public int XpdrState { get; init; }
    [JsonPropertyName("simRate")] public double SimRate { get; init; }
    [JsonPropertyName("paused")] public bool Paused { get; init; }
    [JsonPropertyName("aircraftTitle")] public string AircraftTitle { get; init; } = "";
}

/// <summary>Connection state of the bridge towards the simulator.</summary>
public enum SimLink
{
    /// <summary>Not connected; waiting before the next attempt.</summary>
    Disconnected,
    Connecting,
    Connected,
}

/// <summary>
/// Bridge → app status. Sent on connect and on every change.
/// <c>running</c> = SimConnect "Sim" event (false in menus / while a flight loads);
/// telemetry is only streamed while connected and running.
/// </summary>
public sealed record BridgeStatus(
    SimLink Sim,
    bool Running,
    bool Paused,
    double SimRate,
    string? Detail = null,
    int? RetryInMs = null)
{
    public static readonly BridgeStatus Initial = new(SimLink.Disconnected, false, false, 1);
}

/// <summary>
/// WebSocket protocol. Every frame is one JSON object with a <c>type</c>. The client picks the version
/// with the query <c>?protocol=2</c>; without it the bridge speaks v1, so v1 clients keep working.
/// Bridge → app (v1 and v2):
/// <list type="bullet">
/// <item><c>{"type":"hello","protocol":1|2,"telemetryVersion":1,"bridge":"acars-msfs-bridge","version":"…","source":"simconnect|fake"}</c> — first frame; v2 adds <c>"commands":["ping",…]</c>.</item>
/// <item><c>{"type":"status","sim":"disconnected|connecting|connected","running":…,"paused":…,"simRate":…,"detail"?:…,"retryInMs"?:…}</c></item>
/// <item><c>{"type":"telemetry","data":TelemetrySnapshot}</c> — ~1 Hz while connected and running.</item>
/// </list>
/// v2 only, app → bridge: <c>{"type":"command","id":"…","command":"ping","args"?:{…}}</c> (whitelist:
/// <see cref="CommandCatalog"/>); the bridge answers that client alone with
/// <c>{"type":"ack","id":"…"|null,"ok":true}</c> or <c>{"type":"ack","id":…,"ok":false,"error":"…","detail"?:"…"}</c>.
/// v1 clients' messages are ignored. Incompatible changes bump <see cref="ProtocolVersion"/>.
/// </summary>
public static class Protocol
{
    public const int ProtocolVersion = 2;
    /// <summary>Oldest version still served (to clients that do not ask for a newer one).</summary>
    public const int MinProtocolVersion = 1;
    public const string BridgeName = "acars-msfs-bridge";

    public static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    /// <summary>
    /// Version for a client from its <c>protocol</c> query value: the highest supported version not
    /// above the requested one; v1 when absent or not a number.
    /// </summary>
    public static int Negotiate(string? requested) =>
        int.TryParse(requested, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var v)
            ? Math.Clamp(v, MinProtocolVersion, ProtocolVersion)
            : MinProtocolVersion;

    public static string Hello(string version, string source, int protocol = MinProtocolVersion, IReadOnlyList<string>? commands = null) =>
        protocol < 2
            ? JsonSerializer.Serialize(
                new
                {
                    type = "hello",
                    protocol = 1,
                    telemetryVersion = TelemetrySnapshot.Version,
                    bridge = BridgeName,
                    version,
                    source,
                },
                Json)
            : JsonSerializer.Serialize(
                new
                {
                    type = "hello",
                    protocol,
                    telemetryVersion = TelemetrySnapshot.Version,
                    bridge = BridgeName,
                    version,
                    source,
                    commands = commands ?? [],
                },
                Json);

    /// <summary><c>id</c> is always present (null when the frame had no readable id); <c>detail</c> only when set.</summary>
    public static string Ack(string? id, CommandResult result)
    {
        var o = new System.Text.Json.Nodes.JsonObject { ["type"] = "ack", ["id"] = id, ["ok"] = result.Ok };
        if (!result.Ok) o["error"] = result.Error ?? CommandErrors.Failed;
        if (result.Detail is not null) o["detail"] = result.Detail;
        return o.ToJsonString();
    }

    public static string Status(BridgeStatus s) =>
        JsonSerializer.Serialize(
            new
            {
                type = "status",
                sim = s.Sim,
                running = s.Running,
                paused = s.Paused,
                simRate = s.SimRate,
                detail = s.Detail,
                retryInMs = s.RetryInMs,
            },
            Json);

    public static string Telemetry(TelemetrySnapshot snapshot) =>
        JsonSerializer.Serialize(new { type = "telemetry", data = snapshot }, Json);
}
