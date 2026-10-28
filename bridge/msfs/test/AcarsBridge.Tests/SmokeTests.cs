// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

using AcarsBridge;

namespace AcarsBridge.Tests;

public class SmokeControllerTests
{
    // Middle of a runway at RJBB.
    private const double Lat = 34.44, Lon = 135.22;

    private static SmokeController New(ManualClock? clock = null) =>
        new(clock ?? ManualClock.At(1_700_000_000_000));

    [Fact]
    public void The_first_object_of_a_session_is_created_again_once()
    {
        var clock = ManualClock.At(1_700_000_000_000);
        var c = New(clock);
        c.Start(Lat, Lon);
        Assert.Equal(SmokeAction.Spawn, c.OnPosition(Lat, Lon));
        clock.Advance(SmokeController.RespawnAfter - TimeSpan.FromSeconds(1));
        Assert.Equal(SmokeAction.None, c.OnPosition(Lat, Lon));
        clock.Advance(TimeSpan.FromSeconds(1));
        Assert.Equal(SmokeAction.Remove, c.OnPosition(Lat, Lon));
        Assert.Equal(SmokeAction.Spawn, c.OnPosition(Lat, Lon));
        clock.Advance(SmokeController.RespawnAfter * 4);
        Assert.Equal(SmokeAction.None, c.OnPosition(Lat, Lon)); // only once

        c.Start(Lat + 0.01, Lon); // a later object of the session: no second creation
        Assert.Equal(SmokeAction.Remove, c.OnPosition(Lat, Lon));
        Assert.Equal(SmokeAction.Spawn, c.OnPosition(Lat, Lon));
        clock.Advance(SmokeController.RespawnAfter * 4);
        Assert.Equal(SmokeAction.None, c.OnPosition(Lat, Lon));
    }

    [Fact]
    public void A_new_flight_or_session_creates_its_first_object_again()
    {
        var clock = ManualClock.At(1_700_000_000_000);
        var c = New(clock);
        c.Start(Lat, Lon);
        Assert.Equal(SmokeAction.Spawn, c.OnPosition(Lat, Lon));
        clock.Advance(SmokeController.RespawnAfter);
        Assert.Equal(SmokeAction.Remove, c.OnPosition(Lat, Lon));
        Assert.Equal(SmokeAction.Spawn, c.OnPosition(Lat, Lon));

        c.SimRunning(false); // back to the menu, a new flight loads
        c.SimRunning(true);
        clock.Advance(SmokeController.RespawnAfter);
        Assert.Equal(SmokeAction.Remove, c.OnPosition(Lat, Lon));
        Assert.Equal(SmokeAction.Spawn, c.OnPosition(Lat, Lon));

        c.SessionEnded();
        Assert.Equal(SmokeAction.Spawn, c.OnPosition(Lat, Lon));
        clock.Advance(SmokeController.RespawnAfter);
        Assert.Equal(SmokeAction.Remove, c.OnPosition(Lat, Lon));
    }

    [Fact]
    public void Spawns_only_when_the_aircraft_is_near_and_removes_with_hysteresis()
    {
        var c = New();
        Assert.Equal(SmokeAction.None, c.OnPosition(Lat, Lon));
        c.Start(Lat, Lon);
        Assert.Equal(SmokeAction.None, c.OnPosition(Lat + 2, Lon)); // 120 NM
        Assert.Equal(SmokeAction.Spawn, c.OnPosition(Lat + 0.6, Lon)); // 36 NM
        Assert.Equal(SmokeAction.None, c.OnPosition(Lat + 0.6, Lon));
        Assert.Equal(SmokeAction.None, c.OnPosition(Lat + 0.9, Lon)); // 54 NM: between the limits
        Assert.Equal(SmokeAction.Remove, c.OnPosition(Lat + 1.1, Lon)); // 66 NM
        Assert.Equal(SmokeAction.Spawn, c.OnPosition(Lat + 0.2, Lon)); // back again
    }

