namespace AcarsBridge;

/// <summary>What the app asked for with <c>rescue_start</c> (T54).</summary>
/// <param name="Full">Fire trucks follow the aircraft and surround it (<c>full</c>); false = they wait (<c>standby</c>).</param>
/// <param name="Fire">SimObject titles of the fire trucks, one per truck; empty for <c>medical</c>.</param>
/// <param name="Medic">Title of the ambulance; empty = none.</param>
public sealed record RescueRequest(
    bool Full, double ThrLat, double ThrLon, double Hdg, double LengthM,
    IReadOnlyList<string> Fire, IReadOnlyList<string> Medic)
{
    /// <summary>
    /// Arguments of <c>rescue_start</c> already checked by <see cref="CommandCatalog"/>: <c>level</c>, <c>thrLat</c>,
    /// <c>thrLon</c>, <c>hdg</c>, <c>lengthM</c>, <c>fire</c> and <c>medic</c> (titles joined by <c>|</c>).
    /// </summary>
    public static RescueRequest FromArgs(IReadOnlyDictionary<string, System.Text.Json.Nodes.JsonValue> args)
    {
        static string[] Titles(string s) => s.Length == 0 ? [] : s.Split('|');
        return new(
            args["level"].GetValue<string>() == "full",
            args["thrLat"].GetValue<double>(), args["thrLon"].GetValue<double>(),
            args["hdg"].GetValue<double>(), args["lengthM"].GetValue<double>(),
            Titles(args["fire"].GetValue<string>()), Titles(args["medic"].GetValue<string>()));
    }

    /// <summary>Same trucks at the same runway: only the level may differ.</summary>
    public bool SameFire(RescueRequest o) =>
        ThrLat == o.ThrLat && ThrLon == o.ThrLon && Hdg == o.Hdg && Fire.SequenceEqual(o.Fire, StringComparer.Ordinal);

    public bool SameMedic(RescueRequest o) =>
        ThrLat == o.ThrLat && ThrLon == o.ThrLon && Medic.SequenceEqual(o.Medic, StringComparer.Ordinal);
}

/// <summary>The user's aircraft, as the rescue vehicles need it.</summary>
public readonly record struct RescueAircraft(double Lat, double Lon, double HdgDeg, double GsKt, bool OnGround, bool ParkingBrake);


public enum RescueActionKind
{
    /// <summary>
    /// Create <see cref="RescueAction.Title"/> at the point, facing <see cref="RescueAction.Hdg"/>. The sim thread
    /// sets that heading again and <c>SIM DISABLED</c> = 1 once the object has an id (MSFS 2024, seen by a human
    /// 2026-10-17: the heading of the creation was not kept, and a new object rolls away).
    /// </summary>
    Spawn,
    /// <summary>Remove the object of the slot.</summary>
    Remove,
    /// <summary>Send the object of the slot along <see cref="RescueAction.Route"/> at <see cref="RescueAction.SpeedKt"/> (<c>AI WAYPOINT LIST</c>).</summary>
    Move,
    /// <summary>Turn the object's own simulation on (<see cref="RescueAction.On"/>) or off: <c>SIM DISABLED</c> 0 / 1.</summary>
    Simulate,
    /// <summary>Set the object's heading to <see cref="RescueAction.Hdg"/> (<c>PLANE HEADING DEGREES TRUE</c>); only while it stands.</summary>
    Turn,
}

/// <summary>One thing the sim thread does for a vehicle. Slots 0..7 are fire trucks, <see cref="RescueController.MedicSlot"/> the ambulance.</summary>
public readonly record struct RescueAction(
    RescueActionKind Kind, int Slot, string Title, double Lat, double Lon, double Hdg, double SpeedKt,
    (double Lat, double Lon)[]? Route = null, bool On = false)
{
    public static RescueAction Sim(int slot, bool on) => new(RescueActionKind.Simulate, slot, "", 0, 0, 0, 0, On: on);
    public static RescueAction TurnTo(int slot, double hdg) => new(RescueActionKind.Turn, slot, "", 0, 0, hdg, 0);
    public static RescueAction Go(int slot, (double Lat, double Lon)[] route, double kt) =>
        new(RescueActionKind.Move, slot, "", route[0].Lat, route[0].Lon, 0, kt, route);
}

