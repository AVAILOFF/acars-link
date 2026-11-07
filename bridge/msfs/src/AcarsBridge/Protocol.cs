// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

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
    /// <summary>Descent rate at the last touchdown, ft/min (T46); 0 until the sim has one.</summary>
    [JsonPropertyName("touchdownFpm")] public double TouchdownFpm { get; init; }
    /// <summary>Sim clock (zulu), epoch ms UTC, from ABSOLUTE TIME; omitted when the sim gives none.</summary>
    [JsonPropertyName("simUtcMs")] public long? SimUtcMs { get; init; }
    /// <summary>GSX Pro service states (T98); omitted without GSX (X-Plane, GSX not running).</summary>
    [JsonPropertyName("ground")] public GroundServices? Ground { get; init; }
}

/// <summary>
/// GSX Pro services (T98), the raw L:FSDT_GSX_*_STATE values: 1 can be called, 2 not available,
/// 3 bypassed, 4 requested, 5 being performed, 6 completed (0 = not reported). See SimVars.
/// </summary>
public sealed record GroundServices
{
    [JsonPropertyName("boarding")] public int Boarding { get; init; }
    [JsonPropertyName("deboarding")] public int Deboarding { get; init; }
    [JsonPropertyName("refuel")] public int Refuel { get; init; }
    [JsonPropertyName("catering")] public int Catering { get; init; }
    [JsonPropertyName("departure")] public int Departure { get; init; }
    /// <summary>GSX is loading luggage/cargo (L:FSDT_GSX_BOARDING_CARGO).</summary>
    [JsonPropertyName("cargo")] public bool Cargo { get; init; }
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
/// telemetry is only streamed while connected and running. <c>Source</c> (T59): the connected sim
/// (<c>simconnect</c> / <c>xplane</c>), set on connected statuses by <see cref="SimLoop"/>.
/// </summary>
public sealed record BridgeStatus(
    SimLink Sim,
    bool Running,
    bool Paused,
    double SimRate,
    string? Detail = null,
    int? RetryInMs = null,
    string? Source = null)
{
    public static readonly BridgeStatus Initial = new(SimLink.Disconnected, false, false, 1);
}

/// <summary>
/// WebSocket protocol. Every frame is one JSON object with a <c>type</c>. The client picks the version
/// with the query <c>?protocol=2</c>; without it the bridge speaks v1, so v1 clients keep working.
/// Bridge → app (v1 and v2):
/// <list type="bullet">
/// <item><c>{"type":"hello","protocol":1|2,"telemetryVersion":1,"bridge":"acars-msfs-bridge","version":"…","source":"auto|simconnect|xplane|fake"}</c> — first frame; v2 adds <c>"commands":["ping",…]</c>.</item>
/// <item><c>{"type":"status","sim":"disconnected|connecting|connected","running":…,"paused":…,"simRate":…,"detail"?:…,"retryInMs"?:…,"source"?:"simconnect|xplane"}</c>
///   — <c>source</c> (T59, optional, no version bump) only while connected: which sim it is.</item>
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
                new HelloV1Frame("hello", 1, TelemetrySnapshot.Version, BridgeName, version, source),
                BridgeJson.Default.HelloV1Frame)
            : JsonSerializer.Serialize(
                new HelloFrame("hello", protocol, TelemetrySnapshot.Version, BridgeName, version, source, commands ?? []),
                BridgeJson.Default.HelloFrame);

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
            new StatusFrame("status", s.Sim, s.Running, s.Paused, s.SimRate, s.Detail, s.RetryInMs, s.Source),
            BridgeJson.Default.StatusFrame);

    public static string Telemetry(TelemetrySnapshot snapshot) =>
        JsonSerializer.Serialize(new TelemetryFrame("telemetry", snapshot), BridgeJson.Default.TelemetryFrame);
}

// Frames as types (not anonymous objects) for the JSON source generator; property order = wire order.
internal sealed record HelloV1Frame(string Type, int Protocol, int TelemetryVersion, string Bridge, string Version, string Source);
internal sealed record HelloFrame(
    string Type, int Protocol, int TelemetryVersion, string Bridge, string Version, string Source, IReadOnlyList<string> Commands);
internal sealed record StatusFrame(
    string Type, SimLink Sim, bool Running, bool Paused, double SimRate, string? Detail, int? RetryInMs, string? Source);
internal sealed record TelemetryFrame(string Type, TelemetrySnapshot Data);

/// <summary><see cref="SimLink"/> on the wire: <c>disconnected</c> / <c>connecting</c> / <c>connected</c>.</summary>
internal sealed class SimLinkJsonConverter() : JsonStringEnumConverter<SimLink>(JsonNamingPolicy.CamelCase);

/// <summary>
/// Source-generated serializers of every frame (T82): the published bridge is trimmed, and reflection-based
/// <see cref="JsonSerializer"/> calls would be trimming errors.
/// </summary>
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    Converters = [typeof(SimLinkJsonConverter)])]
[JsonSerializable(typeof(HelloV1Frame))]
[JsonSerializable(typeof(HelloFrame))]
[JsonSerializable(typeof(StatusFrame))]
[JsonSerializable(typeof(TelemetryFrame))]
[JsonSerializable(typeof(TelemetrySnapshot))]
internal sealed partial class BridgeJson : JsonSerializerContext;
