// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using AcarsBridge;
using Xunit;

namespace AcarsBridge.Tests;

/// <summary>
/// T73: the SimConnect layer without the simulator — a fake <see cref="ISimConnectNative"/> hands over messages, and
/// <see cref="SimConnectClient"/> / <see cref="SimConnectSource"/> turn them into events and telemetry.
/// </summary>
public class SimConnectTests
{
    // Request and event ids of SimConnectSource (private enums there).
    private const uint ReqTelemetry = 0, ReqSmoke = 1;
    private const uint EvtPause = 0, EvtSim = 1, EvtFrame = 2;

    /// <summary>A fake session: <see cref="Messages"/> are what the sim sends, <see cref="Calls"/> what the bridge asked for.</summary>
    private sealed class FakeNative : ISimConnectNative
    {
        private readonly object _gate = new();
        private readonly Queue<SimMessage> _messages = new();
        private readonly List<string> _calls = [];
        public bool Disposed;

        public void Send(SimMessage m)
        {
            lock (_gate) _messages.Enqueue(m);
        }

        public string[] Calls
        {
            get { lock (_gate) return [.. _calls]; }
        }

        private void Log(string call)
        {
            lock (_gate) _calls.Add(call);
        }

        public void DefineFloat64(uint def, string name, string? unit) => Log($"define {def} {name} {unit}");
        public void DefineString256(uint def, string name) => Log($"define-string {def} {name}");
        public void DefinePosition(uint def) => Log($"define-position {def}");
        public void RequestData(uint request, uint def, uint objectId, SimPeriod period) => Log($"request {request} {def} {objectId} {period}");
        public void SetFloat64(uint def, uint objectId, double value) => Log($"set {def} {objectId} {value}");
        public void SetPosition(uint def, uint objectId, in SimPosition p) => Log($"place {def} {objectId} {p.Latitude:0.####} {p.Longitude:0.####} {p.Heading:0} ground={p.OnGround}");
        public void SubscribeEvent(uint eventId, string name) => Log($"subscribe {eventId} {name}");
        public void SetEventState(uint eventId, bool on) => Log($"event-state {eventId} {(on ? "on" : "off")}");
        public void CreateObject(string title, in SimPosition p, uint request) => Log($"create {title} {request} {p.Latitude:0.####} {p.Longitude:0.####} ground={p.OnGround}");
        public void RemoveObject(uint objectId, uint request) => Log($"remove {objectId} {request}");

        public SimMessage Next()
        {
            lock (_gate) return _messages.TryDequeue(out var m) ? m : new SimMessage(SimMessageKind.None);
        }

        public void Dispose() => Disposed = true;
    }

    /// <summary>The bytes of the telemetry definition: FLOAT64 × <see cref="SimVars.Count"/>, then TITLE as STRING256.</summary>
    private static byte[] FrameBytes(SimFrame f)
    {
        var bytes = new byte[SimVars.Count * sizeof(double) + 256];
        Buffer.BlockCopy(f.Values, 0, bytes, 0, SimVars.Count * sizeof(double));
        Encoding.UTF8.GetBytes(f.Title.TrimEnd('\0')).CopyTo(bytes, SimVars.Count * sizeof(double));
        return bytes;
    }

    private static SimMessage Data(uint request, byte[] bytes, uint objectId = 1) =>
        new(SimMessageKind.SimobjectData, RequestId: request, ObjectId: objectId, Data: bytes);

    [Fact]
    public void ReadFrame_decodes_the_values_and_the_zero_padded_title()
    {
        var data = new SimObjectData(ReqTelemetry, 1, FrameBytes(Frames.Sample()));
        var (values, title) = data.ReadFrame(SimVars.Count);
        Assert.Equal(Frames.Sample().Values, values);
        Assert.Equal("FenixA320_DLH", title);
    }