/// <summary>Where the fire trucks are in their work.</summary>
public enum RescueStage
{
    /// <summary>Nothing in the sim: no request, or the aircraft is far.</summary>
    Idle,
    /// <summary>Trucks wait beside the runway.</summary>
    Staged,
    /// <summary><c>full</c> only: after touchdown they follow the aircraft.</summary>
    Trailing,
    /// <summary>The aircraft stopped: <c>full</c> trucks surround it, <c>standby</c> ones stay; removed after <see cref="RescueController.StayAfterStop"/>.</summary>
    Encircle,
    /// <summary>Work over for this request: removed and not created again.</summary>
    Done,
}

/// <summary>
/// Decides when the rescue vehicles of T54 exist in the sim and where they go; no SimConnect here, the sim thread
/// carries out the returned <see cref="RescueAction"/>s. Fire trucks are created when the aircraft comes within
/// <see cref="StageNm"/> of the landing threshold, beside the runway; with <c>full</c> they follow the aircraft
/// after touchdown and surround it once it stands; they are removed <see cref="StayAfterStop"/> after the stop,
/// on <c>rescue_stop</c>, beyond <see cref="RemoveNm"/> (a go-around; created again when near) and with the sim
/// session (created again in the next one while the request stands). The ambulance appears beside the aircraft once
/// it is parked near the landing airport, and is created again beside it at a later parked stop more than
/// <see cref="MedicMovedM"/> away (no route: removed and created anew). Geometry and timings are the ERoD mod's (docs/07 T54 p. 8), the rest are
/// game rules approved by the user (2026-10-17):
/// <list type="bullet">
/// <item>a vehicle's own simulation is off (<c>SIM DISABLED</c>) while it stands — created vehicles otherwise roll
/// away — and on while it drives: from touchdown until it reaches its point on the circle (within
/// <see cref="ArrivedM"/>, or after <see cref="CircleDriveMax"/>);</item>
/// <item>before each route a truck is turned, standing, toward its first point, so the AI does not back up to it;</item>
/// <item>at touchdown a truck ahead of the aircraft (along its heading) keeps standing until the aircraft has passed
/// it, then follows;</item>
/// <item>following trucks get two waypoints, so their target is never the last one (MSFS 2024 slows ground vehicles
/// to a crawl on the last waypoint);</item>
/// <item>to the circle a truck goes straight when that line passes at least <see cref="ClearM"/> from the aircraft,
/// else around it on an arc of <see cref="DetourM"/> in steps of at most <see cref="DetourStepDeg"/>, the short way;
/// it has until <see cref="ArrivalLimit"/> of its route to get there;</item>
/// <item>touchdown only after <see cref="TouchdownAfter"/> on the ground without a break, back to waiting only after
/// <see cref="GoAroundAfter"/> in the air (a bounce or a slew does not restart the trucks);</item>
/// <item>a driving truck is stopped by a one-point route at its last known place at 0 kt before its simulation goes
/// off: <c>SIM DISABLED</c> alone holds a vehicle without a route, not one that follows a waypoint list (seen by a
/// human 2026-10-17).</item>
/// </list>
/// Thread-safe: commands arrive on a network thread, positions on the SimConnect thread. <paramref name="log"/> gets a
/// line on every change of the stage or of what the controller sees (on the ground, airborne since staging, stands,
/// trucks waiting) and on the events of the trucks (diagnostics for the human check, 2026-10-17).
/// </summary>
public sealed class RescueController(TimeProvider clock, Action<string>? log = null)
{
    public const int MaxFire = 8;
    public const int MedicSlot = MaxFire;

