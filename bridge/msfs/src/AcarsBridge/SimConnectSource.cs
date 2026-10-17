#if SIMCONNECT
using System.Runtime.InteropServices;
using Microsoft.FlightSimulator.SimConnect;

namespace AcarsBridge;

/// <summary>
/// MSFS via managed SimConnect (MSFS SDK). Compiled only when the SDK is found (see the .csproj).
/// No window: SimConnect signals an <see cref="EventWaitHandle"/>, and a dedicated thread calls
/// ReceiveMessage. Reconnects with <see cref="ReconnectPolicy"/> when the sim is not running or quits.
/// Commands (protocol v2): <c>ping</c> — ok while a SimConnect session is open; <c>smoke_start</c> /
/// <c>smoke_stop</c> (T34) — a smoke SimObject at a point, created by <c>AICreateSimulatedObject</c> when the
/// aircraft is near (the EX1 variant is not in the managed wrapper of the SDK, so the smoke package is a
/// non-modular SimObject, which the plain call supports). <c>rescue_start</c> / <c>rescue_stop</c> (T54) — fire trucks and
/// an ambulance by their titles (<see cref="RescueController"/>), created with the same plain call and driven by
/// <c>AI WAYPOINT LIST</c> (<c>SetDataOnSimObject</c> with <c>SIMCONNECT_DATA_WAYPOINT</c>); while they are wanted the
/// aircraft position is also read every <see cref="RescueController.MoveEvery"/>. A vehicle stands with its own
/// simulation off (<c>SIM DISABLED</c> = 1, set as soon as its id is known) and drives with it on; its heading is set
/// again then (<c>PLANE HEADING DEGREES TRUE</c>) and read back to the console, and before each route it is turned
/// toward the first point.
/// </summary>
public sealed class SimConnectSource(TimeProvider clock, ReconnectPolicy? policy = null) : ISimSource, ICommandTarget
{
    private enum Def { Telemetry, Rescue, Waypoint, SimDisabled, VehiclePos, Heading }
    /// <summary>Rescue vehicles are created with <c>RescueSpawn + slot</c>, their positions asked with <c>VehiclePos + slot</c>.</summary>
    private enum Req
    {
        Telemetry, Smoke, SmokeRemove, RescuePos, RescueRemove,
        RescueSpawn = 100, VehiclePos = 200, VehicleHdg = 300, VehicleHdgInit = 400, VehicleHdgLate = 500,
    }
    private enum Evt { Pause, Sim }

