// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

using System.Text.Json.Nodes;
using AcarsBridge;

namespace AcarsBridge.Tests;

public class RescueControllerTests
{
    // Threshold of RWY 24L at EDDF-like coordinates, runway course 250°.
    private const double ThrLat = 50.04, ThrLon = 8.59, Hdg = 250;

    private static readonly string[] FourTrucks = ["ASO_Firetruck02", "Microsoft_Truck_Fire_Medium_Red", "ASO_Firetruck02", "Microsoft_Truck_Fire_Medium_Red"];

    /// <summary>On a runway of 410 m all trucks wait at 400 m: behind a touchdown at 500 m.</summary>
    private const double Short = 410;
    /// <summary>A runway of 810 m puts four trucks at 400, 470, 540 and 610 m.</summary>
    private const double Spaced = 810;

    private static RescueRequest Req(bool full = true, string[]? fire = null, string[]? medic = null, double thrLat = ThrLat, double lengthM = 3000, bool left = false, bool[]? flip = null, bool ground = false) =>
        new(full, thrLat, ThrLon, Hdg, lengthM, fire ?? FourTrucks, medic ?? [], left, flip, ground);

    private static (RescueController C, ManualClock Clock) New()
    {
        var clock = ManualClock.At(1_700_000_000_000);
        return (new RescueController(clock), clock);
    }

    /// <summary>The aircraft <paramref name="nm"/> before the threshold on the approach, in the air.</summary>
    private static RescueAircraft OnFinal(double nm)
    {
        var (lat, lon) = RescueController.Offset(ThrLat, ThrLon, Hdg + 180, nm * 1852);
        return new(lat, lon, Hdg, 140, false, false);
    }

    /// <summary>On the runway <paramref name="m"/> past the threshold.</summary>
    private static RescueAircraft Rolling(double m, double gs, bool brake = false)
    {
        var (lat, lon) = RescueController.Offset(ThrLat, ThrLon, Hdg, m);
        return new(lat, lon, Hdg, gs, true, brake);
    }

    private static double Meters(double lat1, double lon1, double lat2, double lon2) =>
        SmokeController.DistanceNm(lat1, lon1, lat2, lon2) * 1852;

    private static List<RescueAction> Run(RescueController c, RescueAircraft a) => [.. c.OnPosition(a)];

    [Fact]
    public void Stages_the_trucks_beside_the_runway_within_15_nm()
    {
        var (c, _) = New();
        c.Start(Req());
        Assert.Empty(Run(c, OnFinal(16)));
        Assert.Equal(RescueStage.Idle, c.Stage);

        var spawn = Run(c, OnFinal(14.9));
        Assert.Equal(4, spawn.Count);
        Assert.All(spawn, x => Assert.Equal(RescueActionKind.Spawn, x.Kind));
        Assert.Equal([0, 1, 2, 3], spawn.Select(x => x.Slot));
        Assert.Equal(FourTrucks, spawn.Select(x => x.Title));
        Assert.Equal(RescueStage.Staged, c.Stage);

        for (var i = 0; i < 4; i++)
        {
            var x = spawn[i];
            // From the touchdown zone to the far end of the 3000 m runway: 400, 1200, 2000, 2800 m from the threshold,
            // 150 m right of the axis (no wind side given), facing the runway: 160° (no model flagged as drawn reversed).
            var along = 400 + 2400.0 * i / 3;
            var (axLat, axLon) = RescueController.Offset(ThrLat, ThrLon, Hdg, along);
            var right = RescueController.Offset(axLat, axLon, Hdg + 90, 150);
            Assert.InRange(Meters(right.Lat, right.Lon, x.Lat, x.Lon), 0, 0.1);
            Assert.Equal(160, x.Hdg, 6);
        }
        Assert.Empty(Run(c, OnFinal(10))); // nothing more while waiting
        Assert.False(c.Moving);
        Assert.Empty(c.Step());
    }

    [Fact]
    public void One_truck_waits_at_the_touchdown_zone_and_upwind_means_left_when_asked()
    {
        var (c, _) = New();
        c.Start(Req(fire: ["Truck Fire Short"], left: true));
        var x = Assert.Single(Run(c, OnFinal(10)));
        var (tLat, tLon) = RescueController.Offset(ThrLat, ThrLon, Hdg, 400);
        var (lLat, lLon) = RescueController.Offset(tLat, tLon, Hdg - 90, 150);
        Assert.InRange(Meters(lLat, lLon, x.Lat, x.Lon), 0, 0.1);
        Assert.Equal(RescueController.Norm(Hdg + 90), x.Hdg, 6); // facing the runway from the left
    }

