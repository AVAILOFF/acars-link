// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

namespace AcarsBridge;

/// <summary>What the app asked for with <c>rescue_start</c> (T54).</summary>
/// <param name="Full">Fire trucks follow the aircraft and surround it (<c>full</c>); false = they wait (<c>standby</c>).</param>
/// <param name="Fire">SimObject titles of the fire trucks, one per truck; empty for <c>medical</c>.</param>
/// <param name="Medic">Title of the ambulance; empty = none.</param>
/// <param name="Left">The trucks wait left of the runway (landing direction); else right. The app picks the upwind side.</param>
/// <param name="Flip">Per fire truck: its model is drawn nose to tail with its sim heading (turn it 180°); null = none.</param>
/// <param name="Ground">T88: called on the ground, the trucks come to the aircraft at once instead of waiting for a landing.</param>
public sealed record RescueRequest(
    bool Full, double ThrLat, double ThrLon, double Hdg, double LengthM,
    IReadOnlyList<string> Fire, IReadOnlyList<string> Medic, bool Left = false, IReadOnlyList<bool>? Flip = null,
    bool Ground = false)
{
    /// <summary>Truck <paramref name="i"/> is drawn reversed.</summary>
    public bool Flipped(int i) => Flip is { } f && i < f.Count && f[i];

    /// <summary>
    /// Arguments of <c>rescue_start</c> already checked by <see cref="CommandCatalog"/>: <c>level</c>, <c>thrLat</c>,
    /// <c>thrLon</c>, <c>hdg</c>, <c>lengthM</c>, <c>side</c>, <c>fire</c>, <c>fireFlip</c> and <c>medic</c> (joined by <c>|</c>).
    /// </summary>
    public static RescueRequest FromArgs(IReadOnlyDictionary<string, System.Text.Json.Nodes.JsonValue> args)
    {
        static string[] Titles(string s) => s.Length == 0 ? [] : s.Split('|');
        return new(
            args["level"].GetValue<string>() == "full",
            args["thrLat"].GetValue<double>(), args["thrLon"].GetValue<double>(),
            args["hdg"].GetValue<double>(), args["lengthM"].GetValue<double>(),
            Titles(args["fire"].GetValue<string>()), Titles(args["medic"].GetValue<string>()),
            args["side"].GetValue<string>() == "left",
            Titles(args["fireFlip"].GetValue<string>()).Select(x => x == "1").ToArray(),
            args.TryGetValue("ground", out var g) && g.GetValue<bool>());
    }

    /// <summary>Same trucks at the same runway: only the level may differ.</summary>
    public bool SameFire(RescueRequest o) =>
        Ground == o.Ground && ThrLat == o.ThrLat && ThrLon == o.ThrLon && Hdg == o.Hdg && Left == o.Left && Fire.SequenceEqual(o.Fire, StringComparer.Ordinal) &&
        (Flip ?? []).SequenceEqual(o.Flip ?? []);

    public bool SameMedic(RescueRequest o) =>
        ThrLat == o.ThrLat && ThrLon == o.ThrLon && Medic.SequenceEqual(o.Medic, StringComparer.Ordinal);
}

/// <summary>The user's aircraft, as the rescue vehicles need it.</summary>
public readonly record struct RescueAircraft(double Lat, double Lon, double HdgDeg, double GsKt, bool OnGround, bool ParkingBrake);

public enum RescueActionKind
{
    /// <summary>
    /// Create <see cref="RescueAction.Title"/> at the point with the heading <see cref="RescueAction.Hdg"/> (already
    /// corrected for the drawing, <see cref="RescueController.FireDrawnFlipDeg"/>). The sim thread sets
    /// <c>SIM DISABLED</c> = 1 once the object has an id: the bridge moves it itself.
    /// </summary>
    Spawn,
    /// <summary>Remove the object of the slot.</summary>
    Remove,
    /// <summary>
    /// Put the object of the slot at the point with the heading <see cref="RescueAction.Hdg"/> (corrected for the
    /// drawing): <c>SIMCONNECT_DATA_INITPOSITION</c> on the ground, ~<see cref="RescueController.StepEvery"/> apart while
    /// it moves.
    /// </summary>
    Place,
}

