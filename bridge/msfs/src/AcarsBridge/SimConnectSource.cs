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
/// non-modular SimObject, which the plain call supports).
/// </summary>
public sealed class SimConnectSource(TimeProvider clock, ReconnectPolicy? policy = null) : ISimSource, ICommandTarget
{
    private enum Def { Telemetry }
    private enum Req { Telemetry, Smoke, SmokeRemove }
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
    private bool _smokeAsked;
    private bool _smokeRemoveWhenAssigned;

    public IReadOnlyCollection<string> Commands { get; } = ["ping", "smoke_start", "smoke_stop"];

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
                _smokeAsked = true;
                _smokeRemoveWhenAssigned = false;
                sc.AICreateSimulatedObject(SmokeTitle, at, Req.Smoke);
                break;
            case SmokeAction.Remove:
                if (_smokeId != 0)
                {
                    sc.AIRemoveObject(_smokeId, Req.SmokeRemove);
                    _smokeId = 0;
                }
                else if (_smokeAsked)
                    _smokeRemoveWhenAssigned = true;
                break;
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
            if ((Req)data.dwRequestID != Req.Telemetry) return;
            var raw = (RawData)data.dwData[0];
            var before = pump.SimRate;
            pump.OnFrame(new SimFrame(raw.Values, raw.Title ?? ""));
            if (Math.Abs(pump.SimRate - before) > 1e-6) Publish();
            ApplySmoke(sc, raw.Values[SimVars.Lat], raw.Values[SimVars.Lon]);
        };
        sc.OnRecvAssignedObjectId += (_, data) =>
        {
            if ((Req)data.dwRequestID != Req.Smoke) return;
            _smokeAsked = false;
            if (_smokeRemoveWhenAssigned)
            {
                _smokeRemoveWhenAssigned = false;
                sc.AIRemoveObject(data.dwObjectID, Req.SmokeRemove);
            }
            else _smokeId = data.dwObjectID;
        };

        foreach (var v in SimVars.Definitions)
            sc.AddToDataDefinition(Def.Telemetry, v.Name, v.Unit, SIMCONNECT_DATATYPE.FLOAT64, 0f, SimConnect.SIMCONNECT_UNUSED);
        sc.AddToDataDefinition(Def.Telemetry, "TITLE", null, SIMCONNECT_DATATYPE.STRING256, 0f, SimConnect.SIMCONNECT_UNUSED);
        sc.RegisterDataDefineStruct<RawData>(Def.Telemetry);

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
                if (open) pump.Tick();
            }
        }
        finally
        {
            _open = false;
            // The sim takes its objects with it; a standing request spawns again in the next session.
            _smokeId = 0;
            _smokeAsked = false;
            _smokeRemoveWhenAssigned = false;
            _smoke.SessionEnded();
        }
        return ended ?? "stopped";
    }
}
#endif