    [Fact]
    public void Only_trucks_flagged_as_drawn_reversed_get_their_heading_turned_180()
    {
        var (c, clock) = New();
        c.Start(Req(lengthM: Short, flip: [false, true, false, true]));
        var spawn = Run(c, OnFinal(10));
        Assert.Equal([160, 340, 160, 340], spawn.Select(x => Math.Round(x.Hdg)));
        Touchdown(c, clock, 500, 120);
        var step = Step(c, clock);
        var target = RescueController.TrailPoint(Rolling(500, 120), 1);
        var course = RescueController.Bearing((spawn[1].Lat, spawn[1].Lon), target);
        Assert.Equal(RescueController.Norm(course + 180), step[1].Hdg, 1); // drawn reversed: turned
        var course0 = RescueController.Bearing((spawn[0].Lat, spawn[0].Lon), RescueController.TrailPoint(Rolling(500, 120), 0));
        Assert.Equal(course0, step[0].Hdg, 1); // drawn along its heading: as it goes
        // Other flags are another request: the trucks are made anew.
        c.Start(Req(lengthM: Short, flip: [true, true, true, true]));
        Assert.Equal(4, Run(c, Rolling(500, 0)).Count(x => x.Kind == RescueActionKind.Remove));
    }

    /// <summary>Touchdown at <paramref name="m"/>: on the ground for <see cref="RescueController.TouchdownAfter"/>; the actions then.</summary>
    private static List<RescueAction> Touchdown(RescueController c, ManualClock clock, double m, double gs)
    {
        Assert.Empty(Run(c, Rolling(m, gs))); // on the ground, not yet long enough
        clock.Advance(RescueController.TouchdownAfter);
        return Run(c, Rolling(m, gs));
    }

    /// <summary>One step of the bridge's 10 Hz timer.</summary>
    private static List<RescueAction> Step(RescueController c, ManualClock clock)
    {
        clock.Advance(RescueController.StepEvery);
        return [.. c.Step()];
    }

    [Fact]
    public void The_bridge_moves_following_trucks_itself()
    {
        var (c, clock) = New();
        c.Start(Req(lengthM: Short));
        Run(c, OnFinal(10));
        Assert.Empty(Touchdown(c, clock, 500, 120)); // no actions: the routes are the bridge's own
        Assert.Equal(RescueStage.Trailing, c.Stage);
        Assert.True(c.Moving);

        var before = Enumerable.Range(0, 4).Select(i => c.PositionOf(i)!.Value).ToArray();
        var step = Step(c, clock);
        Assert.Equal([0, 1, 2, 3], step.Select(x => x.Slot));
        Assert.All(step, x => Assert.Equal(RescueActionKind.Place, x.Kind));
        var target = RescueController.TrailPoint(Rolling(500, 120), 0);
        var first = step[0];
        // 60 kt (120 + 10, capped) for 0.1 s: 3.09 m toward its place behind the aircraft, facing there.
        Assert.Equal(3.087, Meters(before[0].Lat, before[0].Lon, first.Lat, first.Lon), 2);
        var course = RescueController.Bearing(before[0], target);
        Assert.Equal(course, first.Hdg, 1);
        Assert.Equal((first.Lat, first.Lon), c.PositionOf(0));

        // A stall of 2 s moves only as much as 0.5 s.
        clock.Advance(TimeSpan.FromSeconds(2));
        var after = c.Step()[0];
        Assert.InRange(Meters(first.Lat, first.Lon, after.Lat, after.Lon), 15, 15.5);
    }

