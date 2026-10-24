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
/// an ambulance by their titles (<see cref="RescueController"/>), created with the same plain call. Every vehicle stands
/// with <c>SIM DISABLED</c> = 1 (set as soon as its id is known); the bridge moves the fire trucks itself, about every
/// <see cref="RescueController.StepEvery"/>, with <c>SIMCONNECT_DATA_INITPOSITION</c> ("Initial Position", which the
/// SDK allows "to incrementally move or reposition" objects not controlled by the user) on every visual frame (the
/// "Frame" system event; the 100 ms timer only when no frame comes, e.g. paused). While they are wanted the
/// aircraft position is read every <see cref="RescueController.MoveEvery"/>; diagnostics go to the console.
/// </summary>
public sealed class SimConnectSource(TimeProvider clock, ReconnectPolicy? policy = null) : ISimSource, ISimSession, ICommandTarget
{
    private enum Def { Telemetry, Rescue, SimDisabled, VehiclePos, Heading, Place }
    /// <summary>Rescue vehicles are created with <c>RescueSpawn + slot</c>; diagnostic reads use <c>VehicleHdgInit / VehicleSeen + slot</c>.</summary>
    private enum Req
    {
        Telemetry, Smoke, SmokeRemove, RescuePos, RescueRemove,
        RescueSpawn = 100, VehicleHdgInit = 400, VehicleSeen = 500,
    }
    private enum Evt { Pause, Sim, Frame }