    public const double StageNm = 15;
    public const double RemoveNm = 30;
    public static readonly TimeSpan StayAfterStop = TimeSpan.FromMinutes(10);
    /// <summary>"Stands": slower than <see cref="StopKt"/> for this long.</summary>
    public static readonly TimeSpan StopAfter = TimeSpan.FromSeconds(2);
    public const double StopKt = 1;
    /// <summary>How often a following truck gets a new waypoint.</summary>
    public static readonly TimeSpan MoveEvery = TimeSpan.FromMilliseconds(350);

    /// <summary>Waiting trucks: off the runway axis (right of the landing direction), m.</summary>
    public const double StageSideM = 45;
    /// <summary>Between waiting trucks, m.</summary>
    public const double StageGapM = 70;
    /// <summary>First waiting truck past the threshold, m.</summary>
    public const double StageFromThresholdM = 100;
    /// <summary>Following: truck i is (i + 1) × this behind the aircraft, m.</summary>
    public const double TrailM = 25;
    public const double CircleM = 50;
    /// <summary>Ambulance: left of the aircraft, m.</summary>
    public const double MedicSideM = 30;
    /// <summary>The aircraft parks again this far from the ambulance: it is created anew beside the aircraft, m.</summary>
    public const double MedicMovedM = 100;
    /// <summary>Following speed: the aircraft's plus this, within <see cref="MinTrailKt"/>..<see cref="MaxTrailKt"/>.</summary>
    public const double TrailExtraKt = 10, MinTrailKt = 20, MaxTrailKt = 60;
    /// <summary>Speed to the points of the circle.</summary>
    public const double CircleKt = 30;
    /// <summary>Following: the second waypoint, past the target along the aircraft heading, m.</summary>
    public const double TrailAheadM = 30;
    /// <summary>A truck this close to its point on the circle has arrived: its simulation goes off, m.</summary>
    public const double ArrivedM = 5;

    /// <summary>To the circle: straight when the line passes at least this far from the aircraft, m.</summary>
    public const double ClearM = 40;
    /// <summary>Otherwise around the aircraft on an arc of this radius, m, in steps of at most <see cref="DetourStepDeg"/>.</summary>
    public const double DetourM = 80;
    public const double DetourStepDeg = 45;
    /// <summary>On the ground without a break this long: a touchdown.</summary>
    public static readonly TimeSpan TouchdownAfter = TimeSpan.FromSeconds(1);
    /// <summary>In the air without a break this long after touchdown: a go-around, the trucks wait again.</summary>
    public static readonly TimeSpan GoAroundAfter = TimeSpan.FromSeconds(5);
    /// <summary>Speed the arrival limit counts with, m/s (about <see cref="CircleKt"/>).</summary>
    public const double ArrivalMps = 15;
    public static readonly TimeSpan ArrivalExtra = TimeSpan.FromSeconds(15);
    public static readonly TimeSpan ArrivalMax = TimeSpan.FromSeconds(120);

    private readonly object _gate = new();
    private RescueRequest? _req;

    /// <summary>The request the trucks / the ambulance serve; another one starts them anew.</summary>
    private RescueRequest? _fireFor, _medicFor;

    private RescueStage _stage;
    /// <summary>Fire slots that stand in the sim (or are being created).</summary>
    private int _fireSpawned;
    /// <summary>Airborne since the trucks were staged: the next ground contact is the touchdown.</summary>
    private bool _airborne;
    private DateTimeOffset? _slowSince;
    /// <summary>Since when the aircraft is on the ground / in the air without a break.</summary>
    private DateTimeOffset? _groundSince, _airSince;
    private DateTimeOffset? _stoppedAt;
    private DateTimeOffset _lastMove;