    [Fact]
    public void Full_surrounds_the_stopped_aircraft_round_it_not_through_it_and_leaves_after_10_min()
    {
        var (c, clock) = New();
        c.Start(Req(lengthM: Short));
        Run(c, OnFinal(10));
        Touchdown(c, clock, 500, 120);
        // The aircraft stops at 1500 m, the trucks still near the threshold zone behind it.
        Run(c, Rolling(1500, 0));
        clock.Advance(RescueController.StopAfter);
        Assert.Empty(Run(c, Rolling(1500, 0)));
        Assert.Equal(RescueStage.Encircle, c.Stage);

        var a = Rolling(1500, 0);
        var minFromAircraft = double.MaxValue;
        for (var k = 0; k < 1200 && c.Moving; k++) // up to 2 min
        {
            foreach (var x in Step(c, clock))
            {
                Assert.Equal(RescueActionKind.Place, x.Kind);
                minFromAircraft = Math.Min(minFromAircraft, Meters(a.Lat, a.Lon, x.Lat, x.Lon));
            }
            if (k % 4 == 0) Run(c, a);
        }
        Assert.False(c.Moving);
        Run(c, a);
        for (var i = 0; i < 4; i++)
        {
            var at = c.PositionOf(i)!.Value;
            var point = RescueController.CirclePoint(a, i, 4);
            Assert.InRange(Meters(point.Lat, point.Lon, at.Lat, at.Lon), 0, RescueController.ArrivedM); // stops on arrival (≤ 5 m)
        }
        // Coming from behind, the truck for the nose point went round the aircraft, never within 40 m.
        Assert.True(minFromAircraft >= RescueController.ClearM, $"{minFromAircraft:0.0} m");
        Assert.Empty(Step(c, clock)); // standing: nothing is moved

        clock.Advance(RescueController.StayAfterStop);
        var gone = Run(c, a);
        Assert.Equal([0, 1, 2, 3], gone.Select(x => x.Slot));
        Assert.All(gone, x => Assert.Equal(RescueActionKind.Remove, x.Kind));
        Assert.Equal(RescueStage.Done, c.Stage);
        c.SessionEnded(); // done stays done in a new session
        Assert.Empty(Run(c, a));
    }

    [Fact]
    public void Circle_route_goes_around_the_aircraft_the_short_way_in_45_degree_steps()
    {
        var a = new RescueAircraft(ThrLat, ThrLon, 0, 0, true, true);
        var target = RescueController.Offset(a.Lat, a.Lon, 0, 50); // north, 50 m
        // From due south, 60 m: the line runs through the aircraft. 180° → 4 steps of 45°.
        var from = RescueController.Offset(a.Lat, a.Lon, 180, 60);
        var r = RescueController.CircleRoute(a, from, target);
        Assert.Equal(6, r.Length); // arc points at 180, ±45 … 0, then the target
        for (var k = 0; k < 5; k++)
        {
            Assert.InRange(Meters(a.Lat, a.Lon, r[k].Lat, r[k].Lon), 79.9, 80.1);
            if (k == 0) continue;
            var step = RescueController.Bearing((a.Lat, a.Lon), r[k]) - RescueController.Bearing((a.Lat, a.Lon), r[k - 1]);
            Assert.Equal(45, Math.Abs(((step + 540) % 360) - 180), 3);
        }
        Assert.Equal(target, r[^1]);
        // From the east to just south of west (179°): the short way round the south, 4 steps.
        var east = RescueController.Offset(a.Lat, a.Lon, 90, 45);
        var r2 = RescueController.CircleRoute(a, east, RescueController.Offset(a.Lat, a.Lon, 269, 50));
        Assert.Equal(6, r2.Length);
        Assert.InRange(RescueController.Bearing((a.Lat, a.Lon), r2[2]), 178, 181);
        // Clear of the aircraft: straight.
        var west = RescueController.Offset(a.Lat, a.Lon, 300, 120);
        Assert.Single(RescueController.CircleRoute(a, west, RescueController.Offset(a.Lat, a.Lon, 270, 50)));
        Assert.InRange(RescueController.SegmentDistanceM((a.Lat, a.Lon), from, target), 0, 0.5);
    }

    [Fact]
    public void Trucks_ahead_at_touchdown_wait_until_the_aircraft_has_passed()
    {
        var (c, clock) = New();
        c.Start(Req(lengthM: Spaced));
        Run(c, OnFinal(10));
        // Touchdown 450 m past the threshold: truck 0 (400 m) is behind, trucks 1-3 (470, 540, 610 m) ahead.
        Touchdown(c, clock, 450, 120);
        Assert.Equal(RescueStage.Trailing, c.Stage);
        Assert.Equal([0], Step(c, clock).Select(x => x.Slot)); // only truck 0 moves

        clock.Advance(TimeSpan.FromMilliseconds(400));
        Run(c, Rolling(500, 110)); // past truck 1 (470 m)
        Assert.Equal([0, 1], Step(c, clock).Select(x => x.Slot));
        clock.Advance(TimeSpan.FromMilliseconds(400));
        Run(c, Rolling(700, 100));
        Assert.Equal([0, 1, 2, 3], Step(c, clock).Select(x => x.Slot));
    }