    /// <summary>Wire layout of the data definition: FLOAT64 × SimVars.Count, then TITLE as STRING256.</summary>
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi, Pack = 1)]
    private struct RawData
    {
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = SimVars.Count)]
        public double[] Values;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string Title;
    }

    /// <summary>Aircraft position for the rescue vehicles (T54): FLOAT64 × 8, in this order.</summary>
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct RescuePos
    {
        public double Lat, Lon, Alt, Hdg, Gs, OnGround, ParkingBrake, FenixParkBrake;
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

    /// <summary>Where a rescue vehicle is, its heading and VELOCITY BODY Z (diagnostics): FLOAT64 × 4.</summary>
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
    /// <summary>TITLE of the last telemetry frame: the rescue position has none (Fenix parking brake).</summary>
    private string _title = "";
    /// <summary>Objects asked for and not yet assigned an id (ids come back in the order asked).</summary>
    private int _smokeAsked;
    /// <summary>How many of those are to be removed as soon as their id comes (a respawn may ask anew before).</summary>
    private int _smokeRemoveWhenAssigned;

    private readonly RescueController _rescue = new(clock, line => Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] {line}"));

    /// <summary>Rescue vehicles by slot, like the smoke object's fields; message thread only.</summary>
    private readonly uint[] _rescueId = new uint[RescueController.MaxFire + 1];
    private readonly int[] _rescueAsked = new int[RescueController.MaxFire + 1];
    private readonly int[] _rescueRemoveWhenAssigned = new int[RescueController.MaxFire + 1];
    /// <summary>Title and the heading of the creation, by slot (diagnostics).</summary>
    private readonly string[] _rescueTitle = new string[RescueController.MaxFire + 1];
    private readonly double[] _rescueSpawnHdg = new double[RescueController.MaxFire + 1];
    /// <summary>Diagnostics: when the sim's own view of each moving truck was last asked for.</summary>
    private readonly DateTimeOffset[] _rescueSeen = new DateTimeOffset[RescueController.MaxFire];
    /// <summary>Diagnostics: real intervals between position sets per truck (count, sum, max since the last report).</summary>
    private readonly DateTimeOffset[] _rescuePlacedAt = new DateTimeOffset[RescueController.MaxFire];
    private readonly (int N, double SumMs, double MaxMs, DateTimeOffset Since)[] _rescueRate = new (int, double, double, DateTimeOffset)[RescueController.MaxFire];
    private DateTimeOffset _rescuePolled, _rescueStepped, _rescueFramed;
    /// <summary>Without a "Frame" event this long (paused, a menu), the timer steps the trucks.</summary>
    private static readonly TimeSpan FrameGap = TimeSpan.FromMilliseconds(250);

    private static void Diag(string line) => Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] {line}");

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

    /// <summary>Message thread: carries out what <see cref="RescueController"/> decides.</summary>
    private void ApplyRescue(SimConnect sc, IReadOnlyList<RescueAction> actions)
    {
        foreach (var x in actions)
        {
            switch (x.Kind)
            {
                case RescueActionKind.Spawn:
                    _rescueAsked[x.Slot]++;
                    _rescueTitle[x.Slot] = x.Title;
                    _rescueSpawnHdg[x.Slot] = x.Hdg;
                    sc.AICreateSimulatedObject(x.Title, OnGroundAt(x.Lat, x.Lon, x.Hdg), (Req)((int)Req.RescueSpawn + x.Slot));
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
                case RescueActionKind.Place when _rescueId[x.Slot] != 0:
                    sc.SetDataOnSimObject(Def.Place, _rescueId[x.Slot], SIMCONNECT_DATA_SET_FLAG.DEFAULT, OnGroundAt(x.Lat, x.Lon, x.Hdg));
                    TracePlaceRate(x.Slot);
                    break;
            }
        }
    }

    /// <summary>Diagnostics (2026-10-17, "slideshow"): every 2 s per truck, how often its position was really set.</summary>
    private void TracePlaceRate(int slot)
    {
        var now = DateTimeOffset.UtcNow; // wall clock: the real interval, not the injected one
        var r = _rescueRate[slot];
        if (_rescuePlacedAt[slot] != default && now - _rescuePlacedAt[slot] < TimeSpan.FromSeconds(5))
        {
            var ms = (now - _rescuePlacedAt[slot]).TotalMilliseconds;
            r = (r.N + 1, r.SumMs + ms, Math.Max(r.MaxMs, ms), r.Since == default ? now : r.Since);
        }
        else r = (0, 0, 0, now);
        _rescuePlacedAt[slot] = now;
        if (now - r.Since >= TimeSpan.FromSeconds(2) && r.N > 0)
        {
            Diag($"rescue slot {slot} {_rescueTitle[slot]} position sets: {r.N} in {(now - r.Since).TotalSeconds:0.0} s, interval avg {r.SumMs / r.N:0} ms, max {r.MaxMs:0} ms");
            r = (0, 0, 0, now);
        }
        _rescueRate[slot] = r;
    }

    /// <summary>A place on the ground (OnGround = 1: the sim puts it on the terrain), standing.</summary>
    private static SIMCONNECT_DATA_INITPOSITION OnGroundAt(double lat, double lon, double hdg) => new()
    {
        Latitude = lat, Longitude = lon, Altitude = 0, Pitch = 0, Bank = 0, Heading = hdg, OnGround = 1, Airspeed = 0,
    };

    /// <summary><c>SIM DISABLED</c> = 1: the vehicle does not move by itself (created vehicles otherwise roll away).</summary>
    private static void Hold(SimConnect sc, uint id) =>
        sc.SetDataOnSimObject(Def.SimDisabled, id, SIMCONNECT_DATA_SET_FLAG.DEFAULT, new SimDisabled { Value = 1 });

    /// <summary>
    /// Moves the trucks about every <see cref="RescueController.StepEvery"/>, asks for the aircraft position every
    /// <see cref="RescueController.MoveEvery"/>, and every 2 s for the sim's own view of each moving truck (console).
    /// </summary>
    private void PollRescue(SimConnect sc)
    {
        if (!_rescue.Active) return;
        var now = clock.GetUtcNow();
        if (now - _rescueFramed >= FrameGap && now - _rescueStepped >= RescueController.StepEvery)
        {
            _rescueStepped = now;
            ApplyRescue(sc, _rescue.Step());
        }
        if (now - _rescuePolled < RescueController.MoveEvery) return;
        _rescuePolled = now;
        sc.RequestDataOnSimObject(Req.RescuePos, Def.Rescue, SimConnect.SIMCONNECT_OBJECT_ID_USER,
            SIMCONNECT_PERIOD.ONCE, SIMCONNECT_DATA_REQUEST_FLAG.DEFAULT, 0, 0, 0);
        if (!_rescue.Moving) return;
        for (var slot = 0; slot < RescueController.MaxFire; slot++)
        {
            if (_rescueId[slot] == 0 || _rescue.PositionOf(slot) is null || now - _rescueSeen[slot] < RescueController.TraceEvery) continue;
            _rescueSeen[slot] = now;
            sc.RequestDataOnSimObject((Req)((int)Req.VehicleSeen + slot), Def.VehiclePos, _rescueId[slot],
                SIMCONNECT_PERIOD.ONCE, SIMCONNECT_DATA_REQUEST_FLAG.DEFAULT, 0, 0, 0);
        }
    }

    public Task RunAsync(ISimSink sink, CancellationToken ct) => SimLoop.RunAsync([this], sink, _policy, clock, ct);

    /// <summary>One SimConnect session on its own thread (ReceiveMessage blocks).</summary>
    public Task<SessionEnd> RunSessionAsync(ISimSink sink, CancellationToken ct) =>
        Task.Factory.StartNew(() =>
        {
            var answered = false;
            try
            {
                return new SessionEnd(RunSession(sink, () => answered = true, ct), answered);
            }
            catch (COMException ex)
            {
                // Thrown by the constructor when the sim is not running, and by ReceiveMessage on a broken pipe.
                return new SessionEnd($"simconnect: {ex.Message.Trim()}", answered);
            }
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);

    /// <returns>Why the session ended.</returns>
    private string RunSession(ISimSink sink, Action onOpen, CancellationToken ct)
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
            onOpen();
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
                var p = (RescuePos)data.dwData[0];
                ApplyRescue(sc, _rescue.OnPosition(new RescueAircraft(p.Lat, p.Lon, p.Hdg, p.Gs, p.OnGround != 0,
                    TelemetryMapper.ParkingBrakeSet(p.ParkingBrake, p.FenixParkBrake, _title))));
                return;
            }
            var created = (int)data.dwRequestID - (int)Req.VehicleHdgInit;
            if (created >= 0 && created <= RescueController.MaxFire)
            {
                // Diagnostics: the heading the sim gave the new object (INITPOSITION.Heading, drawing-corrected for trucks).
                var h0 = (Heading)data.dwData[0];
                Diag($"rescue slot {created} {_rescueTitle[created]} created: sim hdg {RescueController.Norm(h0.Deg):0} (INITPOSITION {_rescueSpawnHdg[created]:0})");
                return;
            }
            var seen = (int)data.dwRequestID - (int)Req.VehicleSeen;
            if (seen >= 0 && seen < RescueController.MaxFire)
            {
                // Diagnostics: does the sim keep the truck where the bridge put it?
                var v = (VehiclePos)data.dwData[0];
                var ours = _rescue.PositionOf(seen);
                var off = ours is { } o ? $"{SmokeController.DistanceNm(o.Lat, o.Lon, v.Lat, v.Lon) * 1852:0.0} m" : "-";
                Diag($"rescue slot {seen} {_rescueTitle[seen]} in the sim: hdg {RescueController.Norm(v.Hdg):0}, body z {v.BodyZ:0.0} ft/s, {off} from where the bridge put it");
                return;
            }
            if ((Req)data.dwRequestID != Req.Telemetry) return;
            var raw = (RawData)data.dwData[0];
            _title = raw.Title ?? "";
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
                    Hold(sc, data.dwObjectID);
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

        // T54: the aircraft for the rescue vehicles.
        (string Name, string Unit)[] rescueVars =
        [
            ("PLANE LATITUDE", "degrees"), ("PLANE LONGITUDE", "degrees"), ("PLANE ALTITUDE", "feet"),
            ("PLANE HEADING DEGREES TRUE", "degrees"), ("GROUND VELOCITY", "knots"), ("SIM ON GROUND", "Bool"),
            ("BRAKE PARKING POSITION", "Bool"), (SimVars.FenixParkBrakeLvar, "number"),
        ];
        foreach (var (name, unit) in rescueVars)
            sc.AddToDataDefinition(Def.Rescue, name, unit, SIMCONNECT_DATATYPE.FLOAT64, 0f, SimConnect.SIMCONNECT_UNUSED);
        sc.RegisterDataDefineStruct<RescuePos>(Def.Rescue);
        // SIM DISABLED: Bool, settable (SimVars, Miscellaneous Variables, SDK 2024, checked 2026-10-17).
        sc.AddToDataDefinition(Def.SimDisabled, "SIM DISABLED", "Bool", SIMCONNECT_DATATYPE.FLOAT64, 0f, SimConnect.SIMCONNECT_UNUSED);
        sc.RegisterDataDefineStruct<SimDisabled>(Def.SimDisabled);
        // Moving a truck: "Initial Position" with SIMCONNECT_DATATYPE_INITPOSITION (SimConnect_SetDataOnSimObject, SDK 2024,
        // checked 2026-10-17; SIMCONNECT_DATA_INITPOSITION: "can be used to incrementally move or reposition … any other
        // aircraft not controlled by the user").
        sc.AddToDataDefinition(Def.Place, "Initial Position", null, SIMCONNECT_DATATYPE.INITPOSITION, 0f, SimConnect.SIMCONNECT_UNUSED);
        sc.RegisterDataDefineStruct<SIMCONNECT_DATA_INITPOSITION>(Def.Place);
        // Diagnostics: position, heading and VELOCITY BODY Z ("true longitudinal speed, relative to aircraft Z axis").
        sc.AddToDataDefinition(Def.VehiclePos, "PLANE LATITUDE", "degrees", SIMCONNECT_DATATYPE.FLOAT64, 0f, SimConnect.SIMCONNECT_UNUSED);
        sc.AddToDataDefinition(Def.VehiclePos, "PLANE LONGITUDE", "degrees", SIMCONNECT_DATATYPE.FLOAT64, 0f, SimConnect.SIMCONNECT_UNUSED);
        sc.AddToDataDefinition(Def.VehiclePos, "PLANE HEADING DEGREES TRUE", "degrees", SIMCONNECT_DATATYPE.FLOAT64, 0f, SimConnect.SIMCONNECT_UNUSED);
        sc.AddToDataDefinition(Def.VehiclePos, "VELOCITY BODY Z", "feet per second", SIMCONNECT_DATATYPE.FLOAT64, 0f, SimConnect.SIMCONNECT_UNUSED);
        sc.RegisterDataDefineStruct<VehiclePos>(Def.VehiclePos);
        sc.AddToDataDefinition(Def.Heading, "PLANE HEADING DEGREES TRUE", "degrees", SIMCONNECT_DATATYPE.FLOAT64, 0f, SimConnect.SIMCONNECT_UNUSED);
        sc.RegisterDataDefineStruct<Heading>(Def.Heading);

        // Pause_EX1 reports full / active / sim pause; "Sim" reports running state. Both fire at once
        // with the current state on subscription (SDK docs, SubscribeToSystemEvent).
        sc.SubscribeToSystemEvent(Evt.Pause, "Pause_EX1");
        sc.SubscribeToSystemEvent(Evt.Sim, "Sim");
        // T54: "Frame" — "Request notifications every visual frame" (SubscribeToSystemEvent, SDK 2024, checked
        // 2026-10-17): the moving trucks are stepped on every rendered frame, so they move smoothly.
        sc.SubscribeToSystemEvent(Evt.Frame, "Frame");
        sc.OnRecvEventFrame += (_, _) =>
        {
            if (!open || !_rescue.Moving) return;
            _rescueFramed = clock.GetUtcNow();
            ApplyRescue(sc, _rescue.Step());
        };

        sc.RequestDataOnSimObject(Req.Telemetry, Def.Telemetry, SimConnect.SIMCONNECT_OBJECT_ID_USER,
            SIMCONNECT_PERIOD.SECOND, SIMCONNECT_DATA_REQUEST_FLAG.DEFAULT, 0, 0, 0);

        try
        {
            while (ended is null && !ct.IsCancellationRequested)
            {
                // Also poll on timeout: draining an empty queue is harmless and covers a missed signal.
                // While trucks move, wake often enough to move them about every RescueController.StepEvery.
                signal.WaitOne(_rescue.Moving ? RescueController.StepEvery : PollInterval);
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
            Array.Clear(_rescueSeen);
            Array.Clear(_rescuePlacedAt);
            Array.Clear(_rescueRate);
            _rescue.SessionEnded();
        }
        return ended ?? "stopped";
    }
}
#endif