    /// <summary>Where each truck is: its waiting place, then the positions the sim reports while it drives.</summary>
    private readonly (double Lat, double Lon)?[] _pos = new (double, double)?[MaxFire];
    /// <summary>Trucks that were ahead of the aircraft at touchdown and still wait for it to pass.</summary>
    private readonly bool[] _waiting = new bool[MaxFire];
    /// <summary>Points on the circle of the trucks still driving there, and until when each may drive.</summary>
    private readonly (double Lat, double Lon)?[] _circle = new (double, double)?[MaxFire];
    private readonly DateTimeOffset[] _circleUntil = new DateTimeOffset[MaxFire];

    private bool _medicSpawned;
    private bool _medicDone;
    private DateTimeOffset _medicAt;
    private (double Lat, double Lon) _medicPos;

    private readonly List<RescueAction> _out = [];
    /// <summary>What was last logged as the state (<see cref="Trace"/>).</summary>
    private string? _traced;

    private void Log(string line) => log?.Invoke(line);

    public RescueStage Stage
    {
        get { lock (_gate) return _stage; }
    }

    public bool Active
    {
        get { lock (_gate) return _req is not null || _fireSpawned > 0 || _medicSpawned; }
    }

    /// <summary>Slots of trucks that drive now (following, or on the way to the circle): their positions are wanted.</summary>
    public IReadOnlyList<int> Driving
    {
        get
        {
            lock (_gate)
            {
                var list = new List<int>();
                for (var i = 0; i < _fireSpawned; i++)
                    if ((_stage == RescueStage.Trailing && !_waiting[i]) || _circle[i] is not null) list.Add(i);
                return list;
            }
        }
    }

    /// <summary>Where a driving truck is now (sim thread).</summary>
    public void VehiclePosition(int slot, double lat, double lon)
    {
        lock (_gate)
        {
            if (slot >= 0 && slot < _fireSpawned) _pos[slot] = (lat, lon);
        }
    }

    /// <summary>
    /// A new request replaces the old one. Trucks that already stand for the same runway and titles stay where they
    /// are (PAN → MAYDAY only raises the level); others are removed on the next position.
    /// </summary>
    public void Start(RescueRequest req)
    {
        lock (_gate) _req = req;
    }

    public void Stop()
    {
        lock (_gate) _req = null;
    }

    /// <summary>The sim session ended: the objects are gone with it, the request stays for the next session.</summary>
    public void SessionEnded()
    {
        lock (_gate)
        {
            _fireSpawned = 0;
            _medicSpawned = false;
            if (_stage != RescueStage.Done) _stage = RescueStage.Idle;
            _airborne = false;
            _slowSince = null;
            _groundSince = _airSince = null;
            _stoppedAt = null;
            Array.Clear(_pos);
            Array.Clear(_circle);
            Array.Clear(_waiting);
        }
    }

    /// <summary>Called with every aircraft position; returns what to do now (the list is reused by the next call).</summary>
    public IReadOnlyList<RescueAction> OnPosition(RescueAircraft a)
    {
        lock (_gate)
        {
            _out.Clear();
            var now = clock.GetUtcNow();
            TrackStop(a, now);
            Fire(a, now);
            Medic(a, now);
            Trace(a, now);
            return _out;
        }
    }

    private void TrackStop(RescueAircraft a, DateTimeOffset now)
    {
        if (!a.OnGround || a.GsKt >= StopKt) _slowSince = null;
        else _slowSince ??= now;
        if (a.OnGround)
        {
            _groundSince ??= now;
            _airSince = null;
        }
        else
        {
            _airSince ??= now;
            _groundSince = null;
        }
    }

    private bool Landed(DateTimeOffset now) => _groundSince is { } g && now - g >= TouchdownAfter;
    private bool WentAround(DateTimeOffset now) => _airSince is { } t && now - t >= GoAroundAfter;