    [Fact]
    public void ReadFrame_and_Read_reject_data_that_is_too_short()
    {
        var bytes = FrameBytes(Frames.Sample());
        Assert.Throws<InvalidDataException>(() => new SimObjectData(0, 1, bytes[..^1]).ReadFrame(SimVars.Count));
        Assert.Throws<InvalidDataException>(() => new SimObjectData(0, 1, new byte[7]).Read<double>());
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct TwoDoubles
    {
        public double A, B;
    }

    [Fact]
    public void Read_takes_a_struct_of_doubles_from_the_start_of_the_data()
    {
        var bytes = new byte[16 + 8];
        BitConverter.GetBytes(1.5).CopyTo(bytes, 0);
        BitConverter.GetBytes(-2.25).CopyTo(bytes, 8);
        var v = new SimObjectData(0, 1, bytes).Read<TwoDoubles>();
        Assert.Equal((1.5, -2.25), (v.A, v.B));
    }

    [Fact]
    public void Client_raises_one_event_per_message_and_counts_every_message()
    {
        var fake = new FakeNative();
        using var client = new SimConnectClient(fake);
        var seen = new List<string>();
        client.OnRecvOpen += () => seen.Add("open");
        client.OnRecvQuit += () => seen.Add("quit");
        client.OnRecvException += (code, index) => seen.Add($"exception {code} {index}");
        client.OnRecvEvent += (id, data) => seen.Add($"event {id} {data}");
        client.OnRecvEventFrame += id => seen.Add($"frame {id}");
        client.OnRecvSimobjectData += d => seen.Add($"data {d.RequestId} {d.ObjectId} {d.Bytes.Length}");
        client.OnRecvAssignedObjectId += (request, obj) => seen.Add($"assigned {request} {obj}");

        fake.Send(new SimMessage(SimMessageKind.Open));
        fake.Send(new SimMessage(SimMessageKind.Event, EventId: EvtPause, Value: 3));
        fake.Send(new SimMessage(SimMessageKind.Other)); // a kind the bridge ignores still counts
        fake.Send(new SimMessage(SimMessageKind.EventFrame, EventId: EvtFrame));
        fake.Send(Data(5, new byte[12], objectId: 9));
        fake.Send(new SimMessage(SimMessageKind.AssignedObjectId, RequestId: 104, ObjectId: 77));
        fake.Send(new SimMessage(SimMessageKind.Exception, Value: 7, Index: 2));
        fake.Send(new SimMessage(SimMessageKind.Quit));

        var n = SimQueue.Drain(() => client.ReceiveMessage(), () => client.Handled);

        Assert.Equal(8, n);
        Assert.Equal(8, client.Handled);
        Assert.Equal(
            ["open", "event 0 3", "frame 2", "data 5 9 12", "assigned 104 77", "exception 7 2", "quit"],
            seen);
        Assert.False(client.ReceiveMessage()); // empty
        Assert.Equal(8, client.Handled);
    }

    [Fact]
    public void Dispose_closes_the_session()
    {
        var fake = new FakeNative();
        new SimConnectClient(fake).Dispose();
        Assert.True(fake.Disposed);
    }

    [Theory]
    [InlineData(0u, "NONE")]
    [InlineData(7u, "NAME_UNRECOGNIZED")]
    [InlineData(46u, "CAMERA_API")]
    [InlineData(47u, "47")]
    public void ExceptionName_follows_SimConnect_h(uint code, string name) =>
        Assert.Equal(name, SimConnectClient.ExceptionName(code));

    private static async Task<T> Until<T>(Func<T?> get, string what) where T : class
    {
        var until = DateTime.UtcNow.AddSeconds(10);
        while (DateTime.UtcNow < until)
        {
            if (get() is { } v) return v;
            await Task.Delay(20);
        }
        throw new TimeoutException(what);
    }

    private static Dictionary<string, JsonValue> Args(params (string Name, double Value)[] args) =>
        args.ToDictionary(a => a.Name, a => JsonValue.Create(a.Value)!);

    private static SimConnectSource Source(FakeNative fake, ManualClock clock) =>
        new(clock, null, (_, _) => fake);

    [Fact]
    public async Task Session_defines_subscribes_and_turns_the_frames_into_telemetry()
    {
        var fake = new FakeNative();
        fake.Send(new SimMessage(SimMessageKind.Open));
        fake.Send(new SimMessage(SimMessageKind.Event, EventId: EvtSim, Value: 1));
        fake.Send(Data(ReqTelemetry, FrameBytes(Frames.Sample())));
        var sink = new RecordingSink();
        using var cts = new CancellationTokenSource();

        var run = ((ISimSession)Source(fake, ManualClock.At(1_791_374_400_000))).RunSessionAsync(sink, cts.Token);
        await Until(() => sink.Telemetry.Count > 0 ? sink : null, "telemetry");
        cts.Cancel();
        var end = await run;

        Assert.True(end.Answered);
        Assert.Equal("stopped", end.Reason);
        Assert.True(fake.Disposed);
        var t = sink.Telemetry[0];
        Assert.Equal(50.0379, t.Lat, 4);
        Assert.Equal("FenixA320_DLH", t.AircraftTitle);
        Assert.Contains(sink.Statuses, s => s.Sim == SimLink.Connected && s.Running);

        var calls = fake.Calls;
        Assert.Contains("define-string 0 TITLE", calls);
        Assert.Equal(SimVars.Count + 1, calls.Count(c => c.StartsWith("define 0 ") || c == "define-string 0 TITLE"));
        Assert.Contains("define-position 5", calls); // Place
        Assert.Contains("subscribe 0 Pause_EX1", calls);
        Assert.Contains("subscribe 1 Sim", calls);
        Assert.Contains("subscribe 2 Frame", calls);
        Assert.Contains($"event-state {EvtFrame} off", calls); // frames only while trucks move
        Assert.Contains($"request {ReqTelemetry} 0 0 Second", calls);
    }

    [Fact]
    public async Task Pause_flags_and_exceptions_are_reported_and_quit_ends_the_session()
    {
        var fake = new FakeNative();
        fake.Send(new SimMessage(SimMessageKind.Open));
        fake.Send(new SimMessage(SimMessageKind.Event, EventId: EvtSim, Value: 1));
        fake.Send(new SimMessage(SimMessageKind.Event, EventId: EvtPause, Value: 4));
        fake.Send(new SimMessage(SimMessageKind.Exception, Value: 7, Index: 3));
        fake.Send(new SimMessage(SimMessageKind.Quit));
        var sink = new RecordingSink();

        var end = await ((ISimSession)Source(fake, ManualClock.At(1_791_374_400_000))).RunSessionAsync(sink, CancellationToken.None);

        Assert.Equal("sim quit", end.Reason);
        Assert.True(end.Answered);
        Assert.Contains(sink.Statuses, s => s.Paused);
        Assert.Contains(sink.Statuses, s => s.Detail == "simconnect exception NAME_UNRECOGNIZED at param 3");
    }

    [Fact]
    public async Task Smoke_is_created_where_asked_when_the_aircraft_is_near_and_removed_on_stop()
    {
        var fake = new FakeNative();
        fake.Send(new SimMessage(SimMessageKind.Open));
        fake.Send(new SimMessage(SimMessageKind.Event, EventId: EvtSim, Value: 1));
        var sink = new RecordingSink();
        var source = Source(fake, ManualClock.At(1_791_374_400_000));
        using var cts = new CancellationTokenSource();
        var run = ((ISimSession)source).RunSessionAsync(sink, cts.Token);
        await Until(() => sink.Statuses.Any(s => s.Running) ? sink : null, "running");

        var start = await source.ExecuteAsync(new SimCommand("a", "smoke_start", Args(("lat", 50.1), ("lon", 8.6))), cts.Token);
        Assert.True(start.Ok);
        fake.Send(Data(ReqTelemetry, FrameBytes(Frames.Sample()))); // the aircraft is at EDDF, ~7 NM away
        await Until(() => fake.Calls.Any(c => c.StartsWith("create ")) ? fake : null, "create");
        Assert.Contains($"create {SimConnectSource.SmokeTitle} {ReqSmoke} 50.1 8.6 ground=1", fake.Calls);

        fake.Send(new SimMessage(SimMessageKind.AssignedObjectId, RequestId: ReqSmoke, ObjectId: 77));
        await source.ExecuteAsync(new SimCommand("b", "smoke_stop", Args()), cts.Token);
        fake.Send(Data(ReqTelemetry, FrameBytes(Frames.Sample())));
        await Until(() => fake.Calls.Any(c => c.StartsWith("remove 77")) ? fake : null, "remove");

        cts.Cancel();
        await run;
    }

    [Fact]
    public async Task A_session_that_cannot_open_ends_unanswered_with_the_reason()
    {
        static ISimConnectNative NoSim(string name, Microsoft.Win32.SafeHandles.SafeWaitHandle signal) =>
            throw new COMException("SimConnect open: the simulator is not running or does not answer (0x80004005)", unchecked((int)0x80004005));
        var end = await ((ISimSession)new SimConnectSource(ManualClock.At(0), null, NoSim)).RunSessionAsync(new RecordingSink(), CancellationToken.None);
        Assert.False(end.Answered);
        Assert.StartsWith("simconnect: ", end.Reason);
        Assert.Contains("not running", end.Reason);

        static ISimConnectNative NoDll(string name, Microsoft.Win32.SafeHandles.SafeWaitHandle signal) =>
            throw new DllNotFoundException("acars_simconnect.dll not found next to the bridge");
        end = await ((ISimSession)new SimConnectSource(ManualClock.At(0), null, NoDll)).RunSessionAsync(new RecordingSink(), CancellationToken.None);
        Assert.False(end.Answered);
        Assert.Contains("acars_simconnect.dll", end.Reason);
    }

    [Fact]
    public async Task A_frame_that_is_too_short_ends_the_session_with_a_reason_instead_of_crashing()
    {
        var fake = new FakeNative();
        fake.Send(new SimMessage(SimMessageKind.Open));
        fake.Send(Data(ReqTelemetry, new byte[10]));
        var end = await ((ISimSession)Source(fake, ManualClock.At(0))).RunSessionAsync(new RecordingSink(), CancellationToken.None);
        Assert.StartsWith("simconnect: ", end.Reason);
        Assert.True(fake.Disposed);
    }
}

/// <summary>
/// The real <c>acars_simconnect.dll</c>, when this machine built it (the MSFS SDK and the C++ tools were there): it loads,
/// has the ABI C# expects, and a session without the simulator fails cleanly. Without the DLL (CI) these pass without
/// doing anything: the part of T73 that needs the SDK is checked on the machine that has it.
/// </summary>
public class NativeSimConnectTests
{
    private static bool Built => File.Exists(Path.Combine(AppContext.BaseDirectory, "acars_simconnect.dll"));

    [Fact]
    public void The_native_layer_loads_and_has_the_expected_abi()
    {
        if (!Built) return;
        Assert.Null(NativeSimConnect.Probe());
    }

    [Fact]
    public void Open_without_the_simulator_throws_a_COMException_and_never_crashes()
    {
        if (!Built) return;
        using var signal = new EventWaitHandle(false, EventResetMode.AutoReset);
        try
        {
            // The simulator is running on this machine: a real session opens, is asked and closes.
            using var session = NativeSimConnect.Open("ACARS Bridge test", signal.SafeWaitHandle);
            session.Next();
        }
        catch (COMException ex)
        {
            Assert.Contains("SimConnect open", ex.Message);
            Assert.True(ex.HResult < 0);
        }
    }

    [Fact]
    public void The_bridge_folder_has_no_Microsoft_SimConnect_binaries()
    {
        Assert.False(File.Exists(Path.Combine(AppContext.BaseDirectory, "SimConnect.dll")));
        Assert.False(File.Exists(Path.Combine(AppContext.BaseDirectory, "Microsoft.FlightSimulator.SimConnect.dll")));
    }
}
