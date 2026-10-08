#if SIMCONNECT
using System.Runtime.InteropServices;
using Microsoft.FlightSimulator.SimConnect;

namespace AcarsBridge;

/// <summary>
/// MSFS via managed SimConnect (MSFS SDK). Compiled only when the SDK is found (see the .csproj).
/// No window: SimConnect signals an <see cref="EventWaitHandle"/>, and a dedicated thread calls
/// ReceiveMessage. Reconnects with <see cref="ReconnectPolicy"/> when the sim is not running or quits.
/// </summary>
public sealed class SimConnectSource(TimeProvider clock, ReconnectPolicy? policy = null) : ISimSource
{
    private enum Def { Telemetry }
    private enum Req { Telemetry }
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
                Evt.Sim => pump.OnSimRunning(data.dwData != 0),
                _ => false,
            };
            if (changed) Publish();
        };
        sc.OnRecvSimobjectData += (_, data) =>
        {
            if ((Req)data.dwRequestID != Req.Telemetry) return;
            var raw = (RawData)data.dwData[0];
            var before = pump.SimRate;
            pump.OnFrame(new SimFrame(raw.Values, raw.Title ?? ""));
            if (Math.Abs(pump.SimRate - before) > 1e-6) Publish();
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

        while (ended is null && !ct.IsCancellationRequested)
        {
            // Also poll on timeout: draining an empty queue is harmless and covers a missed signal.
            signal.WaitOne(PollInterval);
            sc.ReceiveMessage();
            if (open) pump.Tick();
        }
        return ended ?? "stopped";
    }
}
#endif