    /// <summary>
    /// Stops a driving truck: a one-point route at its last known place at 0 kt, then its simulation off (approved
    /// 2026-10-17; whether the sim then holds it is a human check).
    /// </summary>
    private void Halt(int i, (double Lat, double Lon) fallback)
    {
        _out.Add(RescueAction.Go(i, [_pos[i] ?? fallback], 0));
        _out.Add(RescueAction.Sim(i, false));
    }

    /// <summary>One line whenever the stage or what decides it changes.</summary>
    private void Trace(RescueAircraft a, DateTimeOffset now)
    {
        if (log is null || (_req is null && _fireSpawned == 0)) return;
        var waiting = _waiting.Count(w => w);
        var state =
            $"rescue stage {_stage}, trucks {_fireSpawned}, on ground {a.OnGround}, airborne since staged {_airborne}, " +
            $"stands {Stands(now)}, waiting {waiting}, level {(_req?.Full == true ? "full" : _req is null ? "-" : "standby")}";
        if (state == _traced) return;
        _traced = state;
        Log($"{state} (gs {a.GsKt:0.0} kt)");
    }

    private bool Stands(DateTimeOffset now) => _slowSince is { } s && now - s >= StopAfter;

    private void Fire(RescueAircraft a, DateTimeOffset now)
    {
        var req = _req;
        if (_fireFor is not null && (req is null || !_fireFor.SameFire(req)))
        {
            RemoveFire();
            _stage = RescueStage.Idle;
            _fireFor = null;
        }
        if (req is null) return;
        _fireFor = req; // the level may have changed
        if (req.Fire.Count == 0 || _stage == RescueStage.Done) return;

        var nm = SmokeController.DistanceNm(a.Lat, a.Lon, req.ThrLat, req.ThrLon);
        if (_stage != RescueStage.Idle && nm > RemoveNm)
        {
            RemoveFire();
            _stage = RescueStage.Idle;
            return;
        }
        switch (_stage)
        {
            case RescueStage.Idle:
                if (nm > StageNm) return;
                var n = Math.Min(req.Fire.Count, MaxFire);
                for (var i = 0; i < n; i++)
                {
                    var (lat, lon) = StagePoint(req, i);
                    _out.Add(new(RescueActionKind.Spawn, i, req.Fire[i], lat, lon, Norm(req.Hdg - 90), 0));
                    _pos[i] = (lat, lon);
                }
                _fireSpawned = n;
                _stage = RescueStage.Staged;
                _airborne = !a.OnGround;
                _stoppedAt = null;
                return;
            case RescueStage.Staged:
                if (!a.OnGround) _airborne = true;
                else if (_airborne && req.Full && Landed(now))
                {
                    // Touchdown: trucks the aircraft has passed start to follow; those ahead wait for it.
                    _stage = RescueStage.Trailing;
                    _lastMove = now;
                    for (var i = 0; i < _fireSpawned; i++) _waiting[i] = true;
                    StartFollowing(a);
                    return;
                }
                if (_airborne && Stands(now)) Stopped(a, req, now);
                return;
            case RescueStage.Trailing:
                if (WentAround(now))
                {
                    // A touch-and-go or go-around: back to waiting until the next touchdown, standing.
                    _stage = RescueStage.Staged;
                    for (var i = 0; i < _fireSpawned; i++)
                        if (!_waiting[i]) Halt(i, StagePoint(req, i));
                    Array.Clear(_waiting);
                    return;
                }
                if (!a.OnGround) return; // a bounce: wait and see
                if (Stands(now))
                {
                    Stopped(a, req, now);
                    return;
                }
                if (now - _lastMove >= MoveEvery)
                {
                    _lastMove = now;
                    var kt = TrailKt(a);
                    for (var i = 0; i < _fireSpawned; i++)
                        if (!_waiting[i]) _out.Add(RescueAction.Go(i, TrailRoute(a, i), kt));
                }
                StartFollowing(a); // after the update: a truck that starts now gets its first route once
                return;
            case RescueStage.Encircle:
                if (_stoppedAt is { } t && now - t >= StayAfterStop)
                {
                    RemoveFire();
                    _stage = RescueStage.Done;
                    return;
                }
                for (var i = 0; i < MaxFire; i++)
                {
                    if (_circle[i] is not { } c) continue;
                    var arrived = _pos[i] is { } p && Meters(p, c) <= ArrivedM;
                    if (!arrived && now < _circleUntil[i]) continue;
                    Halt(i, c);
                    _circle[i] = null;
                    Log($"rescue slot {i}: {(arrived ? "arrived on the circle" : "stops (its time to get there is up)")}");
                }
                return;
        }
    }