    [Fact]
    public void Stopping_before_passing_the_waiting_trucks_still_sends_them_to_the_circle()
    {
        var clock = ManualClock.At(1_700_000_000_000);
        var lines = new List<string>();
        var c = new RescueController(clock, lines.Add);
        c.Start(Req());
        // The ground test: the request at the aircraft on the ground, never airborne.
        Assert.Equal(4, Run(c, Rolling(0, 0)).Count);
        clock.Advance(TimeSpan.FromSeconds(3));
        Assert.Empty(Run(c, Rolling(0, 0))); // stands, but no touchdown was seen: the trucks keep waiting
        Assert.Equal(RescueStage.Staged, c.Stage);
        Assert.Equal(2, lines.Count); // one line per change, none while nothing changes
        Assert.Contains("airborne since staged False", lines[0]);
        Assert.Contains("stands True", lines[1]);

        // Up and down again (a slew "touchdown"): all 4 wait (they are ahead), then the stop sends them to the circle.
        Run(c, OnFinal(0.1));
        Touchdown(c, clock, 0, 0);
        Assert.Equal(RescueStage.Trailing, c.Stage);
        Assert.False(c.Moving);
        clock.Advance(TimeSpan.FromSeconds(2));
        Run(c, Rolling(0, 0));
        Assert.Equal(RescueStage.Encircle, c.Stage);
        Assert.Equal([0, 1, 2, 3], Step(c, clock).Select(x => x.Slot));
        Assert.Contains(lines, l => l.Contains("stage Trailing") && l.Contains("waiting 4"));
        Assert.Contains(lines, l => l.Contains("the aircraft stands, trucks drive to the circle"));
        // The moving trucks are traced every 2 s.
        for (var k = 0; k < 25; k++) Step(c, clock);
        Assert.Contains(lines, l => l.Contains("rescue slot 0 moving:") && l.Contains("40 kt") && l.Contains("to target"));
    }

    [Fact]
    public void A_bounce_neither_lands_nor_goes_around()
    {
        var (c, clock) = New();
        c.Start(Req(lengthM: Short));
        Run(c, OnFinal(10));
        // Ground contact shorter than 1 s: no touchdown.
        Assert.Empty(Run(c, Rolling(400, 130)));
        clock.Advance(TimeSpan.FromMilliseconds(500));
        Assert.Empty(Run(c, OnFinal(0)));
        Assert.Equal(RescueStage.Staged, c.Stage);
        // A real touchdown, then a bounce of 3 s: still following.
        Touchdown(c, clock, 500, 120);
        clock.Advance(TimeSpan.FromMilliseconds(400));
        Assert.Empty(Run(c, OnFinal(0)));
        clock.Advance(TimeSpan.FromSeconds(3));
        Assert.Empty(Run(c, OnFinal(0)));
        Assert.Equal(RescueStage.Trailing, c.Stage);
        Assert.True(c.Moving);
    }

    [Fact]
    public void Standby_waits_and_never_moves()
    {
        var (c, clock) = New();
        c.Start(Req(full: false, lengthM: Short));
        Run(c, OnFinal(10));
        Run(c, OnFinal(0.2));
        Assert.Empty(Touchdown(c, clock, 500, 120));
        Assert.Equal(RescueStage.Staged, c.Stage);
        Run(c, Rolling(1500, 0));
        clock.Advance(TimeSpan.FromSeconds(3));
        Assert.Empty(Run(c, Rolling(1500, 0))); // stopped: no circle
        Assert.Equal(RescueStage.Encircle, c.Stage);
        Assert.False(c.Moving);
        Assert.Empty(Step(c, clock));
        clock.Advance(RescueController.StayAfterStop);
        Assert.Equal(4, Run(c, Rolling(1500, 0)).Count(x => x.Kind == RescueActionKind.Remove));
    }

    [Fact]
    public void Pan_then_mayday_keeps_the_staged_trucks_and_lets_them_follow()
    {
        var (c, clock) = New();
        c.Start(Req(full: false, lengthM: Short));
        Assert.Equal(4, Run(c, OnFinal(10)).Count);
        c.Start(Req(full: true, lengthM: Short));
        Assert.Empty(Run(c, OnFinal(5))); // same trucks, nothing created or removed
        Touchdown(c, clock, 500, 100);
        Assert.Equal(4, Step(c, clock).Count(x => x.Kind == RescueActionKind.Place));
    }

