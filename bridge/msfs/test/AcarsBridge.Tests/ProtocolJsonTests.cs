// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

using AcarsBridge;
using Xunit;

namespace AcarsBridge.Tests;

/// <summary>
/// T82: frames are serialized by the source-generated <c>BridgeJson</c> (the published bridge is trimmed).
/// The exact text — key order, camelCase, enum names, nulls left out — is what the reflection-based
/// serializer of anonymous objects wrote before.
/// </summary>
public class ProtocolJsonTests
{
    [Fact]
    public void Hello_v1_and_v2()
    {
        Assert.Equal(
            """{"type":"hello","protocol":1,"telemetryVersion":1,"bridge":"acars-msfs-bridge","version":"0.1.0","source":"fake"}""",
            Protocol.Hello("0.1.0", "fake", 1, ["ping"]));
        Assert.Equal(
            """{"type":"hello","protocol":2,"telemetryVersion":1,"bridge":"acars-msfs-bridge","version":"0.1.0","source":"auto","commands":["ping","smoke_start"]}""",
            Protocol.Hello("0.1.0", "auto", 2, ["ping", "smoke_start"]));
        Assert.EndsWith("""
            "commands":[]}
            """, Protocol.Hello("0.1.0", "auto", 2));
    }

    [Fact]
    public void Status_leaves_out_nulls_and_names_the_link_in_camel_case()
    {
        Assert.Equal(
            """{"type":"status","sim":"disconnected","running":false,"paused":false,"simRate":1}""",
            Protocol.Status(BridgeStatus.Initial));
        Assert.Equal(
            """{"type":"status","sim":"connected","running":true,"paused":false,"simRate":2.5,"detail":"x","retryInMs":500,"source":"xplane"}""",
            Protocol.Status(new BridgeStatus(SimLink.Connected, true, false, 2.5, "x", 500, "xplane")));
        Assert.Contains("\"sim\":\"connecting\"", Protocol.Status(BridgeStatus.Initial with { Sim = SimLink.Connecting }));
    }

    [Fact]
    public void Telemetry_wraps_the_snapshot_and_leaves_out_a_missing_sim_clock()
    {
        var frame = Protocol.Telemetry(new TelemetrySnapshot { T = 5, EngRunning = [true], AircraftTitle = "A320" });
        Assert.StartsWith("""{"type":"telemetry","data":{"v":1,"t":5,"lat":0,""", frame);
        Assert.Contains("\"engRunning\":[true]", frame);
        Assert.Contains("\"aircraftTitle\":\"A320\"", frame);
        Assert.DoesNotContain("simUtcMs", frame);
        Assert.Contains("\"simUtcMs\":7", Protocol.Telemetry(new TelemetrySnapshot { SimUtcMs = 7 }));
    }
}