    /// <summary>
    /// Waiting trucks the aircraft has passed (no longer ahead of it along its heading) turn, standing, toward their
    /// place behind it, then drive.
    /// </summary>
    private void StartFollowing(RescueAircraft a)
    {
        var kt = TrailKt(a);
        for (var i = 0; i < _fireSpawned; i++)
        {
            if (!_waiting[i] || (_pos[i] is { } p && AheadM(a, p) > 0)) continue;
            _waiting[i] = false;
            Log($"rescue slot {i}: follows (the aircraft has passed it or it was behind)");
            var route = TrailRoute(a, i);
            _out.Add(RescueAction.TurnTo(i, Bearing(_pos[i], route[0])));
            _out.Add(RescueAction.Sim(i, true));
            _out.Add(RescueAction.Go(i, route, kt));
        }
    }

    /// <summary>How far a point is ahead of the aircraft along its heading, m (negative = behind).</summary>
    public static double AheadM(RescueAircraft a, (double Lat, double Lon) p) =>
        Meters((a.Lat, a.Lon), p) * Math.Cos((Bearing((a.Lat, a.Lon), p) - a.HdgDeg) * Math.PI / 180);

    private static double TrailKt(RescueAircraft a) => Math.Clamp(a.GsKt + TrailExtraKt, MinTrailKt, MaxTrailKt);

    /// <summary>Following truck <paramref name="i"/>: its place behind the aircraft and a point past it.</summary>
    private static (double Lat, double Lon)[] TrailRoute(RescueAircraft a, int i)
    {
        var target = Offset(a.Lat, a.Lon, a.HdgDeg + 180, TrailM * (i + 1));
        return [target, Offset(target.Lat, target.Lon, a.HdgDeg, TrailAheadM)];
    }

    /// <summary>
    /// The aircraft stands after landing: <c>full</c> trucks stop, turn toward the first point of their way to the
    /// circle and drive there; all wait for the removal.
    /// </summary>
    private void Stopped(RescueAircraft a, RescueRequest req, DateTimeOffset now)
    {
        _stage = RescueStage.Encircle;
        _stoppedAt = now;
        Log($"rescue: the aircraft stands, {(req.Full ? "trucks drive to the circle" : "standby trucks stay")}");
        if (!req.Full) return;
        for (var i = 0; i < _fireSpawned; i++)
        {
            var target = CirclePoint(a, i, _fireSpawned);
            var from = _pos[i] ?? Offset(a.Lat, a.Lon, a.HdgDeg + 180, TrailM * (i + 1));
            var route = CircleRoute(a, from, target);
            var limit = ArrivalLimit(from, route);
            Log($"rescue slot {i}: to the circle, {route.Length} waypoint(s), {limit.TotalSeconds:0} s");
            if (_waiting[i]) _out.Add(RescueAction.Sim(i, false)); // standing already
            else Halt(i, from);
            _out.Add(RescueAction.TurnTo(i, Bearing(from, route[0])));
            _out.Add(RescueAction.Sim(i, true));
            _out.Add(RescueAction.Go(i, route, CircleKt));
            _circle[i] = target;
            _circleUntil[i] = now + limit;
        }
        Array.Clear(_waiting);
    }