    [Fact]
    public void A_go_around_after_5_s_in_the_air_stops_them_again()
    {
        var (c, clock) = New();
        c.Start(Req(lengthM: Short));
        Run(c, OnFinal(10));
        Touchdown(c, clock, 500, 100);
        Assert.True(c.Moving);
        Assert.Empty(Run(c, OnFinal(0.5)));
        Assert.True(c.Moving); // not yet 5 s
        clock.Advance(RescueController.GoAroundAfter);
        Run(c, OnFinal(0.5));
        Assert.Equal(RescueStage.Staged, c.Stage);
        Assert.False(c.Moving);
        Assert.Empty(Step(c, clock));
    }

    [Fact]
    public void Another_runway_removes_the_trucks_and_stages_anew()
    {
        var (c, _) = New();
        c.Start(Req());
        Run(c, OnFinal(10));
        c.Start(Req(thrLat: ThrLat + 0.01));
        var a = Run(c, OnFinal(10));
        Assert.Equal(4, a.Count(x => x.Kind == RescueActionKind.Remove));
        Assert.Equal(4, a.Count(x => x.Kind == RescueActionKind.Spawn));
    }

    [Fact]
    public void Go_around_beyond_30_nm_removes_them_and_15_nm_creates_them_again()
    {
        var (c, _) = New();
        c.Start(Req());
        Run(c, OnFinal(10));
        Assert.Empty(Run(c, OnFinal(29.9)));
        Assert.Equal(4, Run(c, OnFinal(30.1)).Count(x => x.Kind == RescueActionKind.Remove));
        Assert.Equal(RescueStage.Idle, c.Stage);
        Assert.Empty(Run(c, OnFinal(20)));
        Assert.Equal(4, Run(c, OnFinal(15)).Count(x => x.Kind == RescueActionKind.Spawn));
    }

    [Fact]
    public void Stop_removes_everything_and_a_new_session_creates_the_standing_request_again()
    {
        var (c, _) = New();
        c.Start(Req());
        Run(c, OnFinal(10));
        c.SessionEnded(); // the sim took the objects
        Assert.Equal(4, Run(c, OnFinal(9)).Count(x => x.Kind == RescueActionKind.Spawn));
        c.Stop();
        var gone = Run(c, OnFinal(9));
        Assert.Equal(4, gone.Count(x => x.Kind == RescueActionKind.Remove));
        Assert.Empty(Run(c, OnFinal(9)));
        Assert.False(c.Active);
    }

    [Fact]
    public void Ambulance_appears_left_of_the_parked_aircraft_and_leaves_after_10_min()
    {
        var (c, clock) = New();
        c.Start(Req(full: false, fire: [], medic: ["Truck Utility Europe Medic Box"]));
        Assert.Empty(Run(c, OnFinal(5)));
        Assert.Empty(Run(c, Rolling(800, 0))); // stopped, brake off
        clock.Advance(TimeSpan.FromSeconds(3));
        Assert.Empty(Run(c, Rolling(800, 0)));
        var spawn = Assert.Single(Run(c, Rolling(800, 0, brake: true)));
        Assert.Equal(RescueActionKind.Spawn, spawn.Kind);
        Assert.Equal(RescueController.MedicSlot, spawn.Slot);
        Assert.Equal("Truck Utility Europe Medic Box", spawn.Title);
        var (pLat, pLon) = RescueController.Offset(ThrLat, ThrLon, Hdg, 800);
        var (lLat, lLon) = RescueController.Offset(pLat, pLon, Hdg - 90, 30);
        Assert.InRange(Meters(lLat, lLon, spawn.Lat, spawn.Lon), 0, 0.1);
        Assert.Equal(Hdg, spawn.Hdg, 6);

        clock.Advance(RescueController.StayAfterStop);
        Assert.Equal(RescueActionKind.Remove, Assert.Single(Run(c, Rolling(800, 0, brake: true))).Kind);
        clock.Advance(TimeSpan.FromMinutes(1));
        Assert.Empty(Run(c, Rolling(800, 0, brake: true))); // once
    }