    /// <summary>Wire layout of the data definition: FLOAT64 × SimVars.Count, then TITLE as STRING256.</summary>
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi, Pack = 1)]
    private struct RawData
    {
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = SimVars.Count)]
        public double[] Values;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string Title;
    }

    /// <summary>Aircraft position for the rescue vehicles (T54): FLOAT64 × 7, in this order.</summary>
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct RescuePos
    {
        public double Lat, Lon, Alt, Hdg, Gs, OnGround, ParkingBrake;
    }

    /// <summary><c>SIM DISABLED</c> of a rescue vehicle (Bool as FLOAT64).</summary>
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct SimDisabled
    {
        public double Value;
    }

    /// <summary><c>PLANE HEADING DEGREES TRUE</c> of a rescue vehicle, degrees.</summary>
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct Heading
    {
        public double Deg;
    }

    /// <summary>Where a rescue vehicle is: FLOAT64 × 2.</summary>
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct VehiclePos
    {
        public double Lat, Lon, Hdg, BodyZ;
    }

    private const string ClientName = "ACARS Bridge";
    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(250);

    private readonly ReconnectPolicy _policy = policy ?? new ReconnectPolicy();

    public string Name => "simconnect";

    /// <summary>A SimConnect session is open (set on the message thread, read by command handlers).</summary>
    private volatile bool _open;

    /// <summary>Container title of the smoke SimObject (<c>bridge/msfs/package</c>, T34): its <c>title=</c> in sim.cfg.</summary>
    public const string SmokeTitle = "ACARS Smoke";

    private readonly SmokeController _smoke = new(clock);

    /// <summary>Object id of the smoke SimObject (0 = none); set and read on the message thread only.</summary>
    private uint _smokeId;
    /// <summary>Objects asked for and not yet assigned an id (ids come back in the order asked).</summary>
    private int _smokeAsked;
    /// <summary>How many of those are to be removed as soon as their id comes (a respawn may ask anew before).</summary>
    private int _smokeRemoveWhenAssigned;

    private readonly RescueController _rescue = new(clock, line => Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] {line}"));

    /// <summary>Rescue vehicles by slot, like the smoke object's fields; message thread only.</summary>
    private readonly uint[] _rescueId = new uint[RescueController.MaxFire + 1];
    private readonly int[] _rescueAsked = new int[RescueController.MaxFire + 1];
    private readonly int[] _rescueRemoveWhenAssigned = new int[RescueController.MaxFire + 1];
    /// <summary>The vehicle's own simulation should be on (it drives); off from its creation.</summary>
    private readonly bool[] _rescueSimOn = new bool[RescueController.MaxFire + 1];
    /// <summary>Title and the heading last asked for, by slot; whether that heading is to be read back (console).</summary>
    private readonly string[] _rescueTitle = new string[RescueController.MaxFire + 1];
    private readonly double[] _rescueHdg = new double[RescueController.MaxFire + 1];
    private readonly bool[] _rescueHdgCheck = new bool[RescueController.MaxFire + 1];
    /// <summary>Diagnostics (T54, 2026-10-17): when to read the heading again, and the last traced place of a driving truck.</summary>
    private readonly DateTimeOffset?[] _rescueHdgLate = new DateTimeOffset?[RescueController.MaxFire + 1];
    private readonly (DateTimeOffset T, double Lat, double Lon)?[] _rescueTrace = new (DateTimeOffset, double, double)?[RescueController.MaxFire];
    private readonly double[] _rescueSpawnHdg = new double[RescueController.MaxFire + 1];
    private static readonly TimeSpan HdgLateAfter = TimeSpan.FromSeconds(3);
    private static readonly TimeSpan TraceEvery = TimeSpan.FromSeconds(2);

    private static void Diag(string line) => Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] {line}");
    private DateTimeOffset _rescuePolled;

    public IReadOnlyCollection<string> Commands { get; } = ["ping", "rescue_start", "rescue_stop", "smoke_start", "smoke_stop"];

    public Task<CommandResult> ExecuteAsync(SimCommand command, CancellationToken ct)
    {
        switch (command.Name)
        {
            case "ping":
                return Task.FromResult(_open ? CommandResult.Success : CommandResult.Fail(CommandErrors.Unavailable, "sim not connected"));
            case "smoke_start" when !_open:
                return Task.FromResult(CommandResult.Fail(CommandErrors.Unavailable, "sim not connected"));
            case "smoke_start":
                // The object itself is made on the message thread, once the aircraft is near.
                _smoke.Start(command.Args["lat"].GetValue<double>(), command.Args["lon"].GetValue<double>());
                return Task.FromResult(CommandResult.Success);
            case "smoke_stop":
                _smoke.Stop();
                return Task.FromResult(CommandResult.Success);
            case "rescue_start" when !_open:
                return Task.FromResult(CommandResult.Fail(CommandErrors.Unavailable, "sim not connected"));
            case "rescue_start":
                _rescue.Start(RescueRequest.FromArgs(command.Args));
                return Task.FromResult(CommandResult.Success);
            case "rescue_stop":
                _rescue.Stop();
                return Task.FromResult(CommandResult.Success);
            default:
                return Task.FromResult(CommandResult.Fail(CommandErrors.UnknownCommand, command.Name));
        }
    }

    /// <summary>Message thread: creates or removes the smoke object as <see cref="SmokeController"/> decides.</summary>
    private void ApplySmoke(SimConnect sc, double lat, double lon)
    {
        switch (_smoke.OnPosition(lat, lon))
        {
            case SmokeAction.Spawn when _smoke.Target is { } t:
                // OnGround = 1: the object stands on the terrain (the SDK does not say how Altitude then counts).
                var at = new SIMCONNECT_DATA_INITPOSITION
                {
                    Latitude = t.Lat, Longitude = t.Lon, Altitude = 0, Pitch = 0, Bank = 0, Heading = 0,
                    OnGround = 1, Airspeed = 0,
                };
                _smokeAsked++;
                sc.AICreateSimulatedObject(SmokeTitle, at, Req.Smoke);
                break;
            case SmokeAction.Remove:
                if (_smokeId != 0)
                {
                    sc.AIRemoveObject(_smokeId, Req.SmokeRemove);
                    _smokeId = 0;
                }
                else if (_smokeAsked > _smokeRemoveWhenAssigned)
                    _smokeRemoveWhenAssigned++;
                break;
        }
    }

    /// <summary>Message thread: carries out what <see cref="RescueController"/> decides for this position.</summary>
    private void ApplyRescue(SimConnect sc, RescuePos p)
    {
        var a = new RescueAircraft(p.Lat, p.Lon, p.Hdg, p.Gs, p.OnGround != 0, p.ParkingBrake != 0);
        foreach (var x in _rescue.OnPosition(a))
        {
            switch (x.Kind)
            {
                case RescueActionKind.Spawn:
                    var at = new SIMCONNECT_DATA_INITPOSITION
                    {
                        Latitude = x.Lat, Longitude = x.Lon, Altitude = 0, Pitch = 0, Bank = 0, Heading = x.Hdg,
                        OnGround = 1, Airspeed = 0,
                    };
                    _rescueAsked[x.Slot]++;
                    _rescueSimOn[x.Slot] = false;
                    _rescueTitle[x.Slot] = x.Title;
                    _rescueHdg[x.Slot] = x.Hdg;
                    _rescueSpawnHdg[x.Slot] = x.Hdg;
                    sc.AICreateSimulatedObject(x.Title, at, (Req)((int)Req.RescueSpawn + x.Slot));
                    break;
                case RescueActionKind.Turn:
                    _rescueHdg[x.Slot] = x.Hdg;
                    if (_rescueId[x.Slot] != 0) SetHeading(sc, x.Slot);
                    break;
                case RescueActionKind.Simulate:
                    _rescueSimOn[x.Slot] = x.On;
                    if (_rescueId[x.Slot] != 0) SetSim(sc, _rescueId[x.Slot], x.On);
                    break;
                case RescueActionKind.Remove:
                    if (_rescueId[x.Slot] != 0)
                    {
                        sc.AIRemoveObject(_rescueId[x.Slot], Req.RescueRemove);
                        _rescueId[x.Slot] = 0;
                    }
                    else if (_rescueAsked[x.Slot] > _rescueRemoveWhenAssigned[x.Slot])
                        _rescueRemoveWhenAssigned[x.Slot]++;
                    break;
                case RescueActionKind.Move when _rescueId[x.Slot] != 0:
                    SIMCONNECT_DATA_WAYPOINT Point(double lat, double lon) => new()
                    {
                        Latitude = lat, Longitude = lon, Altitude = p.Alt,
                        Flags = (uint)(SIMCONNECT_WAYPOINT_FLAGS.ON_GROUND | SIMCONNECT_WAYPOINT_FLAGS.SPEED_REQUESTED),
                        ktsSpeed = x.SpeedKt, percentThrottle = 0,
                    };
                    var list = (x.Route ?? [(x.Lat, x.Lon)]).Select(q => (object)Point(q.Lat, q.Lon)).ToArray();
                    sc.SetDataOnSimObject(Def.Waypoint, _rescueId[x.Slot], SIMCONNECT_DATA_SET_FLAG.DEFAULT, list);
                    break;
            }
        }
    }

    /// <summary><c>SIM DISABLED</c> of a vehicle: 0 while it drives, 1 while it stands (else it rolls away).</summary>
    private static void SetSim(SimConnect sc, uint id, bool on) =>
        sc.SetDataOnSimObject(Def.SimDisabled, id, SIMCONNECT_DATA_SET_FLAG.DEFAULT, new SimDisabled { Value = on ? 0 : 1 });

    /// <summary>Sets the asked heading of a vehicle and has it read back on the next poll.</summary>
    private void SetHeading(SimConnect sc, int slot)
    {
        sc.SetDataOnSimObject(Def.Heading, _rescueId[slot], SIMCONNECT_DATA_SET_FLAG.DEFAULT, new Heading { Deg = _rescueHdg[slot] });
        _rescueHdgCheck[slot] = true;
        _rescueHdgLate[slot] = clock.GetUtcNow() + HdgLateAfter;
    }

    /// <summary>
    /// Every <see cref="TraceEvery"/> per driving truck: its heading, its speed along its own axis (VELOCITY BODY Z,
    /// negative = backwards) and the direction it actually moved (diagnostics for the reverse driving, 2026-10-17).
    /// </summary>
    private void TraceDriving(int slot, VehiclePos v)
    {
        var now = clock.GetUtcNow();
        if (_rescueTrace[slot] is { } last && now - last.T < TraceEvery) return;
        if (_rescueTrace[slot] is { } prev)
        {
            var moved = SmokeController.DistanceNm(prev.Lat, prev.Lon, v.Lat, v.Lon) * 1852;
            var track = moved < 0.5 ? "-" : $"{RescueController.Bearing((prev.Lat, prev.Lon), (v.Lat, v.Lon)):0}";
            Diag($"rescue slot {slot} {_rescueTitle[slot]} driving: sim hdg {RescueController.Norm(v.Hdg):0}, body z {v.BodyZ:0.0} ft/s, track {track}, moved {moved:0} m");
        }
        _rescueTrace[slot] = (now, v.Lat, v.Lon);
    }

    /// <summary>Asks for the aircraft position for the rescue vehicles at most every <see cref="RescueController.MoveEvery"/>.</summary>
    private void PollRescue(SimConnect sc)
    {
        if (!_rescue.Active || clock.GetUtcNow() - _rescuePolled < RescueController.MoveEvery) return;
        _rescuePolled = clock.GetUtcNow();
        sc.RequestDataOnSimObject(Req.RescuePos, Def.Rescue, SimConnect.SIMCONNECT_OBJECT_ID_USER,
            SIMCONNECT_PERIOD.ONCE, SIMCONNECT_DATA_REQUEST_FLAG.DEFAULT, 0, 0, 0);
        foreach (var slot in _rescue.Driving)
        {
            if (_rescueId[slot] == 0) continue;
            sc.RequestDataOnSimObject((Req)((int)Req.VehiclePos + slot), Def.VehiclePos, _rescueId[slot],
                SIMCONNECT_PERIOD.ONCE, SIMCONNECT_DATA_REQUEST_FLAG.DEFAULT, 0, 0, 0);
        }
        for (var slot = 0; slot < _rescueHdgCheck.Length; slot++)
        {
            if (!_rescueHdgCheck[slot] || _rescueId[slot] == 0) continue;
            _rescueHdgCheck[slot] = false;
            sc.RequestDataOnSimObject((Req)((int)Req.VehicleHdg + slot), Def.Heading, _rescueId[slot],
                SIMCONNECT_PERIOD.ONCE, SIMCONNECT_DATA_REQUEST_FLAG.DEFAULT, 0, 0, 0);
        }
        for (var slot = 0; slot < _rescueHdgLate.Length; slot++)
        {
            if (_rescueHdgLate[slot] is not { } due || clock.GetUtcNow() < due || _rescueId[slot] == 0) continue;
            _rescueHdgLate[slot] = null;
            sc.RequestDataOnSimObject((Req)((int)Req.VehicleHdgLate + slot), Def.VehiclePos, _rescueId[slot],
                SIMCONNECT_PERIOD.ONCE, SIMCONNECT_DATA_REQUEST_FLAG.DEFAULT, 0, 0, 0);
        }
    }

    public Task RunAsync(ISimSink sink, CancellationToken ct) =>
        Task.Factory.StartNew(() => Loop(sink, ct), ct, TaskCreationOptions.LongRunning, TaskScheduler.Default);

    private void Loop(ISimSink sink, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            sink.OnStatus(BridgeStatus.Initial with { Sim = SimLink.Connecting });
            string? reason;
            try
            {
                reason = RunSession(sink, ct);
            }
            catch (COMException ex)
            {
                // Thrown by the constructor when the sim is not running, and by ReceiveMessage on a broken pipe.
                reason = $"simconnect: {ex.Message.Trim()}";
            }
            if (ct.IsCancellationRequested) break;

            var delay = _policy.NextDelay();
            sink.OnStatus(BridgeStatus.Initial with { Detail = reason, RetryInMs = (int)delay.TotalMilliseconds });
            if (ct.WaitHandle.WaitOne(delay)) break;
        }
        sink.OnStatus(BridgeStatus.Initial with { Detail = "stopped" });
    }

    /// <returns>Why the session ended.</returns>
    private string RunSession(ISimSink sink, CancellationToken ct)
    {
        using var signal = new EventWaitHandle(false, EventResetMode.AutoReset);
        using var sc = new SimConnect(ClientName, IntPtr.Zero, 0, signal, 0);

        var pump = new SnapshotPump(clock, sink.OnTelemetry);
        var open = false;
        string? ended = null;

        void Publish() =>
            sink.OnStatus(new BridgeStatus(SimLink.Connected, pump.Running, pump.Paused, pump.SimRate));

        sc.OnRecvOpen += (_, _) =>
        {
            open = true;
            _open = true;
            _policy.Reset();
            Publish();
        };
        sc.OnRecvQuit += (_, _) => ended = "sim quit";
        sc.OnRecvException += (_, data) =>
            // Usually a bad SimVar/unit in the definition; keep running, report it.
            sink.OnStatus(new BridgeStatus(SimLink.Connected, pump.Running, pump.Paused, pump.SimRate,
                Detail: $"simconnect exception {(SIMCONNECT_EXCEPTION)data.dwException} at param {data.dwIndex}"));
        sc.OnRecvEvent += (_, data) =>
        {
            var changed = (Evt)data.uEventID switch
            {
                Evt.Pause => pump.OnPauseFlags(data.dwData),
                Evt.Sim => SimRunning(data.dwData != 0),
                _ => false,
            };
            if (changed) Publish();
        };
        bool SimRunning(bool running)
        {
            _smoke.SimRunning(running);
            return pump.OnSimRunning(running);
        }
        sc.OnRecvSimobjectData += (_, data) =>
        {
            if ((Req)data.dwRequestID == Req.RescuePos)
            {
                ApplyRescue(sc, (RescuePos)data.dwData[0]);
                return;
            }
            var turned = (int)data.dwRequestID - (int)Req.VehicleHdg;
            if (turned >= 0 && turned < _rescueId.Length)
            {
                // Diagnostics for the human check (T54, 2026-10-17): does the heading hold, by model?
                var h = (Heading)data.dwData[0];
                Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] rescue slot {turned} {_rescueTitle[turned]} hdg asked {_rescueHdg[turned]:0}, sim {RescueController.Norm(h.Deg):0}");
                return;
            }
            var created = (int)data.dwRequestID - (int)Req.VehicleHdgInit;
            if (created >= 0 && created < _rescueId.Length)
            {
                // The heading the sim gave the new object (INITPOSITION.Heading), read before ours is set.
                var h0 = (Heading)data.dwData[0];
                Diag($"rescue slot {created} {_rescueTitle[created]} created: sim hdg {RescueController.Norm(h0.Deg):0} (INITPOSITION {_rescueSpawnHdg[created]:0})");
                if (_rescueId[created] != 0) SetHeading(sc, created);
                return;
            }
            var late = (int)data.dwRequestID - (int)Req.VehicleHdgLate;
            if (late >= 0 && late < _rescueId.Length)
            {
                var v3 = (VehiclePos)data.dwData[0];
                Diag($"rescue slot {late} {_rescueTitle[late]} 3 s after the set: sim hdg {RescueController.Norm(v3.Hdg):0} (asked {_rescueHdg[late]:0}), body z {v3.BodyZ:0.0} ft/s");
                return;
            }
            var vehicle = (int)data.dwRequestID - (int)Req.VehiclePos;
            if (vehicle >= 0 && vehicle < RescueController.MaxFire)
            {
                var v = (VehiclePos)data.dwData[0];
                _rescue.VehiclePosition(vehicle, v.Lat, v.Lon);
                TraceDriving(vehicle, v);
                return;
            }
            if ((Req)data.dwRequestID != Req.Telemetry) return;
            var raw = (RawData)data.dwData[0];
            var before = pump.SimRate;
            pump.OnFrame(new SimFrame(raw.Values, raw.Title ?? ""));
            if (Math.Abs(pump.SimRate - before) > 1e-6) Publish();
            ApplySmoke(sc, raw.Values[SimVars.Lat], raw.Values[SimVars.Lon]);
        };
        sc.OnRecvAssignedObjectId += (_, data) =>
        {
            var slot = (int)data.dwRequestID - (int)Req.RescueSpawn;
            if (slot >= 0 && slot < _rescueId.Length)
            {
                if (_rescueAsked[slot] > 0) _rescueAsked[slot]--;
                if (_rescueRemoveWhenAssigned[slot] > 0)
                {
                    _rescueRemoveWhenAssigned[slot]--;
                    sc.AIRemoveObject(data.dwObjectID, Req.RescueRemove);
                }
                else
                {
                    _rescueId[slot] = data.dwObjectID;
                    SetSim(sc, data.dwObjectID, _rescueSimOn[slot]);
                    // Read the heading of the creation first; ours is set when it comes (diagnostics, 2026-10-17).
                    sc.RequestDataOnSimObject((Req)((int)Req.VehicleHdgInit + slot), Def.Heading, data.dwObjectID,
                        SIMCONNECT_PERIOD.ONCE, SIMCONNECT_DATA_REQUEST_FLAG.DEFAULT, 0, 0, 0);
                }
                return;
            }
            if ((Req)data.dwRequestID != Req.Smoke) return;
            if (_smokeAsked > 0) _smokeAsked--;
            if (_smokeRemoveWhenAssigned > 0)
            {
                _smokeRemoveWhenAssigned--;
                sc.AIRemoveObject(data.dwObjectID, Req.SmokeRemove);
            }
            else _smokeId = data.dwObjectID;
        };

        foreach (var v in SimVars.Definitions)
            sc.AddToDataDefinition(Def.Telemetry, v.Name, v.Unit, SIMCONNECT_DATATYPE.FLOAT64, 0f, SimConnect.SIMCONNECT_UNUSED);
        sc.AddToDataDefinition(Def.Telemetry, "TITLE", null, SIMCONNECT_DATATYPE.STRING256, 0f, SimConnect.SIMCONNECT_UNUSED);
        sc.RegisterDataDefineStruct<RawData>(Def.Telemetry);

        // T54: the aircraft for the rescue vehicles, and the waypoint list that drives them (MSFS SDK,
        // SIMCONNECT_DATA_WAYPOINT and the AI WAYPOINT LIST SimVar, checked 2026-10-17).
        (string Name, string Unit)[] rescueVars =
        [
            ("PLANE LATITUDE", "degrees"), ("PLANE LONGITUDE", "degrees"), ("PLANE ALTITUDE", "feet"),
            ("PLANE HEADING DEGREES TRUE", "degrees"), ("GROUND VELOCITY", "knots"), ("SIM ON GROUND", "Bool"),
            ("BRAKE PARKING POSITION", "Bool"),
        ];
        foreach (var (name, unit) in rescueVars)
            sc.AddToDataDefinition(Def.Rescue, name, unit, SIMCONNECT_DATATYPE.FLOAT64, 0f, SimConnect.SIMCONNECT_UNUSED);
        sc.RegisterDataDefineStruct<RescuePos>(Def.Rescue);
        sc.AddToDataDefinition(Def.Waypoint, "AI WAYPOINT LIST", "number", SIMCONNECT_DATATYPE.WAYPOINT, 0f, SimConnect.SIMCONNECT_UNUSED);
        // SIM DISABLED: Bool, settable (SimVars, Miscellaneous Variables, SDK 2024, checked 2026-10-17).
        sc.AddToDataDefinition(Def.SimDisabled, "SIM DISABLED", "Bool", SIMCONNECT_DATATYPE.FLOAT64, 0f, SimConnect.SIMCONNECT_UNUSED);
        sc.RegisterDataDefineStruct<SimDisabled>(Def.SimDisabled);
        sc.AddToDataDefinition(Def.VehiclePos, "PLANE LATITUDE", "degrees", SIMCONNECT_DATATYPE.FLOAT64, 0f, SimConnect.SIMCONNECT_UNUSED);
        sc.AddToDataDefinition(Def.VehiclePos, "PLANE LONGITUDE", "degrees", SIMCONNECT_DATATYPE.FLOAT64, 0f, SimConnect.SIMCONNECT_UNUSED);
        // Diagnostics: heading and VELOCITY BODY Z ("true longitudinal speed, relative to aircraft Z axis", Aircraft Misc Variables).
        sc.AddToDataDefinition(Def.VehiclePos, "PLANE HEADING DEGREES TRUE", "degrees", SIMCONNECT_DATATYPE.FLOAT64, 0f, SimConnect.SIMCONNECT_UNUSED);
        sc.AddToDataDefinition(Def.VehiclePos, "VELOCITY BODY Z", "feet per second", SIMCONNECT_DATATYPE.FLOAT64, 0f, SimConnect.SIMCONNECT_UNUSED);
        sc.RegisterDataDefineStruct<VehiclePos>(Def.VehiclePos);
        // PLANE HEADING DEGREES TRUE: settable (Aircraft Misc Variables, SDK 2024, checked 2026-10-17); asked in degrees.
        sc.AddToDataDefinition(Def.Heading, "PLANE HEADING DEGREES TRUE", "degrees", SIMCONNECT_DATATYPE.FLOAT64, 0f, SimConnect.SIMCONNECT_UNUSED);
        sc.RegisterDataDefineStruct<Heading>(Def.Heading);

        // Pause_EX1 reports full / active / sim pause; "Sim" reports running state. Both fire at once
        // with the current state on subscription (SDK docs, SubscribeToSystemEvent).
        sc.SubscribeToSystemEvent(Evt.Pause, "Pause_EX1");
        sc.SubscribeToSystemEvent(Evt.Sim, "Sim");

        sc.RequestDataOnSimObject(Req.Telemetry, Def.Telemetry, SimConnect.SIMCONNECT_OBJECT_ID_USER,
            SIMCONNECT_PERIOD.SECOND, SIMCONNECT_DATA_REQUEST_FLAG.DEFAULT, 0, 0, 0);

        try
        {
            while (ended is null && !ct.IsCancellationRequested)
            {
                // Also poll on timeout: draining an empty queue is harmless and covers a missed signal.
                signal.WaitOne(PollInterval);
                sc.ReceiveMessage();
                if (open)
                {
                    pump.Tick();
                    PollRescue(sc);
                }
            }
        }
        finally
        {
            _open = false;
            // The sim takes its objects with it; a standing request spawns again in the next session.
            _smokeId = 0;
            _smokeAsked = 0;
            _smokeRemoveWhenAssigned = 0;
            _smoke.SessionEnded();
            Array.Clear(_rescueId);
            Array.Clear(_rescueAsked);
            Array.Clear(_rescueRemoveWhenAssigned);
            Array.Clear(_rescueSimOn);
            Array.Clear(_rescueHdgCheck);
            Array.Clear(_rescueHdgLate);
            Array.Clear(_rescueTrace);
            _rescue.SessionEnded();
        }
        return ended ?? "stopped";
    }
}
#endif
