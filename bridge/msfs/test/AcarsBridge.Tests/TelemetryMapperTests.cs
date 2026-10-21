using System.Text.Json;
using System.Text.Json.Nodes;
using AcarsBridge;

namespace AcarsBridge.Tests;

public class TelemetryMapperTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.FromUnixTimeMilliseconds(1791374400000);

    [Fact]
    public void Definitions_match_frame_layout()
    {
        Assert.Equal(SimVars.Count, SimVars.Definitions.Count);
        Assert.Equal(SimVars.Count, SimVars.Definitions.Select(d => d.Name).Distinct().Count());
        Assert.Equal("PLANE LATITUDE", SimVars.Definitions[SimVars.Lat].Name);
        Assert.Equal("NUMBER OF ENGINES", SimVars.Definitions[SimVars.EngineCount].Name);
        Assert.Equal("GENERAL ENG COMBUSTION:1", SimVars.Definitions[SimVars.Combustion1].Name);
        Assert.Equal("TURB ENG N2:4", SimVars.Definitions[SimVars.N2First + 3].Name);
        Assert.Equal(new SimVarDef("FUEL TOTAL QUANTITY WEIGHT", "kilograms"), SimVars.Definitions[SimVars.Fuel]);
        Assert.Equal("EXIT OPEN:0", SimVars.Definitions[SimVars.ExitFirst].Name);
        Assert.Equal("TRANSPONDER STATE:1", SimVars.Definitions[SimVars.Xpdr].Name);
        Assert.Equal("SIMULATION RATE", SimVars.Definitions[SimVars.SimRate].Name);
        Assert.Equal(new SimVarDef("PLANE TOUCHDOWN NORMAL VELOCITY", "feet per second"), SimVars.Definitions[SimVars.Touchdown]);
    }

    [Fact]
    public void Sample_frame_maps_to_reference_sample()
    {
        var json = Protocol.Telemetry(TelemetryMapper.Map(Frames.Sample(), paused: false, Now));
        var actual = JsonNode.Parse(json)!["data"]!;
        var expected = JsonNode.Parse(File.ReadAllText(Repo.File("reference/telemetry.sample.json")))!;
        Assert.True(JsonNode.DeepEquals(expected, actual), $"expected {expected.ToJsonString()}\nactual   {actual.ToJsonString()}");
    }

    [Fact]
    public void Wire_keys_match_ts_snapshot_keys()
    {
        // simUtcMs is optional on the wire (omitted when null), so a default snapshot lacks it.
        var expected = JsonNode.Parse(File.ReadAllText(Repo.File("reference/telemetry.sample.json")))!.AsObject()
            .Select(p => p.Key).Where(k => k != "simUtcMs").Order();
        var actual = JsonNode.Parse(JsonSerializer.Serialize(new TelemetrySnapshot(), Protocol.Json))!.AsObject()
            .Select(p => p.Key).Order();
        Assert.Equal(expected, actual);
    }

    [Fact]
    public void Sim_utc_comes_from_absolute_time_and_is_omitted_without_a_date()
    {
        Assert.Equal("ABSOLUTE TIME", SimVars.Definitions[SimVars.AbsTime].Name);
        Assert.Equal(1791374400000, TelemetryMapper.Map(Frames.Sample(), false, Now).SimUtcMs);
        Assert.Null(TelemetryMapper.Map(Frames.Sample().With(SimVars.AbsTime, 0), false, Now).SimUtcMs);
    }

    [Fact]
    public void Engine_arrays_follow_number_of_engines()
    {
        var f = Frames.Sample()
            .With(SimVars.EngineCount, 4)
            .With(SimVars.Combustion1 + 2, 1)
            .With(SimVars.N2First + 2, 61.27);
        var s = TelemetryMapper.Map(f, false, Now);
        Assert.Equal([false, false, true, false], s.EngRunning);
        Assert.Equal([0, 0, 61.3, 0], s.EngN2);

        var none = TelemetryMapper.Map(Frames.Sample().With(SimVars.EngineCount, 0), false, Now);
        Assert.Empty(none.EngRunning);
        Assert.Empty(none.EngN2);
    }

    [Theory]
    [InlineData(359.96, 0)]
    [InlineData(360.0, 0)]
    [InlineData(-10.0, 350)]
    [InlineData(725.25, 5.3)]
    public void Heading_is_normalized(double raw, double expected)
    {
        Assert.Equal(expected, TelemetryMapper.Map(Frames.Sample().With(SimVars.Hdg, raw), false, Now).HdgTrue);
    }

    [Fact]
    public void Gear_flags_doors_xpdr_simrate_paused()
    {
        var f = Frames.Sample()
            .With(SimVars.Gear, 0.4)
            .With(SimVars.Beacon, 1)
            .With(SimVars.ExitFirst + 1, 37.6)
            .With(SimVars.ExitFirst + 2, 140)
            .With(SimVars.Flaps, 3)
            .With(SimVars.Xpdr, 4)
            .With(SimVars.SimRate, 4);
        var s = TelemetryMapper.Map(f, paused: true, Now);
        Assert.False(s.GearDown);
        Assert.True(s.Beacon);
        Assert.Equal([100, 38, 100, 0], s.DoorsOpen);
        Assert.Equal(3, s.FlapsIdx);
        Assert.Equal(4, s.XpdrState);
        Assert.Equal(4, s.SimRate);
        Assert.True(s.Paused);
        Assert.Equal(Now.ToUnixTimeMilliseconds(), s.T);
    }

    [Fact]
    public void Garbage_numbers_become_zero_and_no_negative_zero()
    {
        var f = Frames.Sample().With(SimVars.Ias, double.NaN).With(SimVars.Vs, -0.2).With(SimVars.Fuel, -5);
        var s = TelemetryMapper.Map(f, false, Now);
        Assert.Equal(0, s.IasKt);
        Assert.Equal(0, s.FuelKg);
        Assert.DoesNotContain("-0", Protocol.Telemetry(s));
    }

    [Fact]
    public void Wrong_frame_length_throws()
    {
        Assert.Throws<ArgumentException>(() => TelemetryMapper.Map(new SimFrame([1, 2, 3], ""), false, Now));
    }
}
