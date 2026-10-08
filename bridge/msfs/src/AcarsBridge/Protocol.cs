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
/// WebSocket protocol, bridge → app only (v1 defines no client → bridge messages; they are ignored).
/// Every frame is one JSON object with a <c>type</c>:
/// <list type="bullet">
/// <item><c>{"type":"hello","protocol":1,"telemetryVersion":1,"bridge":"acars-msfs-bridge","version":"…","source":"simconnect|fake"}</c> — first frame.</item>
/// <item><c>{"type":"status","sim":"disconnected|connecting|connected","running":…,"paused":…,"simRate":…,"detail"?:…,"retryInMs"?:…}</c></item>
/// <item><c>{"type":"telemetry","data":TelemetrySnapshot}</c> — ~1 Hz while connected and running.</item>
/// </list>
/// Incompatible changes bump <see cref="ProtocolVersion"/>.
/// </summary>
public static class Protocol
{
    public const int ProtocolVersion = 1;
    public const string BridgeName = "acars-msfs-bridge";

    public static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    public static string Hello(string version, string source) =>
        JsonSerializer.Serialize(
            new
            {
                type = "hello",
                protocol = ProtocolVersion,
                telemetryVersion = TelemetrySnapshot.Version,
                bridge = BridgeName,
                version,
                source,
            },
            Json);

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