    [Fact]
    public void Ambulance_comes_along_when_the_aircraft_parks_again_elsewhere()
    {
        var (c, clock) = New();
        c.Start(Req(full: false, fire: [], medic: ["Truck Utility Europe Medic Box"]));
        Run(c, Rolling(800, 0, brake: true));
        clock.Advance(TimeSpan.FromSeconds(3));
        var first = Assert.Single(Run(c, Rolling(800, 0, brake: true)));
        Assert.Equal(RescueActionKind.Spawn, first.Kind);

        // Taxies 60 m on (the ambulance stays), parks there: closer than 100 m, nothing happens.
        Run(c, Rolling(830, 10));
        Run(c, Rolling(860, 0, brake: true));
        clock.Advance(TimeSpan.FromSeconds(3));
        Assert.Empty(Run(c, Rolling(860, 0, brake: true)));

        // Taxies to the gate 1 km away, stops without the brake: nothing; with the brake: created anew beside it.
        Run(c, Rolling(1900, 15));
        Run(c, Rolling(1900, 0));
        clock.Advance(TimeSpan.FromSeconds(3));
        Assert.Empty(Run(c, Rolling(1900, 0)));
        var again = Run(c, Rolling(1900, 0, brake: true));
        Assert.Equal([RescueActionKind.Remove, RescueActionKind.Spawn], again.Select(x => x.Kind));
        Assert.All(again, x => Assert.Equal(RescueController.MedicSlot, x.Slot));
        var (pLat, pLon) = RescueController.Offset(ThrLat, ThrLon, Hdg, 1900);
        var (lLat, lLon) = RescueController.Offset(pLat, pLon, Hdg - 90, 30);
        Assert.InRange(Meters(lLat, lLon, again[1].Lat, again[1].Lon), 0, 0.1);

        // The 10 minutes count from the new one.
        clock.Advance(RescueController.StayAfterStop - TimeSpan.FromSeconds(1));
        Assert.Empty(Run(c, Rolling(1900, 0, brake: true)));
        clock.Advance(TimeSpan.FromSeconds(1));
        Assert.Equal(RescueActionKind.Remove, Assert.Single(Run(c, Rolling(1900, 0, brake: true))).Kind);
    }

    [Fact]
    public void Ambulance_not_far_from_the_landing_airport()
    {
        var (c, clock) = New();
        c.Start(Req(fire: [], medic: ["Van Asia High Roof Medic"]));
        var far = new RescueAircraft(ThrLat + 1, ThrLon, 0, 0, true, true);
        Run(c, far);
        clock.Advance(TimeSpan.FromSeconds(3));
        Assert.Empty(Run(c, far));
    }

    /// <summary>T88: an aircraft at a stand 1.5 km from the threshold, 800 m off the axis; <c>SIM ON GROUND</c> as the sim says.</summary>
    private static RescueAircraft AtStand(double gs = 0, bool onGround = true, bool brake = true, double hdg = 340)
    {
        var (lat, lon) = RescueController.Offset(ThrLat, ThrLon, Hdg, 1500);
        var (sLat, sLon) = RescueController.Offset(lat, lon, Hdg - 90, 800);
        return new(sLat, sLon, hdg, gs, onGround, brake);
    }

    /// <summary>Steps the trucks until they stand (at most 3 min), with a position every 0.4 s.</summary>
    private static void DriveUntilStill(RescueController c, ManualClock clock, RescueAircraft a)
    {
        for (var k = 0; k < 1800 && c.Moving; k++)
        {
            Step(c, clock);
            if (k % 4 == 0) Run(c, a);
        }
        Assert.False(c.Moving);
    }

    [Fact]
    public void Ground_call_full_trucks_come_from_the_runway_and_surround_the_standing_aircraft()
    {
        var (c, clock) = New();
        c.Start(Req(ground: true));
        // SIM ON GROUND = 0 at the stand (BlueBird 757, 2026-11-01): a call on the ground goes by the ground speed only.
        var a = AtStand(onGround: false);
        var spawn = Run(c, a);
        Assert.Equal(4, spawn.Count);
        Assert.All(spawn, x => Assert.Equal(RescueActionKind.Spawn, x.Kind));
        var staged = RescueController.StagePoint(Req(ground: true), 0, 4);
        Assert.InRange(Meters(staged.Lat, staged.Lon, spawn[0].Lat, spawn[0].Lon), 0, 0.1); // beside the runway, as on arrival

        clock.Advance(RescueController.StopAfter);
        Run(c, a);
        Assert.Equal(RescueStage.Encircle, c.Stage);
        Assert.True(c.Moving);
        DriveUntilStill(c, clock, a);
        for (var i = 0; i < 4; i++)
        {
            var at = c.PositionOf(i)!.Value;
            var point = RescueController.CirclePoint(a, i, 4);
            Assert.InRange(Meters(point.Lat, point.Lon, at.Lat, at.Lon), 0, RescueController.ArrivedM);
        }

        clock.Advance(RescueController.StayAfterStop);
        Assert.All(Run(c, a), x => Assert.Equal(RescueActionKind.Remove, x.Kind));
        Assert.Equal(RescueStage.Done, c.Stage);
    }