    /// <summary>
    /// How long a truck may take along <paramref name="route"/> from <paramref name="from"/>: its length at
    /// <see cref="ArrivalMps"/>, twice, plus <see cref="ArrivalExtra"/>, at most <see cref="ArrivalMax"/>.
    /// </summary>
    public static TimeSpan ArrivalLimit((double Lat, double Lon) from, (double Lat, double Lon)[] route)
    {
        var m = 0.0;
        var at = from;
        foreach (var q in route)
        {
            m += Meters(at, q);
            at = q;
        }
        var t = TimeSpan.FromSeconds(m / ArrivalMps * 2) + ArrivalExtra;
        return t < ArrivalMax ? t : ArrivalMax;
    }

    private void Medic(RescueAircraft a, DateTimeOffset now)
    {
        var req = _req;
        if (_medicFor is not null && (req is null || !_medicFor.SameMedic(req)))
        {
            if (_medicSpawned) _out.Add(new(RescueActionKind.Remove, MedicSlot, "", 0, 0, 0, 0));
            _medicSpawned = false;
            _medicDone = false;
            _medicFor = null;
        }
        if (req is null) return;
        _medicFor = req;
        if (req.Medic.Count == 0) return;
        var nm = SmokeController.DistanceNm(a.Lat, a.Lon, req.ThrLat, req.ThrLon);
        var parked = nm <= StageNm && a.ParkingBrake && Stands(now);
        if (_medicSpawned)
        {
            if (nm > RemoveNm || now - _medicAt >= StayAfterStop)
            {
                _out.Add(new(RescueActionKind.Remove, MedicSlot, "", 0, 0, 0, 0));
                _medicSpawned = false;
                _medicDone = now - _medicAt >= StayAfterStop;
                return;
            }
            // Parked again elsewhere (a stop on the runway, then the gate): the ambulance comes along (approved 2026-10-17).
            if (!parked || Meters((a.Lat, a.Lon), _medicPos) <= MedicMovedM) return;
            _out.Add(new(RescueActionKind.Remove, MedicSlot, "", 0, 0, 0, 0));
            _medicSpawned = false;
            Log("rescue slot 8: the aircraft parked elsewhere, the ambulance is created beside it again");
        }
        if (_medicDone || !parked) return;
        var (lat, lon) = Offset(a.Lat, a.Lon, a.HdgDeg - 90, MedicSideM);
        _out.Add(new(RescueActionKind.Spawn, MedicSlot, req.Medic[0], lat, lon, Norm(a.HdgDeg), 0));
        _medicSpawned = true;
        _medicAt = now;
        _medicPos = (lat, lon);
    }

    private void RemoveFire()
    {
        for (var i = 0; i < _fireSpawned; i++) _out.Add(new(RescueActionKind.Remove, i, "", 0, 0, 0, 0));
        _fireSpawned = 0;
        Array.Clear(_pos);
        Array.Clear(_circle);
        Array.Clear(_waiting);
    }

    /// <summary>Waiting place of truck <paramref name="i"/>: along the runway from the threshold, then right of it.</summary>
    public static (double Lat, double Lon) StagePoint(RescueRequest r, int i)
    {
        var (lat, lon) = Offset(r.ThrLat, r.ThrLon, r.Hdg, StageFromThresholdM + StageGapM * i);
        return Offset(lat, lon, r.Hdg + 90, StageSideM);
    }

    /// <summary>Point <paramref name="i"/> of <paramref name="n"/> on the circle around the aircraft, the first at its nose.</summary>
    public static (double Lat, double Lon) CirclePoint(RescueAircraft a, int i, int n) =>
        Offset(a.Lat, a.Lon, a.HdgDeg + 360.0 * i / Math.Max(1, n), CircleM);