    [Fact]
    public void Stop_removes_a_spawned_object_once_and_forgets_an_unspawned_one()
    {
        var c = New();
        c.Start(Lat, Lon);
        Assert.Equal(SmokeAction.Spawn, c.OnPosition(Lat, Lon));
        c.Stop();
        Assert.False(c.Active);
        Assert.Equal(SmokeAction.Remove, c.OnPosition(Lat, Lon));
        Assert.Equal(SmokeAction.None, c.OnPosition(Lat, Lon));

        c.Start(Lat, Lon);
        c.Stop();
        Assert.Equal(SmokeAction.None, c.OnPosition(Lat, Lon));
    }

    [Fact]
    public void A_new_point_moves_a_spawned_object_and_the_same_point_keeps_it()
    {
        var c = New();
        c.Start(Lat, Lon);
        Assert.Equal(SmokeAction.Spawn, c.OnPosition(Lat, Lon));
        c.Start(Lat, Lon); // the same point again: nothing to do
        Assert.Equal(SmokeAction.None, c.OnPosition(Lat, Lon));
        c.Start(Lat + 0.01, Lon);
        Assert.Equal(SmokeAction.Remove, c.OnPosition(Lat, Lon));
        Assert.Equal(SmokeAction.Spawn, c.OnPosition(Lat, Lon));
        Assert.Equal((Lat + 0.01, Lon), c.Target);
    }

    [Fact]
    public void Expires_after_the_maximum_life()
    {
        var clock = ManualClock.At(1_700_000_000_000);
        var c = New(clock);
        c.Start(Lat, Lon);
        Assert.Equal(SmokeAction.Spawn, c.OnPosition(Lat, Lon));
        clock.Advance(SmokeController.MaxLife + TimeSpan.FromSeconds(1));
        Assert.Equal(SmokeAction.Remove, c.OnPosition(Lat, Lon));
        Assert.False(c.Active);
    }

    [Fact]
    public void A_new_session_spawns_again_for_a_standing_request()
    {
        var c = New();
        c.Start(Lat, Lon);
        Assert.Equal(SmokeAction.Spawn, c.OnPosition(Lat, Lon));
        c.SessionEnded();
        Assert.Equal(SmokeAction.Spawn, c.OnPosition(Lat, Lon));
    }

    [Fact]
    public void Distance_is_about_sixty_nm_per_degree_of_latitude()
    {
        Assert.InRange(SmokeController.DistanceNm(0, 0, 1, 0), 59.9, 60.2);
        Assert.Equal(0, SmokeController.DistanceNm(Lat, Lon, Lat, Lon), 6);
    }
}

public class SmokeCommandTests
{
    private static (SimCommand? Command, string? Id, CommandResult? Error) Parse(string command, string args) =>
        CommandCatalog.Parse($$"""{"type":"command","id":"s1","command":"{{command}}","args":{{args}}}""");

    [Fact]
    public void Smoke_commands_are_whitelisted()
    {
        Assert.Null(Parse("smoke_start", """{"lat":34.44,"lon":135.22}""").Error);
        Assert.Null(Parse("smoke_start", """{"lat":-90,"lon":-180}""").Error);
        Assert.Null(Parse("smoke_stop", "{}").Error);
        Assert.Contains("smoke_start", CommandCatalog.Names);
    }

    [Theory]
    [InlineData("smoke_start", "{}")]
    [InlineData("smoke_start", """{"lat":34.4}""")]
    [InlineData("smoke_start", """{"lat":91,"lon":0}""")]
    [InlineData("smoke_start", """{"lat":0,"lon":181}""")]
    [InlineData("smoke_start", """{"lat":"34","lon":135}""")]
    [InlineData("smoke_start", """{"lat":34,"lon":135,"alt":0}""")]
    [InlineData("smoke_stop", """{"x":1}""")]
    public void Bad_arguments_are_refused(string command, string args)
    {
        Assert.Equal(CommandErrors.BadArgs, Parse(command, args).Error?.Error);
    }
}