    [Fact]
    public void Ground_call_standby_trucks_stand_aside_ahead_of_the_aircraft_not_round_it()
    {
        var (c, clock) = New();
        c.Start(Req(full: false, ground: true));
        var a = AtStand();
        Run(c, a);
        clock.Advance(RescueController.StopAfter);
        Run(c, a);
        Assert.Equal(RescueStage.Encircle, c.Stage);
        DriveUntilStill(c, clock, a);
        for (var i = 0; i < 4; i++)
        {
            var at = c.PositionOf(i)!.Value;
            var point = RescueController.StandbyPoint(a, i, 4);
            Assert.InRange(Meters(point.Lat, point.Lon, at.Lat, at.Lon), 0, RescueController.ArrivedM);
            Assert.InRange(Meters(a.Lat, a.Lon, at.Lat, at.Lon), RescueController.StandbyM - RescueController.ArrivedM, RescueController.StandbyM + RescueController.ArrivedM);
            Assert.True(RescueController.AheadM(a, at) > 0, $"truck {i} is not ahead of the nose");
        }
    }

    [Fact]
    public void Ground_call_full_trucks_follow_a_rolling_aircraft_and_surround_it_when_it_stops()
    {
        var (c, clock) = New();
        c.Start(Req(ground: true));
        var rolling = AtStand(gs: 10, brake: false);
        Run(c, rolling);
        clock.Advance(RescueController.StopAfter);
        Run(c, rolling);
        Assert.Equal(RescueStage.Trailing, c.Stage);
        Assert.True(c.Moving);

        // A take-off run: past MaxTrailKt the trucks stop where they are.
        clock.Advance(RescueController.MoveEvery);
        Run(c, AtStand(gs: 120, brake: false));
        Assert.False(c.Moving);

        var stopped = AtStand(gs: 0);
        Run(c, stopped);
        clock.Advance(RescueController.StopAfter);
        Run(c, stopped);
        Assert.Equal(RescueStage.Encircle, c.Stage);
        Assert.True(c.Moving);

        // It rolls again: the trucks leave the circle and follow.
        Run(c, rolling);
        clock.Advance(RescueController.StopAfter);
        Run(c, rolling);
        Assert.Equal(RescueStage.Trailing, c.Stage);
    }

    [Fact]
    public void Ground_call_standby_trucks_wait_while_the_aircraft_rolls()
    {
        var (c, clock) = New();
        c.Start(Req(full: false, ground: true));
        var rolling = AtStand(gs: 10, brake: false);
        Run(c, rolling);
        clock.Advance(RescueController.StopAfter);
        Run(c, rolling);
        Assert.Equal(RescueStage.Staged, c.Stage);
        Assert.False(c.Moving);
    }

    [Fact]
    public void Ground_call_ambulance_by_the_ground_speed_even_without_sim_on_ground()
    {
        var (c, clock) = New();
        c.Start(Req(full: false, fire: [], medic: ["Truck Utility Europe Medic Box"], ground: true));
        var a = AtStand(onGround: false);
        Run(c, a);
        clock.Advance(RescueController.StopAfter);
        var x = Assert.Single(Run(c, a));
        Assert.Equal(RescueActionKind.Spawn, x.Kind);
        Assert.Equal(RescueController.MedicSlot, x.Slot);
    }

    [Fact]
    public void A_ground_call_replaces_an_arrival_one_at_the_same_runway()
    {
        Assert.False(Req().SameFire(Req(ground: true)));
        Assert.True(Req(ground: true).SameFire(Req(ground: true)));
    }

