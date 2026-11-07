// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

using System.Text.Json.Nodes;
using AcarsBridge;

namespace AcarsBridge.Tests;

/// <summary>T98: GSX Pro service states read as LVars through the telemetry definition.</summary>
public class GsxTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.FromUnixTimeMilliseconds(1791374400000);

    [Fact]
    public void Gsx_lvars_are_requested_after_the_fenix_lever()
    {
        Assert.Equal(new SimVarDef("L:FSDT_GSX_BOARDING_STATE", "number"), SimVars.Definitions[SimVars.GsxBoarding]);
        Assert.Equal(new SimVarDef("L:FSDT_GSX_DEBOARDING_STATE", "number"), SimVars.Definitions[SimVars.GsxDeboarding]);
        Assert.Equal(new SimVarDef("L:FSDT_GSX_REFUELING_STATE", "number"), SimVars.Definitions[SimVars.GsxRefuel]);
        Assert.Equal(new SimVarDef("L:FSDT_GSX_CATERING_STATE", "number"), SimVars.Definitions[SimVars.GsxCatering]);
        Assert.Equal(new SimVarDef("L:FSDT_GSX_DEPARTURE_STATE", "number"), SimVars.Definitions[SimVars.GsxDeparture]);
        Assert.Equal(new SimVarDef("L:FSDT_GSX_BOARDING_CARGO", "number"), SimVars.Definitions[SimVars.GsxCargo]);
        Assert.Equal(SimVars.Count, SimVars.GsxCargo + 1);
    }

    [Fact]
    public void Gsx_states_map_to_ground_and_go_on_the_wire()
    {
        var f = Frames.Sample()
            .With(SimVars.GsxBoarding, 5)
            .With(SimVars.GsxDeboarding, 1)
            .With(SimVars.GsxRefuel, 6)
            .With(SimVars.GsxCatering, 3)
            .With(SimVars.GsxDeparture, 1)
            .With(SimVars.GsxCargo, 1);
        var t = TelemetryMapper.Map(f, false, Now);
        Assert.Equal(new GroundServices { Boarding = 5, Deboarding = 1, Refuel = 6, Catering = 3, Departure = 1, Cargo = true }, t.Ground);
        var ground = JsonNode.Parse(Protocol.Telemetry(t))!["data"]!["ground"]!;
        Assert.Equal("""{"boarding":5,"deboarding":1,"refuel":6,"catering":3,"departure":1,"cargo":true}""", ground.ToJsonString());
    }

    [Fact]
    public void Without_gsx_there_is_no_ground_field()
    {
        // Every GSX LVar 0: GSX not running (an LVar nobody set reads 0); X-Plane frames likewise.
        var t = TelemetryMapper.Map(Frames.Sample(), false, Now);
        Assert.Null(t.Ground);
        Assert.Null(JsonNode.Parse(Protocol.Telemetry(t))!["data"]!["ground"]);
        Assert.Null(TelemetryMapper.Map(new XPlaneState().Frame(), false, Now).Ground);
    }

    [Fact]
    public void Out_of_range_values_are_clamped_to_the_documented_states()
    {
        var f = Frames.Sample().With(SimVars.GsxBoarding, 9).With(SimVars.GsxRefuel, double.NaN).With(SimVars.GsxCatering, 4);
        var g = TelemetryMapper.Map(f, false, Now).Ground;
        Assert.Equal(6, g?.Boarding);
        Assert.Equal(0, g?.Refuel);
        Assert.Equal(4, g?.Catering);
    }

    [Fact]
    public void Gsx_values_come_through_the_simconnect_frame_bytes()
    {
        // The stub SimConnect hands the definition back as FLOAT64 × Count + TITLE (SimConnectTests).
        var f = Frames.Sample().With(SimVars.GsxBoarding, 6).With(SimVars.GsxRefuel, 5);
        var bytes = new byte[SimVars.Count * sizeof(double) + 256];
        Buffer.BlockCopy(f.Values, 0, bytes, 0, SimVars.Count * sizeof(double));
        System.Text.Encoding.UTF8.GetBytes("FenixA320_DLH").CopyTo(bytes, SimVars.Count * sizeof(double));
        var (values, title) = new SimObjectData(1, 1, bytes).ReadFrame(SimVars.Count);
        var g = TelemetryMapper.Map(new SimFrame(values, title), false, Now).Ground;
        Assert.Equal(6, g?.Boarding);
        Assert.Equal(5, g?.Refuel);
    }
}