/// <summary>One thing the sim thread does for a vehicle. Slots 0..7 are fire trucks, <see cref="RescueController.MedicSlot"/> the ambulance.</summary>
public readonly record struct RescueAction(RescueActionKind Kind, int Slot, string Title, double Lat, double Lon, double Hdg);

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
/// Decides when the rescue vehicles of T54 exist in the sim and moves the fire trucks itself; no SimConnect here, the
/// sim thread carries out the returned <see cref="RescueAction"/>s. Fire trucks are created when the aircraft comes
/// within <see cref="StageNm"/> of the landing threshold, beside the runway; with <c>full</c> they follow the aircraft
/// after touchdown and surround it once it stands; they are removed <see cref="StayAfterStop"/> after the stop, on
/// <c>rescue_stop</c>, beyond <see cref="RemoveNm"/> (a go-around; created again when near) and with the sim session
/// (created again in the next one while the request stands). The ambulance appears beside the aircraft once it is
/// parked near the landing airport, and is created again beside it at a later parked stop more than
/// <see cref="MedicMovedM"/> away. Geometry and timings are the ERoD mod's (docs/07 T54 p. 8), the rest are game rules
/// approved by the user (2026-10-17):
/// <list type="bullet">
/// <item>every vehicle stands with <c>SIM DISABLED</c> = 1 (created vehicles otherwise roll away), and the bridge moves
/// the fire trucks itself: <see cref="Step"/>, about every <see cref="StepEvery"/>, advances each along its route at
/// its speed and puts it there (<see cref="RescueActionKind.Place"/>), facing where it goes — no AI waypoints (the AI
/// drove them in reverse, crawled on the last waypoint and did not stop);</item>
/// <item>some fire truck models are drawn nose to tail with their sim heading: for the trucks the request flags
/// (<see cref="RescueRequest.Flip"/>, a list in the app's settings) every heading the sim gets is turned by
/// <see cref="FireDrawnFlipDeg"/>; the others and the ambulance are drawn along it (seen by a human 2026-10-17);</item>
/// <item>at touchdown a truck ahead of the aircraft (along its heading) keeps standing until the aircraft has passed
/// it, then follows;</item>
/// <item>to the circle a truck goes straight when that line passes at least <see cref="ClearM"/> from the aircraft,
/// else around it on an arc of <see cref="DetourM"/> in steps of at most <see cref="DetourStepDeg"/>, the short way, at
/// <see cref="CircleKt"/>; it stops when it arrives, gets no closer by <see cref="ProgressM"/> in
/// <see cref="NoProgressAfter"/>, or after <see cref="CircleDriveMax"/>;</item>
/// <item>the trucks wait spread along the runway from the touchdown zone to the far end, <see cref="StageSideM"/> off
/// its axis on the upwind side (the app sends it), facing it;</item>
/// <item>touchdown only after <see cref="TouchdownAfter"/> on the ground without a break, back to waiting only after
/// <see cref="GoAroundAfter"/> in the air.</item>
/// </list>
/// A call on the ground (<see cref="RescueRequest.Ground"/>, T88, approved 2026-11-04): the trucks are created beside the
/// runway as above and come to the aircraft at once, straight across the airfield (no taxiways): <c>full</c> ones surround
/// it while it stands and follow it while it rolls; <c>standby</c> ones stand aside on an arc of <see cref="StandbyM"/>
/// ahead of it (a game rule). "Stands" and "rolls" here go by the ground speed only: some aircraft report
/// <c>SIM ON GROUND</c> = 0 at the stand (BlueBird 757, recording of 2026-11-01).
/// Thread-safe: commands arrive on a network thread, positions and steps on the SimConnect thread. <paramref name="log"/>
/// gets a line on every change of the stage or of what the controller sees, on the events of the trucks, and every
/// <see cref="TraceEvery"/> per moving truck (diagnostics for the human check).
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
    /// <summary>How often a following truck gets a new target.</summary>
    public static readonly TimeSpan MoveEvery = TimeSpan.FromMilliseconds(350);
    /// <summary>How often the bridge moves the trucks (about 10 Hz).</summary>
    public static readonly TimeSpan StepEvery = TimeSpan.FromMilliseconds(100);
    /// <summary>A longer gap between steps (a stall) is moved as this much, so a truck does not jump far.</summary>
    public static readonly TimeSpan StepMax = TimeSpan.FromMilliseconds(500);
    /// <summary>A model drawn reversed has its nose this far from its sim heading.</summary>
    public const double FireDrawnFlipDeg = 180;

    /// <summary>Waiting trucks: off the runway axis on the upwind side, m (user decision 2026-10-17).</summary>
    public const double StageSideM = 150;
    /// <summary>The first waiting truck: about the touchdown zone, this far past the threshold, m.</summary>
    public const double StageFirstM = 400;
    /// <summary>The last waiting truck: this far before the far end of the runway, m; the rest evenly between.</summary>
    public const double StageLastFromEndM = 200;
    /// <summary>Following: truck i is (i + 1) × this behind the aircraft, m.</summary>
    public const double TrailM = 25;
    public const double CircleM = 50;
    /// <summary>T88: <c>standby</c> trucks of a call on the ground wait on an arc this far ahead of the aircraft, m.</summary>
    public const double StandbyM = 100;
    /// <summary>Ambulance: left of the aircraft, m.</summary>
    public const double MedicSideM = 30;
    /// <summary>The aircraft parks again this far from the ambulance: it is created anew beside the aircraft, m.</summary>
    public const double MedicMovedM = 100;
    /// <summary>Following speed: the aircraft's plus this, within <see cref="MinTrailKt"/>..<see cref="MaxTrailKt"/>.</summary>
    public const double TrailExtraKt = 10, MinTrailKt = 20, MaxTrailKt = 60;
    /// <summary>Speed to the points of the circle.</summary>
    public const double CircleKt = 40;
    /// <summary>A truck this close to its point on the circle has arrived, m.</summary>
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
    /// <summary>On the way to the circle a truck that gets no closer by <see cref="ProgressM"/> in this long is stuck.</summary>
    public static readonly TimeSpan NoProgressAfter = TimeSpan.FromSeconds(20);
    public const double ProgressM = 10;
    /// <summary>At the latest this long after the stop every truck is stopped wherever it is.</summary>
    public static readonly TimeSpan CircleDriveMax = TimeSpan.FromMinutes(5);
    /// <summary>How often a moving truck is traced in the log.</summary>
    public static readonly TimeSpan TraceEvery = TimeSpan.FromSeconds(2);

    private const double MpsPerKt = 1852.0 / 3600;

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
    /// <summary>T88: since when the ground speed is below / at least <see cref="StopKt"/>, whatever <c>SIM ON GROUND</c> says.</summary>
    private DateTimeOffset? _stillSince, _rollingSince;
    private DateTimeOffset? _stoppedAt;
    private DateTimeOffset _lastMove;
    private DateTimeOffset? _lastStep;

    /// <summary>Where each truck is and where it faces (visually), as the bridge put it.</summary>
    private readonly (double Lat, double Lon)?[] _pos = new (double, double)?[MaxFire];
    private readonly double[] _hdg = new double[MaxFire];
    /// <summary>The truck's model is drawn reversed (from the request it was created for).</summary>
    private readonly bool[] _flip = new bool[MaxFire];
    /// <summary>The points still ahead of a moving truck, and its speed, m/s; empty = it stands.</summary>
    private readonly List<(double Lat, double Lon)>[] _route = Enumerable.Range(0, MaxFire).Select(_ => new List<(double, double)>()).ToArray();
    private readonly double[] _mps = new double[MaxFire];
    private readonly DateTimeOffset[] _traced = new DateTimeOffset[MaxFire];
    /// <summary>Trucks that were ahead of the aircraft at touchdown and still wait for it to pass.</summary>
    private readonly bool[] _waiting = new bool[MaxFire];
    /// <summary>Points on the circle of the trucks still going there, the closest they came, and when they last got closer.</summary>
    private readonly (double Lat, double Lon)?[] _circle = new (double, double)?[MaxFire];
    private readonly double[] _circleBest = new double[MaxFire];
    private readonly DateTimeOffset[] _circleProgressAt = new DateTimeOffset[MaxFire];

    private bool _medicSpawned;
    private bool _medicDone;
    private DateTimeOffset _medicAt;
    private (double Lat, double Lon) _medicPos;

    private readonly List<RescueAction> _out = [];
    /// <summary>What was last logged as the state (<see cref="Trace"/>).</summary>
    private string? _traceState;

    private void Log(string line) => log?.Invoke(line);

    public RescueStage Stage
    {
        get { lock (_gate) return _stage; }
    }

    public bool Active
    {
        get { lock (_gate) return _req is not null || _fireSpawned > 0 || _medicSpawned; }
    }

    /// <summary>Some truck is moving: <see cref="Step"/> is wanted about every <see cref="StepEvery"/>.</summary>
    public bool Moving
    {
        get
        {
            lock (_gate)
            {
                for (var i = 0; i < _fireSpawned; i++) if (_route[i].Count > 0) return true;
                return false;
            }
        }
    }

    /// <summary>Where a truck is (as the bridge put it), null when it is not in the sim.</summary>
    public (double Lat, double Lon)? PositionOf(int slot)
    {
        lock (_gate) return slot >= 0 && slot < _fireSpawned ? _pos[slot] : null;
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
            _stillSince = _rollingSince = null;
            _stoppedAt = null;
            ClearTrucks();
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

    /// <summary>
    /// Moves every moving truck along its route by its speed × the time since the last step (at most
    /// <see cref="StepMax"/>) and returns where to put them (the list is reused by the next call).
    /// </summary>
    public IReadOnlyList<RescueAction> Step()
    {
        lock (_gate)
        {
            _out.Clear();
            var now = clock.GetUtcNow();
            var dt = _lastStep is { } l ? now - l : StepEvery;
            if (dt > StepMax) dt = StepMax;
            _lastStep = now;
            if (dt <= TimeSpan.Zero) return _out;
            for (var i = 0; i < _fireSpawned; i++)
            {
                if (_route[i].Count == 0 || _pos[i] is not { } p) continue;
                var left = _mps[i] * dt.TotalSeconds;
                var at = p;
                while (left > 0 && _route[i].Count > 0)
                {
                    var next = _route[i][0];
                    var d = Meters(at, next);
                    if (d > 0.01) _hdg[i] = Bearing(at, next);
                    if (d <= left)
                    {
                        left -= d;
                        at = next;
                        _route[i].RemoveAt(0);
                    }
                    else
                    {
                        at = Offset(at.Lat, at.Lon, Bearing(at, next), left);
                        left = 0;
                    }
                }
                _pos[i] = at;
                _out.Add(new(RescueActionKind.Place, i, "", at.Lat, at.Lon, Drawn(_hdg[i], _flip[i])));
                if (now - _traced[i] >= TraceEvery)
                {
                    _traced[i] = now;
                    var to = _route[i].Count > 0 ? $"{Meters(at, _route[i][^1]):0} m" : "arrived";
                    Log($"rescue slot {i} moving: hdg {_hdg[i]:0} (sim {Drawn(_hdg[i], _flip[i]):0}), {_mps[i] / MpsPerKt:0} kt, to target {to}");
                }
            }
            return _out;
        }
    }

    /// <summary>The heading the sim gets for a truck facing <paramref name="facing"/>: turned when its model is drawn reversed.</summary>
    public static double Drawn(double facing, bool flipped) => Norm(facing + (flipped ? FireDrawnFlipDeg : 0));

    private void TrackStop(RescueAircraft a, DateTimeOffset now)
    {
        if (!a.OnGround || a.GsKt >= StopKt) _slowSince = null;
        else _slowSince ??= now;
        if (a.GsKt >= StopKt)
        {
            _rollingSince ??= now;
            _stillSince = null;
        }
        else
        {
            _stillSince ??= now;
            _rollingSince = null;
        }
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

    private bool Stands(DateTimeOffset now) => _slowSince is { } s && now - s >= StopAfter;
    /// <summary>T88: below <see cref="StopKt"/> for <see cref="StopAfter"/>, by the ground speed only.</summary>
    private bool Still(DateTimeOffset now) => _stillSince is { } s && now - s >= StopAfter;
    private bool Rolling(DateTimeOffset now) => _rollingSince is { } s && now - s >= StopAfter;
    private bool Landed(DateTimeOffset now) => _groundSince is { } g && now - g >= TouchdownAfter;
    private bool WentAround(DateTimeOffset now) => _airSince is { } t && now - t >= GoAroundAfter;

    /// <summary>One line whenever the stage or what decides it changes.</summary>
    private void Trace(RescueAircraft a, DateTimeOffset now)
    {
        if (log is null || (_req is null && _fireSpawned == 0)) return;
        var waiting = _waiting.Count(w => w);
        var state =
            $"rescue stage {_stage}, trucks {_fireSpawned}, on ground {a.OnGround}, airborne since staged {_airborne}, " +
            $"stands {Stands(now)}, waiting {waiting}, level {(_req?.Full == true ? "full" : _req is null ? "-" : "standby")}";
        if (state == _traceState) return;
        _traceState = state;
        Log($"{state} (gs {a.GsKt:0.0} kt)");
    }

    /// <summary>Sends truck <paramref name="i"/> along <paramref name="route"/> at <paramref name="kt"/>.</summary>
    private void Go(int i, IEnumerable<(double Lat, double Lon)> route, double kt)
    {
        _route[i].Clear();
        _route[i].AddRange(route);
        _mps[i] = kt * MpsPerKt;
    }

    /// <summary>Stops truck <paramref name="i"/> where it is.</summary>
    private void Halt(int i) => _route[i].Clear();

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
        if (req.Ground && _stage != RescueStage.Idle)
        {
            FireOnGround(a, req, now);
            return;
        }
        switch (_stage)
        {
            case RescueStage.Idle:
                if (nm > StageNm) return;
                var n = Math.Min(req.Fire.Count, MaxFire);
                for (var i = 0; i < n; i++)
                {
                    var (lat, lon) = StagePoint(req, i, n);
                    _pos[i] = (lat, lon);
                    _hdg[i] = FacingRunway(req);
                    _flip[i] = req.Flipped(i);
                    _out.Add(new(RescueActionKind.Spawn, i, req.Fire[i], lat, lon, Drawn(_hdg[i], _flip[i])));
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
                    for (var i = 0; i < _fireSpawned; i++) Halt(i);
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
                        if (!_waiting[i]) Go(i, [TrailPoint(a, i)], kt);
                }
                StartFollowing(a);
                return;
            case RescueStage.Encircle:
                EncircleStep(now);
                return;
        }
    }

    /// <summary>
    /// T88, a call on the ground: from the runway straight to the aircraft. While it stands, <c>full</c> trucks drive to
    /// the circle and <c>standby</c> ones aside; while it rolls, <c>full</c> trucks follow it (not faster than
    /// <see cref="MaxTrailKt"/>: a take-off run leaves them standing) and <c>standby</c> ones wait.
    /// </summary>
    private void FireOnGround(RescueAircraft a, RescueRequest req, DateTimeOffset now)
    {
        switch (_stage)
        {
            case RescueStage.Staged:
                if (Still(now))
                {
                    if (req.Full) Stopped(a, req, now);
                    else Aside(a, now);
                }
                else if (req.Full && Rolling(now))
                {
                    _stage = RescueStage.Trailing;
                    _lastMove = now - MoveEvery;
                    Log("rescue: called on the ground, the aircraft rolls, trucks follow it");
                    FollowOnGround(a, now);
                }
                return;
            case RescueStage.Trailing:
                if (Still(now))
                {
                    Stopped(a, req, now);
                    return;
                }
                FollowOnGround(a, now);
                return;
            case RescueStage.Encircle:
                if (req.Full && Rolling(now))
                {
                    _stage = RescueStage.Trailing;
                    _stoppedAt = null;
                    Array.Clear(_circle);
                    _lastMove = now - MoveEvery;
                    Log("rescue: the aircraft rolls again, trucks follow it");
                    FollowOnGround(a, now);
                    return;
                }
                EncircleStep(now);
                return;
        }
    }

    /// <summary>T88: <c>full</c> trucks of a call on the ground follow the rolling aircraft; past <see cref="MaxTrailKt"/> they stop.</summary>
    private void FollowOnGround(RescueAircraft a, DateTimeOffset now)
    {
        if (now - _lastMove < MoveEvery) return;
        _lastMove = now;
        if (a.GsKt > MaxTrailKt)
        {
            for (var i = 0; i < _fireSpawned; i++) Halt(i);
            return;
        }
        var kt = TrailKt(a);
        for (var i = 0; i < _fireSpawned; i++) Go(i, [TrailPoint(a, i)], kt);
    }

    /// <summary>T88: the aircraft stands after a call on the ground with <c>standby</c>: the trucks drive to their places aside.</summary>
    private void Aside(RescueAircraft a, DateTimeOffset now)
    {
        _stage = RescueStage.Encircle;
        _stoppedAt = now;
        Log("rescue: called on the ground, the aircraft stands, standby trucks drive aside");
        for (var i = 0; i < _fireSpawned; i++)
        {
            var target = StandbyPoint(a, i, _fireSpawned);
            var from = _pos[i] ?? target;
            var route = CircleRoute(a, from, target);
            Go(i, route, CircleKt);
            _circle[i] = target;
            _circleBest[i] = Meters(from, target);
            _circleProgressAt[i] = now;
        }
    }

    /// <summary>
    /// The trucks stand by the aircraft: removed <see cref="StayAfterStop"/> after the stop; those still on the way stop
    /// when they arrive or get stuck.
    /// </summary>
    private void EncircleStep(DateTimeOffset now)
    {
        if (_stoppedAt is { } t && now - t >= StayAfterStop)
        {
            RemoveFire();
            _stage = RescueStage.Done;
            return;
        }
        for (var i = 0; i < MaxFire; i++)
        {
            if (_circle[i] is not { } c) continue;
            var d = _pos[i] is { } p ? Meters(p, c) : double.MaxValue;
            if (d <= _circleBest[i] - ProgressM)
            {
                _circleBest[i] = d;
                _circleProgressAt[i] = now;
            }
            var arrived = d <= ArrivedM || (_route[i].Count == 0 && d < double.MaxValue);
            var stuck = now - _circleProgressAt[i] >= NoProgressAfter;
            var late = _stoppedAt is { } s && now - s >= CircleDriveMax;
            if (!arrived && !stuck && !late) continue;
            Halt(i);
            _circle[i] = null;
            var why = arrived ? "arrived on the circle" : stuck ? $"stops: no closer in {NoProgressAfter.TotalSeconds:0} s, {d:0} m to go" : "stops: 5 min after the stop";
            Log($"rescue slot {i}: {why}");
        }
    }

    /// <summary>Waiting trucks the aircraft has passed (no longer ahead of it along its heading) start to follow.</summary>
    private void StartFollowing(RescueAircraft a)
    {
        var kt = TrailKt(a);
        for (var i = 0; i < _fireSpawned; i++)
        {
            if (!_waiting[i] || (_pos[i] is { } p && AheadM(a, p) > 0)) continue;
            _waiting[i] = false;
            Log($"rescue slot {i}: follows (the aircraft has passed it or it was behind)");
            Go(i, [TrailPoint(a, i)], kt);
        }
    }

    /// <summary>How far a point is ahead of the aircraft along its heading, m (negative = behind).</summary>
    public static double AheadM(RescueAircraft a, (double Lat, double Lon) p) =>
        Meters((a.Lat, a.Lon), p) * Math.Cos((Bearing((a.Lat, a.Lon), p) - a.HdgDeg) * Math.PI / 180);

    private static double TrailKt(RescueAircraft a) => Math.Clamp(a.GsKt + TrailExtraKt, MinTrailKt, MaxTrailKt);

    /// <summary>Following truck <paramref name="i"/>: its place behind the aircraft.</summary>
    public static (double Lat, double Lon) TrailPoint(RescueAircraft a, int i) =>
        Offset(a.Lat, a.Lon, a.HdgDeg + 180, TrailM * (i + 1));

    /// <summary>The aircraft stands after landing: <c>full</c> trucks drive to the circle; all wait for the removal.</summary>
    private void Stopped(RescueAircraft a, RescueRequest req, DateTimeOffset now)
    {
        _stage = RescueStage.Encircle;
        _stoppedAt = now;
        Log($"rescue: the aircraft stands, {(req.Full ? "trucks drive to the circle" : "standby trucks stay")}");
        if (req.Full)
        {
            for (var i = 0; i < _fireSpawned; i++)
            {
                var target = CirclePoint(a, i, _fireSpawned);
                var from = _pos[i] ?? TrailPoint(a, i);
                var route = CircleRoute(a, from, target);
                Log($"rescue slot {i}: to the circle, {route.Length} waypoint(s), {Meters(from, target):0} m away");
                Go(i, route, CircleKt);
                _circle[i] = target;
                _circleBest[i] = Meters(from, target);
                _circleProgressAt[i] = now;
            }
        }
        Array.Clear(_waiting);
    }

    private void Medic(RescueAircraft a, DateTimeOffset now)
    {
        var req = _req;
        if (_medicFor is not null && (req is null || !_medicFor.SameMedic(req)))
        {
            if (_medicSpawned) _out.Add(new(RescueActionKind.Remove, MedicSlot, "", 0, 0, 0));
            _medicSpawned = false;
            _medicDone = false;
            _medicFor = null;
        }
        if (req is null) return;
        _medicFor = req;
        if (req.Medic.Count == 0) return;
        var nm = SmokeController.DistanceNm(a.Lat, a.Lon, req.ThrLat, req.ThrLon);
        var parked = nm <= StageNm && a.ParkingBrake && (req.Ground ? Still(now) : Stands(now));
        if (_medicSpawned)
        {
            if (nm > RemoveNm || now - _medicAt >= StayAfterStop)
            {
                _out.Add(new(RescueActionKind.Remove, MedicSlot, "", 0, 0, 0));
                _medicSpawned = false;
                _medicDone = now - _medicAt >= StayAfterStop;
                return;
            }
            // Parked again elsewhere (a stop on the runway, then the gate): the ambulance comes along (approved 2026-10-17).
            if (!parked || Meters((a.Lat, a.Lon), _medicPos) <= MedicMovedM) return;
            _out.Add(new(RescueActionKind.Remove, MedicSlot, "", 0, 0, 0));
            _medicSpawned = false;
            Log("rescue slot 8: the aircraft parked elsewhere, the ambulance is created beside it again");
        }
        if (_medicDone || !parked) return;
        var (lat, lon) = Offset(a.Lat, a.Lon, a.HdgDeg - 90, MedicSideM);
        // The ambulance model is drawn along its sim heading: no correction.
        _out.Add(new(RescueActionKind.Spawn, MedicSlot, req.Medic[0], lat, lon, Norm(a.HdgDeg)));
        _medicSpawned = true;
        _medicAt = now;
        _medicPos = (lat, lon);
    }

    private void RemoveFire()
    {
        for (var i = 0; i < _fireSpawned; i++) _out.Add(new(RescueActionKind.Remove, i, "", 0, 0, 0));
        _fireSpawned = 0;
        ClearTrucks();
    }

    private void ClearTrucks()
    {
        Array.Clear(_pos);
        Array.Clear(_circle);
        Array.Clear(_waiting);
        Array.Clear(_traced);
        foreach (var r in _route) r.Clear();
    }

    /// <summary>
    /// Waiting place of truck <paramref name="i"/> of <paramref name="n"/> (user decision 2026-10-17, from a description
    /// of ARFF practice — a search summary, not a primary source): from <see cref="StageFirstM"/> past the threshold
    /// (one truck: there) to <see cref="StageLastFromEndM"/> before the far end, evenly; on a runway too short for that
    /// all wait at <see cref="StageFirstM"/>. <see cref="StageSideM"/> off the axis on the side of the request.
    /// </summary>
    public static (double Lat, double Lon) StagePoint(RescueRequest r, int i, int n)
    {
        var last = Math.Max(r.LengthM - StageLastFromEndM, StageFirstM);
        var along = n <= 1 ? StageFirstM : StageFirstM + (last - StageFirstM) * i / (n - 1);
        var (lat, lon) = Offset(r.ThrLat, r.ThrLon, r.Hdg, along);
        return Offset(lat, lon, r.Hdg + (r.Left ? -90 : 90), StageSideM);
    }

    /// <summary>Where a waiting truck faces: the runway, from its side.</summary>
    public static double FacingRunway(RescueRequest r) => Norm(r.Hdg + (r.Left ? 90 : -90));

    /// <summary>Point <paramref name="i"/> of <paramref name="n"/> on the circle around the aircraft, the first at its nose.</summary>
    public static (double Lat, double Lon) CirclePoint(RescueAircraft a, int i, int n) =>
        Offset(a.Lat, a.Lon, a.HdgDeg + 360.0 * i / Math.Max(1, n), CircleM);

    /// <summary>
    /// T88: place <paramref name="i"/> of <paramref name="n"/> of a <c>standby</c> truck called on the ground: on an arc of
    /// <see cref="StandbyM"/> from 60° left to 60° right of the nose (one truck: at the nose).
    /// </summary>
    public static (double Lat, double Lon) StandbyPoint(RescueAircraft a, int i, int n) =>
        Offset(a.Lat, a.Lon, a.HdgDeg + (n <= 1 ? 0 : -60 + 120.0 * i / (n - 1)), StandbyM);

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