    [Fact]
    public void Reads_the_command_arguments()
    {
        var args = new Dictionary<string, JsonValue>
        {
            ["level"] = JsonValue.Create("standby"), ["thrLat"] = JsonValue.Create(50.04), ["thrLon"] = JsonValue.Create(8.59),
            ["hdg"] = JsonValue.Create(250.0), ["lengthM"] = JsonValue.Create(4000.0), ["side"] = JsonValue.Create("left"),
            ["fire"] = JsonValue.Create("A|B"), ["fireFlip"] = JsonValue.Create("0|1"), ["medic"] = JsonValue.Create(""),
        };
        var r = RescueRequest.FromArgs(args);
        Assert.False(r.Full);
        Assert.True(r.Left);
        Assert.Equal(["A", "B"], r.Fire);
        Assert.False(r.Flipped(0));
        Assert.True(r.Flipped(1));
        Assert.Empty(r.Medic);
        Assert.False(r.Ground);
        args["ground"] = JsonValue.Create(true);
        Assert.True(RescueRequest.FromArgs(args).Ground);
    }
}

public class RescueCommandTests
{
    private static (SimCommand? Command, string? Id, CommandResult? Error) Parse(string command, string args) =>
        CommandCatalog.Parse($$"""{"type":"command","id":"r1","command":"{{command}}","args":{{args}}}""");

    private const string Ok =
        """{"level":"full","thrLat":50.04,"thrLon":8.59,"hdg":250,"lengthM":4000,"side":"right","fire":"ASO_Firetruck02|Truck Fire Short","fireFlip":"0|1","medic":""}""";

    [Fact]
    public void Rescue_commands_are_whitelisted()
    {
        Assert.Null(Parse("rescue_start", Ok).Error);
        Assert.Null(Parse("rescue_start", Ok.Replace("\"medic\":\"\"", "\"medic\":\"Car Bush Medic\"")).Error);
        Assert.Null(Parse("rescue_start",
            """{"level":"medical","thrLat":0,"thrLon":0,"hdg":0,"lengthM":1,"side":"left","fire":"","fireFlip":"","medic":"Truck Utility NorthAm Medic"}""").Error);
        Assert.Null(Parse("rescue_stop", "{}").Error);

        string? Why(string args) => Parse("rescue_start", args).Error?.Detail;
        Assert.Matches("level", Why(Ok.Replace("\"full\"", "\"huge\""))!);
        Assert.Matches("thrLat", Why(Ok.Replace("50.04", "91"))!);
        Assert.Matches("thrLon", Why(Ok.Replace("8.59", "\"8\""))!);
        Assert.Matches("hdg", Why(Ok.Replace("250", "360"))!);
        Assert.Matches("lengthM", Why(Ok.Replace("4000", "0"))!);
        Assert.Matches("side", Why(Ok.Replace("\"right\"", "\"up\""))!);
        Assert.Matches("fireFlip", Why(Ok.Replace("\"0|1\"", "\"0\""))!);
        Assert.Matches("fireFlip", Why(Ok.Replace("\"0|1\"", "\"0|2\""))!);
        Assert.Matches("empty title", Why(Ok.Replace("Truck Fire Short", ""))!);
        Assert.Matches("empty title", Why(Ok.Replace("|Truck", "| Truck"))!);
        Assert.Matches("at most 8", Why(Ok.Replace("\"fire\":\"ASO_Firetruck02|Truck Fire Short\"", "\"fire\":\"a|b|c|d|e|f|g|h|i\""))!);
        Assert.Matches("no fire trucks", Why(Ok.Replace("\"full\"", "\"medical\""))!);
        Assert.Matches("only", Why("""{"level":"full"}""")!);
        // T88: an optional `ground: true`.
        Assert.Null(Parse("rescue_start", Ok.Replace("\"medic\":\"\"", "\"medic\":\"\",\"ground\":true")).Error);
        Assert.Matches("ground", Why(Ok.Replace("\"medic\":\"\"", "\"medic\":\"\",\"ground\":false"))!);
        Assert.Matches("ground", Why(Ok.Replace("\"medic\":\"\"", "\"medic\":\"\",\"ground\":1"))!);
        Assert.Matches("only", Why(Ok.Replace("\"medic\":\"\"", "\"medic\":\"\",\"extra\":true"))!);
        Assert.Equal(CommandErrors.BadArgs, Parse("rescue_stop", """{"x":1}""").Error?.Error);
    }
}
