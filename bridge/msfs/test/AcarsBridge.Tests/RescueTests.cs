using System.Text.Json.Nodes;
using AcarsBridge;

namespace AcarsBridge.Tests;

public class RescueControllerTests
{
    // Threshold of RWY 24L at EDDF-like coordinates, runway course 250°.
    private const double ThrLat = 50.04, ThrLon = 8.59, Hdg = 250;

    private static readonly string[] FourTrucks = ["ASO_Firetruck02", "Microsoft_Truck_Fire_Medium_Red", "ASO_Firetruck02", "Microsoft_Truck_Fire_Medium_Red"];

    private static RescueRequest Req(bool full = true, string[]? fire = null, string[]? medic = null, double thrLat = ThrLat) =>
        new(full, thrLat, ThrLon, Hdg, 3000, fire ?? FourTrucks, medic ?? []);

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
            // On the runway axis 100 + 70 i m from the threshold, 45 m to the right of it, facing the runway.
            var (axLat, axLon) = RescueController.Offset(ThrLat, ThrLon, Hdg, 100 + 70 * i);
            Assert.InRange(Meters(axLat, axLon, x.Lat, x.Lon), 44.9, 45.1);
            Assert.InRange(Meters(ThrLat, ThrLon, x.Lat, x.Lon), Math.Sqrt(Math.Pow(100 + 70 * i, 2) + 45 * 45) - 0.5,
                Math.Sqrt(Math.Pow(100 + 70 * i, 2) + 45 * 45) + 0.5);
            var right = RescueController.Offset(axLat, axLon, Hdg + 90, 45);
            Assert.InRange(Meters(right.Lat, right.Lon, x.Lat, x.Lon), 0, 0.1);
            Assert.Equal(160, x.Hdg, 6);
        }
        Assert.Empty(Run(c, OnFinal(10))); // nothing more while waiting
    }

    /// <summary>Touchdown at <paramref name="m"/>: on the ground for <see cref="RescueController.TouchdownAfter"/>; the actions then.</summary>
    private static List<RescueAction> Touchdown(RescueController c, ManualClock clock, double m, double gs)
    {
        Assert.Empty(Run(c, Rolling(m, gs))); // on the ground, not yet long enough
        clock.Advance(RescueController.TouchdownAfter);
        return Run(c, Rolling(m, gs));
    }

    private static readonly RescueActionKind[] HaltKinds = [RescueActionKind.Move, RescueActionKind.Simulate];

    [Fact]
    public void Full_follows_after_touchdown_then_surrounds_the_stopped_aircraft_and_leaves_after_10_min()
    {
        var (c, clock) = New();
        c.Start(Req());
        var spawn = Run(c, OnFinal(10));
        Assert.Empty(Run(c, OnFinal(0.2)));

        var touch = Touchdown(c, clock, 500, 120);
        Assert.Equal(RescueStage.Trailing, c.Stage);
        // Per truck: turned (standing) toward its first point, its simulation on, then the route.
        Assert.Equal(
            Enumerable.Repeat(new[] { RescueActionKind.Turn, RescueActionKind.Simulate, RescueActionKind.Move }, 4).SelectMany(k => k),
            touch.Select(x => x.Kind));
        for (var i = 0; i < 4; i++)
        {
            var (turn, sim, go) = (touch[3 * i], touch[3 * i + 1], touch[3 * i + 2]);
            Assert.True(sim.On);
            Assert.All(new[] { turn, sim, go }, x => Assert.Equal(i, x.Slot));
            // Column behind the aircraft: 25, 50, 75, 100 m back along its heading, and a second point 30 m on.
            var route = go.Route!;
            Assert.Equal(2, route.Length);
            var (bLat, bLon) = RescueController.Offset(ThrLat, ThrLon, Hdg, 500 - 25 * (i + 1));
            Assert.InRange(Meters(bLat, bLon, route[0].Lat, route[0].Lon), 0, 0.5);
            var (aLat, aLon) = RescueController.Offset(ThrLat, ThrLon, Hdg, 500 - 25 * (i + 1) + 30);
            Assert.InRange(Meters(aLat, aLon, route[1].Lat, route[1].Lon), 0, 0.5);
            Assert.Equal(60, go.SpeedKt); // 120 + 10, capped
            Assert.Equal(RescueController.Bearing((spawn[i].Lat, spawn[i].Lon), route[0]), turn.Hdg, 6);
        }

        clock.Advance(TimeSpan.FromMilliseconds(200));
        Assert.Empty(Run(c, Rolling(600, 60))); // not before 350 ms
        clock.Advance(TimeSpan.FromMilliseconds(150));
        var slow = Run(c, Rolling(700, 5));
        Assert.Equal(4, slow.Count);
        Assert.All(slow, x => Assert.Equal(RescueActionKind.Move, x.Kind)); // no turns while driving
        Assert.Equal(20, slow[0].SpeedKt); // 5 + 10, at least 20
        Assert.Equal([0, 1, 2, 3], c.Driving);

        clock.Advance(TimeSpan.FromSeconds(1));
        Assert.All(Run(c, Rolling(1500, 0.5)), x => Assert.Equal(RescueActionKind.Move, x.Kind)); // slow, not yet 2 s
        clock.Advance(TimeSpan.FromMilliseconds(1900));
        Assert.All(Run(c, Rolling(1500, 0.5)), x => Assert.Equal(20, x.SpeedKt));
        Assert.Equal(RescueStage.Trailing, c.Stage);

        // Where the trucks are when the aircraft stops: 0 just behind it, 1 well ahead of its nose.
        var (pLat, pLon) = RescueController.Offset(ThrLat, ThrLon, Hdg, 1500);
        var behind = RescueController.Offset(pLat, pLon, Hdg + 180, 60);
        var ahead = RescueController.Offset(pLat, pLon, Hdg, 120);
        c.VehiclePosition(0, behind.Lat, behind.Lon);
        c.VehiclePosition(1, ahead.Lat, ahead.Lon);
        clock.Advance(TimeSpan.FromMilliseconds(100));
        var circle = Run(c, Rolling(1500, 0));
        Assert.Equal(RescueStage.Encircle, c.Stage);
        // Per truck: halt (one point at its place, 0 kt; simulation off), turn toward the first point, go.
        Assert.Equal(
            Enumerable.Repeat(new[] { RescueActionKind.Move, RescueActionKind.Simulate, RescueActionKind.Turn, RescueActionKind.Simulate, RescueActionKind.Move }, 4).SelectMany(k => k),
            circle.Select(x => x.Kind));
        var halt0 = circle[0];
        Assert.Equal(0, halt0.SpeedKt);
        Assert.Equal(behind, Assert.Single(halt0.Route!));
        Assert.False(circle[1].On);
        var goes = circle.Where(x => x.Kind == RescueActionKind.Move && x.SpeedKt > 0).ToList();
        Assert.Equal(4, goes.Count);
        Assert.All(goes, x =>
        {
            var end = x.Route![^1];
            Assert.InRange(Meters(pLat, pLon, end.Lat, end.Lon), 49.9, 50.1);
            Assert.Equal(30, x.SpeedKt);
        });
        var (noseLat, noseLon) = RescueController.Offset(pLat, pLon, Hdg, 50);
        Assert.InRange(Meters(noseLat, noseLon, goes[0].Route![^1].Lat, goes[0].Route![^1].Lon), 0, 0.1);
        var (rightLat, rightLon) = RescueController.Offset(pLat, pLon, Hdg + 90, 50);
        Assert.InRange(Meters(rightLat, rightLon, goes[1].Route![^1].Lat, goes[1].Route![^1].Lon), 0, 0.1);
        // Truck 0 behind the aircraft to the nose point: around it on the 80 m arc.
        Assert.True(goes[0].Route!.Length > 1);
        Assert.All(goes[0].Route![..^1], q => Assert.InRange(Meters(pLat, pLon, q.Lat, q.Lon), 79.9, 80.1));
        // Truck 1 well ahead of the nose to the right side: the straight line keeps 40 m off.
        Assert.Single(goes[1].Route!);

        // Arrived within 5 m: that truck is halted; the others drive on.
        Assert.Equal([0, 1, 2, 3], c.Driving);
        var at = goes[1].Route![^1];
        c.VehiclePosition(1, at.Lat, at.Lon);
        var arrived = Run(c, Rolling(1500, 0));
        Assert.Equal(HaltKinds, arrived.Select(x => x.Kind));
        Assert.All(arrived, x => Assert.Equal(1, x.Slot));
        Assert.Equal(at, Assert.Single(arrived[0].Route!));
        Assert.Equal([0, 2, 3], c.Driving);
        // At the latest the arrival limit of its route halts each truck, wherever it is (at most 120 s).
        clock.Advance(RescueController.ArrivalMax);
        var late = Run(c, Rolling(1500, 0));
        Assert.Equal([0, 0, 2, 2, 3, 3], late.Select(x => x.Slot));
        Assert.Empty(c.Driving);

        clock.Advance(RescueController.StayAfterStop - RescueController.ArrivalMax - TimeSpan.FromSeconds(1));
        Assert.Empty(Run(c, Rolling(1500, 0)));
        clock.Advance(TimeSpan.FromSeconds(1));
        var gone = Run(c, Rolling(1500, 0));
        Assert.Equal([0, 1, 2, 3], gone.Select(x => x.Slot));
        Assert.All(gone, x => Assert.Equal(RescueActionKind.Remove, x.Kind));
        Assert.Equal(RescueStage.Done, c.Stage);
        Assert.Empty(Run(c, Rolling(1500, 0)));

        c.SessionEnded(); // done stays done in a new session
        Assert.Empty(Run(c, Rolling(1500, 0)));
    }

    [Fact]
    public void Arrival_limit_grows_with_the_route_up_to_120_s()
    {
        var a = (ThrLat, ThrLon);
        var p150 = RescueController.Offset(ThrLat, ThrLon, 0, 150);
        // 150 m at 15 m/s = 10 s, twice = 20 s, plus 15 s.
        Assert.Equal(35, RescueController.ArrivalLimit(a, [p150]).TotalSeconds, 1);
        var far = RescueController.Offset(ThrLat, ThrLon, 0, 2000);
        Assert.Equal(RescueController.ArrivalMax, RescueController.ArrivalLimit(a, [far]));
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
        c.Start(Req());
        Run(c, OnFinal(10));
        // Touchdown 150 m past the threshold: truck 0 (100 m) is behind, trucks 1-3 (170, 240, 310 m) ahead.
        var touch = Touchdown(c, clock, 150, 120);
        Assert.Equal(RescueStage.Trailing, c.Stage);
        Assert.All(touch, x => Assert.Equal(0, x.Slot));
        Assert.Equal([RescueActionKind.Turn, RescueActionKind.Simulate, RescueActionKind.Move], touch.Select(x => x.Kind));
        Assert.Equal([0], c.Driving); // the waiting ones stand: no positions asked

        clock.Advance(TimeSpan.FromMilliseconds(100));
        // The aircraft has passed truck 1 (170 m): it starts now.
        var next = Run(c, Rolling(200, 110));
        Assert.Equal([1, 1, 1], next.Select(x => x.Slot));
        Assert.Equal(RescueActionKind.Move, next[2].Kind);
        Assert.Equal([0, 1], c.Driving);

        clock.Advance(TimeSpan.FromMilliseconds(400));
        var all = Run(c, Rolling(400, 100)); // the update for 0 and 1, then 2 and 3 start
        Assert.Equal([0, 1], all.Take(2).Select(x => x.Slot));
        Assert.All(all.Take(2), x => Assert.Equal(RescueActionKind.Move, x.Kind));
        Assert.Equal([2, 2, 2, 3, 3, 3], all.Skip(2).Select(x => x.Slot));
        Assert.Equal([0, 1, 2, 3], c.Driving);
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
        Assert.Empty(Run(c, Rolling(0, 0)));
        Assert.Equal(RescueStage.Staged, c.Stage);
        Assert.Equal(2, lines.Count); // one line per change, none while nothing changes
        Assert.Contains("stage Staged", lines[0]);
        Assert.Contains("airborne since staged False", lines[0]);
        Assert.Contains("stands True", lines[1]);

        // Up and down again (a slew "touchdown"): all 4 wait (they are ahead), then the stop sends them to the circle.
        Run(c, OnFinal(0.1));
        Touchdown(c, clock, 0, 0);
        Assert.Equal(RescueStage.Trailing, c.Stage);
        clock.Advance(TimeSpan.FromSeconds(2));
        var circle = Run(c, Rolling(0, 0));
        Assert.Equal(4, circle.Count(x => x.Kind == RescueActionKind.Move && x.SpeedKt > 0));
        Assert.DoesNotContain(circle, x => x.Kind == RescueActionKind.Move && x.SpeedKt == 0); // standing: no halt route
        Assert.Contains(lines, l => l.Contains("stage Trailing") && l.Contains("waiting 4"));
        Assert.Contains(lines, l => l.Contains("the aircraft stands, trucks drive to the circle"));
        Assert.Contains(lines, l => l.Contains("stage Encircle"));
    }

    [Fact]
    public void A_bounce_neither_lands_nor_goes_around()
    {
        var (c, clock) = New();
        c.Start(Req());
        Run(c, OnFinal(10));
        // Ground contact shorter than 1 s: no touchdown.
        Assert.Empty(Run(c, Rolling(400, 130)));
        clock.Advance(TimeSpan.FromMilliseconds(500));
        Assert.Empty(Run(c, OnFinal(0)));
        Assert.Equal(RescueStage.Staged, c.Stage);
        // A real touchdown, then a bounce of 3 s: still following, no new turns.
        Touchdown(c, clock, 500, 120);
        Assert.Equal(RescueStage.Trailing, c.Stage);
        clock.Advance(TimeSpan.FromMilliseconds(400));
        Assert.Empty(Run(c, OnFinal(0)));
        clock.Advance(TimeSpan.FromSeconds(3));
        Assert.Empty(Run(c, OnFinal(0)));
        Assert.Equal(RescueStage.Trailing, c.Stage);
        clock.Advance(TimeSpan.FromMilliseconds(400));
        Assert.All(Run(c, Rolling(700, 110)), x => Assert.Equal(RescueActionKind.Move, x.Kind));
    }

    [Fact]
    public void Standby_waits_and_never_moves()
    {
        var (c, clock) = New();
        c.Start(Req(full: false));
        Run(c, OnFinal(10));
        Run(c, OnFinal(0.2));
        Assert.Empty(Touchdown(c, clock, 500, 120)); // no Simulate, no Move: they keep standing
        Assert.Equal(RescueStage.Staged, c.Stage);
        Run(c, Rolling(1500, 0));
        clock.Advance(TimeSpan.FromSeconds(3));
        Assert.Empty(Run(c, Rolling(1500, 0))); // stopped: no circle
        Assert.Equal(RescueStage.Encircle, c.Stage);
        clock.Advance(RescueController.StayAfterStop);
        Assert.Equal(4, Run(c, Rolling(1500, 0)).Count(x => x.Kind == RescueActionKind.Remove));
    }

    [Fact]
    public void Pan_then_mayday_keeps_the_staged_trucks_and_lets_them_follow()
    {
        var (c, clock) = New();
        c.Start(Req(full: false));
        Assert.Equal(4, Run(c, OnFinal(10)).Count);
        c.Start(Req(full: true));
        Assert.Empty(Run(c, OnFinal(5))); // same trucks, nothing created or removed
        Assert.Equal(4, Touchdown(c, clock, 400, 100).Count(x => x.Kind == RescueActionKind.Move));
    }

    [Fact]
    public void A_go_around_after_5_s_in_the_air_halts_them_again()
    {
        var (c, clock) = New();
        c.Start(Req());
        Run(c, OnFinal(10));
        Touchdown(c, clock, 400, 100);
        Assert.Empty(Run(c, OnFinal(0.5)));
        clock.Advance(RescueController.GoAroundAfter);
        var up = Run(c, OnFinal(0.5));
        Assert.Equal(RescueStage.Staged, c.Stage);
        Assert.Equal(Enumerable.Range(0, 4).SelectMany(i => new[] { i, i }), up.Select(x => x.Slot));
        Assert.Equal(Enumerable.Repeat(HaltKinds, 4).SelectMany(k => k), up.Select(x => x.Kind));
        Assert.All(up.Where(x => x.Kind == RescueActionKind.Move), x => Assert.Equal(0, x.SpeedKt));
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
    public void Ambulance_not_far_from_the_landing_airport()
    {
        var (c, clock) = New();
        c.Start(Req(fire: [], medic: ["Van Asia High Roof Medic"]));
        var far = new RescueAircraft(ThrLat + 1, ThrLon, 0, 0, true, true);
        Run(c, far);
        clock.Advance(TimeSpan.FromSeconds(3));
        Assert.Empty(Run(c, far));
    }

    [Fact]
    public void Reads_the_command_arguments()
    {
        var args = new Dictionary<string, JsonValue>
        {
            ["level"] = JsonValue.Create("standby"), ["thrLat"] = JsonValue.Create(50.04), ["thrLon"] = JsonValue.Create(8.59),
            ["hdg"] = JsonValue.Create(250.0), ["lengthM"] = JsonValue.Create(4000.0),
            ["fire"] = JsonValue.Create("A|B"), ["medic"] = JsonValue.Create(""),
        };
        var r = RescueRequest.FromArgs(args);
        Assert.False(r.Full);
        Assert.Equal(["A", "B"], r.Fire);
        Assert.Empty(r.Medic);
    }
}