    /// <summary>
    /// From <paramref name="from"/> to <paramref name="target"/> on the circle: straight when the line passes at least
    /// <see cref="ClearM"/> from the aircraft, else on the <see cref="DetourM"/> arc from the truck's bearing to the
    /// target's, the short way, in equal steps of at most <see cref="DetourStepDeg"/>, then the target.
    /// </summary>
    public static (double Lat, double Lon)[] CircleRoute(RescueAircraft a, (double Lat, double Lon) from, (double Lat, double Lon) target)
    {
        var ac = (a.Lat, a.Lon);
        if (SegmentDistanceM(ac, from, target) >= ClearM) return [target];
        var b0 = Bearing(ac, from);
        var d = ((Bearing(ac, target) - b0 + 540) % 360) - 180; // -180..180, the short way
        var steps = Math.Max(1, (int)Math.Ceiling(Math.Abs(d) / DetourStepDeg));
        var route = new (double Lat, double Lon)[steps + 2];
        for (var k = 0; k <= steps; k++) route[k] = Offset(a.Lat, a.Lon, b0 + d * k / steps, DetourM);
        route[steps + 1] = target;
        return route;
    }

    /// <summary>Shortest distance from <paramref name="p"/> to the segment a–b, m (local flat projection around p).</summary>
    public static double SegmentDistanceM((double Lat, double Lon) p, (double Lat, double Lon) a, (double Lat, double Lon) b)
    {
        const double M = 1852 * 60; // m per degree of latitude
        var k = Math.Cos(p.Lat * Math.PI / 180);
        double X((double Lat, double Lon) q) => (q.Lon - p.Lon) * M * k;
        double Y((double Lat, double Lon) q) => (q.Lat - p.Lat) * M;
        var (ax, ay, bx, by) = (X(a), Y(a), X(b), Y(b));
        var (dx, dy) = (bx - ax, by - ay);
        var len2 = dx * dx + dy * dy;
        var t = len2 == 0 ? 0 : Math.Clamp(-(ax * dx + ay * dy) / len2, 0, 1);
        var (cx, cy) = (ax + t * dx, ay + t * dy);
        return Math.Sqrt(cx * cx + cy * cy);
    }

    /// <summary>True course from one point to another, degrees 0..360; 0 when either is unknown.</summary>
    public static double Bearing((double Lat, double Lon)? from, (double Lat, double Lon) to)
    {
        if (from is not { } f) return 0;
        static double Rad(double d) => d * Math.PI / 180;
        var (p1, p2, dl) = (Rad(f.Lat), Rad(to.Lat), Rad(to.Lon - f.Lon));
        var y = Math.Sin(dl) * Math.Cos(p2);
        var x = Math.Cos(p1) * Math.Sin(p2) - Math.Sin(p1) * Math.Cos(p2) * Math.Cos(dl);
        return Norm(Math.Atan2(y, x) * 180 / Math.PI);
    }

    private static double Meters((double Lat, double Lon) a, (double Lat, double Lon) b) =>
        SmokeController.DistanceNm(a.Lat, a.Lon, b.Lat, b.Lon) * 1852;

    /// <summary>The point <paramref name="meters"/> from a point on a true course (sphere, mean Earth radius 6 371 008.8 m).</summary>
    public static (double Lat, double Lon) Offset(double lat, double lon, double courseDeg, double meters)
    {
        const double R = 6_371_008.8;
        static double Rad(double d) => d * Math.PI / 180;
        static double Deg(double r) => r * 180 / Math.PI;
        var d = meters / R;
        var (p1, l1, c) = (Rad(lat), Rad(lon), Rad(courseDeg));
        var p2 = Math.Asin(Math.Sin(p1) * Math.Cos(d) + Math.Cos(p1) * Math.Sin(d) * Math.Cos(c));
        var l2 = l1 + Math.Atan2(Math.Sin(c) * Math.Sin(d) * Math.Cos(p1), Math.Cos(d) - Math.Sin(p1) * Math.Sin(p2));
        return (Deg(p2), (Deg(l2) + 540) % 360 - 180);
    }

    public static double Norm(double deg) => ((deg % 360) + 360) % 360;
}
