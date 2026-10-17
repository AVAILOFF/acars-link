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
    /// <summary>Create <see cref="RescueAction.Title"/> at the point, facing <see cref="RescueAction.Hdg"/>.</summary>
    Spawn,
    /// <summary>Remove the object of the slot.</summary>
    Remove,
    /// <summary>Send the object of the slot to the point at <see cref="RescueAction.SpeedKt"/> (<c>AI WAYPOINT LIST</c>).</summary>
    Move,
}

/// <summary>One thing the sim thread does for a vehicle. Slots 0..7 are fire trucks, <see cref="RescueController.MedicSlot"/> the ambulance.</summary>
public readonly record struct RescueAction(RescueActionKind Kind, int Slot, string Title, double Lat, double Lon, double Hdg, double SpeedKt);

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
/// it is parked near the landing airport. Geometry and timings are the ERoD mod's (docs/07 T54 p. 8), the rest are
/// game rules approved by the user. Thread-safe: commands arrive on a network thread, positions on the SimConnect
/// thread.
/// </summary>
public sealed class RescueController(TimeProvider clock)
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
    /// <summary>Following speed: the aircraft's plus this, within <see cref="MinTrailKt"/>..<see cref="MaxTrailKt"/>.</summary>
    public const double TrailExtraKt = 10, MinTrailKt = 20, MaxTrailKt = 60;
    /// <summary>Speed to the points of the circle.</summary>
    public const double CircleKt = 30;

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
    private DateTimeOffset? _stoppedAt;
    private DateTimeOffset _lastMove;

    private bool _medicSpawned;
    private bool _medicDone;
    private DateTimeOffset _medicAt;

    private readonly List<RescueAction> _out = [];

    public RescueStage Stage
    {
        get { lock (_gate) return _stage; }
    }

    public bool Active
    {
        get { lock (_gate) return _req is not null || _fireSpawned > 0 || _medicSpawned; }
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
            _stoppedAt = null;
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
            return _out;
        }
    }

    private void TrackStop(RescueAircraft a, DateTimeOffset now)
    {
        if (!a.OnGround || a.GsKt >= StopKt) _slowSince = null;
        else _slowSince ??= now;
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
                }
                _fireSpawned = n;
                _stage = RescueStage.Staged;
                _airborne = !a.OnGround;
                _stoppedAt = null;
                return;
            case RescueStage.Staged:
                if (!a.OnGround) _airborne = true;
                else if (_airborne && req.Full)
                {
                    _stage = RescueStage.Trailing;
                    _lastMove = DateTimeOffset.MinValue;
                    goto case RescueStage.Trailing; // the first waypoint at touchdown
                }
                if (_airborne && Stands(now)) Stopped(a, req, now);
                return;
            case RescueStage.Trailing:
                if (!a.OnGround)
                {
                    // A touch-and-go: back to waiting until the next touchdown.
                    _stage = RescueStage.Staged;
                    return;
                }
                if (Stands(now))
                {
                    Stopped(a, req, now);
                    return;
                }
                if (now - _lastMove < MoveEvery) return;
                _lastMove = now;
                var kt = Math.Clamp(a.GsKt + TrailExtraKt, MinTrailKt, MaxTrailKt);
                for (var i = 0; i < _fireSpawned; i++)
                {
                    var (lat, lon) = Offset(a.Lat, a.Lon, a.HdgDeg + 180, TrailM * (i + 1));
                    _out.Add(new(RescueActionKind.Move, i, "", lat, lon, 0, kt));
                }
                return;
            case RescueStage.Encircle:
                if (_stoppedAt is { } t && now - t >= StayAfterStop)
                {
                    RemoveFire();
                    _stage = RescueStage.Done;
                }
                return;
        }
    }

    /// <summary>The aircraft stands after landing: <c>full</c> trucks drive to the circle, all wait for the removal.</summary>
    private void Stopped(RescueAircraft a, RescueRequest req, DateTimeOffset now)
    {
        _stage = RescueStage.Encircle;
        _stoppedAt = now;
        if (!req.Full) return;
        for (var i = 0; i < _fireSpawned; i++)
        {
            var (lat, lon) = CirclePoint(a, i, _fireSpawned);
            _out.Add(new(RescueActionKind.Move, i, "", lat, lon, 0, CircleKt));
        }
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
        if (_medicSpawned)
        {
            if (nm > RemoveNm || now - _medicAt >= StayAfterStop)
            {
                _out.Add(new(RescueActionKind.Remove, MedicSlot, "", 0, 0, 0, 0));
                _medicSpawned = false;
                _medicDone = now - _medicAt >= StayAfterStop;
            }
            return;
        }
        if (_medicDone || nm > StageNm || !a.ParkingBrake || !Stands(now)) return;
        var (lat, lon) = Offset(a.Lat, a.Lon, a.HdgDeg - 90, MedicSideM);
        _out.Add(new(RescueActionKind.Spawn, MedicSlot, req.Medic[0], lat, lon, Norm(a.HdgDeg), 0));
        _medicSpawned = true;
        _medicAt = now;
    }

    private void RemoveFire()
    {
        for (var i = 0; i < _fireSpawned; i++) _out.Add(new(RescueActionKind.Remove, i, "", 0, 0, 0, 0));
        _fireSpawned = 0;
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