public class RescueCommandTests
{
    private static (SimCommand? Command, string? Id, CommandResult? Error) Parse(string command, string args) =>
        CommandCatalog.Parse($$"""{"type":"command","id":"r1","command":"{{command}}","args":{{args}}}""");

    private const string Ok =
        """{"level":"full","thrLat":50.04,"thrLon":8.59,"hdg":250,"lengthM":4000,"fire":"ASO_Firetruck02|Truck Fire Short","medic":""}""";

    [Fact]
    public void Rescue_commands_are_whitelisted()
    {
        Assert.Null(Parse("rescue_start", Ok).Error);
        Assert.Null(Parse("rescue_start", Ok.Replace("\"medic\":\"\"", "\"medic\":\"Car Bush Medic\"")).Error);
        Assert.Null(Parse("rescue_start",
            """{"level":"medical","thrLat":0,"thrLon":0,"hdg":0,"lengthM":1,"fire":"","medic":"Truck Utility NorthAm Medic"}""").Error);
        Assert.Null(Parse("rescue_stop", "{}").Error);

        string? Why(string args) => Parse("rescue_start", args).Error?.Detail;
        Assert.Matches("level", Why(Ok.Replace("\"full\"", "\"huge\""))!);
        Assert.Matches("thrLat", Why(Ok.Replace("50.04", "91"))!);
        Assert.Matches("thrLon", Why(Ok.Replace("8.59", "\"8\""))!);
        Assert.Matches("hdg", Why(Ok.Replace("250", "360"))!);
        Assert.Matches("lengthM", Why(Ok.Replace("4000", "0"))!);
        Assert.Matches("empty title", Why(Ok.Replace("Truck Fire Short", ""))!);
        Assert.Matches("empty title", Why(Ok.Replace("|Truck", "| Truck"))!);
        Assert.Matches("at most 8", Why(Ok.Replace("\"fire\":\"ASO_Firetruck02|Truck Fire Short\"", "\"fire\":\"a|b|c|d|e|f|g|h|i\""))!);
        Assert.Matches("no fire trucks", Why(Ok.Replace("\"full\"", "\"medical\""))!);
        Assert.Matches("only", Why("""{"level":"full"}""")!);
        Assert.Equal(CommandErrors.BadArgs, Parse("rescue_stop", """{"x":1}""").Error?.Error);
    }
}
