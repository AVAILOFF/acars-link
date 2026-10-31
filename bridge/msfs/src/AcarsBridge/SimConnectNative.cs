// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace AcarsBridge;

/// <summary>
/// Kinds of message <c>acars_simconnect.dll</c> hands over (<c>AcarsScKind</c> in <c>native/acars_simconnect.h</c>).
/// </summary>
internal enum SimMessageKind : uint
{
    None = 0,
    Open = 1,
    Quit = 2,
    Exception = 3,
    Event = 4,
    EventFrame = 5,
    SimobjectData = 6,
    AssignedObjectId = 7,
    Other = 99,
}

/// <summary>One message from the sim: the fields of the kind are set, the others are 0 (see the header).</summary>
internal readonly record struct SimMessage(
    SimMessageKind Kind, uint RequestId = 0, uint ObjectId = 0, uint EventId = 0, uint Value = 0, uint Index = 0, byte[]? Data = null);

internal enum SimPeriod : uint
{
    Once = 1,
    Second = 2,
}

/// <summary>
/// Position of a SimObject (<c>AcarsScPosition</c> = <c>SIMCONNECT_DATA_INITPOSITION</c>, field for field).
/// Pack 8 as in the header; 56 bytes.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 8)]
internal struct SimPosition
{
    public double Latitude, Longitude, Altitude, Pitch, Bank, Heading;
    /// <summary>1 = force the object onto the ground.</summary>
    public uint OnGround;
    public uint Airspeed;
}

/// <summary>
/// The part of SimConnect the bridge uses (T73), one session. <see cref="NativeSimConnect"/> is <c>acars_simconnect.dll</c>;
/// tests use a fake. Failures throw <see cref="COMException"/> with the HRESULT.
/// </summary>
internal interface ISimConnectNative : IDisposable
{
    void DefineFloat64(uint def, string name, string? unit);
    void DefineString256(uint def, string name);
    void DefinePosition(uint def);
    /// <summary><paramref name="objectId"/> 0 = the user aircraft.</summary>
    void RequestData(uint request, uint def, uint objectId, SimPeriod period);
    void SetFloat64(uint def, uint objectId, double value);
    void SetPosition(uint def, uint objectId, in SimPosition position);
    void SubscribeEvent(uint eventId, string name);
    void SetEventState(uint eventId, bool on);
    void CreateObject(string title, in SimPosition position, uint request);
    void RemoveObject(uint objectId, uint request);
    /// <summary>The next message; <see cref="SimMessageKind.None"/> when the queue is empty.</summary>
    SimMessage Next();
}

/// <summary>
/// <c>acars_simconnect.dll</c> by P/Invoke (T73): the SimConnect client is linked into it statically from the official
/// MSFS SDK, so neither <c>SimConnect.dll</c> nor the managed wrapper is shipped. Build: <c>native/build.cmd</c>.
/// </summary>
internal sealed class NativeSimConnect : ISimConnectNative
{
    /// <summary><c>ACARS_SC_ABI</c> of the header this file was written for.</summary>
    public const int Abi = 1;

    private const string Dll = "acars_simconnect";

    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    private struct Raw
    {
        public uint Kind, RequestId, ObjectId, EventId, Value, Index, DataLength, Reserved;
        public IntPtr Data;
    }

    [DllImport(Dll, ExactSpelling = true)] private static extern int acars_sc_abi();
    [DllImport(Dll, ExactSpelling = true)] private static extern int acars_sc_open([MarshalAs(UnmanagedType.LPStr)] string name, IntPtr eventHandle, out IntPtr session);
    [DllImport(Dll, ExactSpelling = true)] private static extern int acars_sc_close(IntPtr session);
    [DllImport(Dll, ExactSpelling = true)] private static extern int acars_sc_define_float64(IntPtr session, uint def, [MarshalAs(UnmanagedType.LPStr)] string name, [MarshalAs(UnmanagedType.LPStr)] string? unit);
    [DllImport(Dll, ExactSpelling = true)] private static extern int acars_sc_define_string256(IntPtr session, uint def, [MarshalAs(UnmanagedType.LPStr)] string name);
    [DllImport(Dll, ExactSpelling = true)] private static extern int acars_sc_define_position(IntPtr session, uint def);
    [DllImport(Dll, ExactSpelling = true)] private static extern int acars_sc_request_data(IntPtr session, uint request, uint def, uint objectId, uint period);
    [DllImport(Dll, ExactSpelling = true)] private static extern int acars_sc_set_float64(IntPtr session, uint def, uint objectId, double value);
    [DllImport(Dll, ExactSpelling = true)] private static extern int acars_sc_set_position(IntPtr session, uint def, uint objectId, in SimPosition position);
    [DllImport(Dll, ExactSpelling = true)] private static extern int acars_sc_subscribe_event(IntPtr session, uint eventId, [MarshalAs(UnmanagedType.LPStr)] string name);
    [DllImport(Dll, ExactSpelling = true)] private static extern int acars_sc_set_event_state(IntPtr session, uint eventId, int on);
    [DllImport(Dll, ExactSpelling = true)] private static extern int acars_sc_create_object(IntPtr session, [MarshalAs(UnmanagedType.LPStr)] string title, in SimPosition position, uint request);
    [DllImport(Dll, ExactSpelling = true)] private static extern int acars_sc_remove_object(IntPtr session, uint objectId, uint request);
    [DllImport(Dll, ExactSpelling = true)] private static extern int acars_sc_next_message(IntPtr session, out Raw message);

    private IntPtr _session;

    private NativeSimConnect(IntPtr session) => _session = session;

    /// <summary>Is <c>acars_simconnect.dll</c> next to the exe and of the ABI this code expects?</summary>
    /// <returns>Null when usable, else why not.</returns>
    public static string? Probe()
    {
        try
        {
            var abi = acars_sc_abi();
            return abi == Abi ? null : $"acars_simconnect.dll has ABI {abi}, this bridge needs {Abi}";
        }
        catch (DllNotFoundException)
        {
            return "acars_simconnect.dll not found next to the bridge";
        }
        catch (BadImageFormatException ex)
        {
            return $"acars_simconnect.dll cannot be loaded ({ex.Message.Trim()})";
        }
        catch (EntryPointNotFoundException ex)
        {
            return $"acars_simconnect.dll does not match this bridge ({ex.Message.Trim()})";
        }
    }

    /// <summary>Opens a session; <paramref name="signal"/> is set by the sim when a message waits.</summary>
    /// <exception cref="COMException">The simulator is not running (E_FAIL), or the call failed.</exception>
    public static NativeSimConnect Open(string clientName, SafeWaitHandle signal)
    {
        if (Probe() is { } why) throw new DllNotFoundException(why);
        var hr = acars_sc_open(clientName, signal.DangerousGetHandle(), out var session);
        if (hr < 0) throw Fail(hr, "open: the simulator is not running or does not answer");
        return new NativeSimConnect(session);
    }

    private IntPtr Session => _session != IntPtr.Zero ? _session : throw new ObjectDisposedException(nameof(NativeSimConnect));

    private static COMException Fail(int hr, string what) => new($"SimConnect {what} (0x{hr:X8})", hr);

    private static void Check(int hr, string what)
    {
        if (hr < 0) throw Fail(hr, what);
    }

    public void DefineFloat64(uint def, string name, string? unit) => Check(acars_sc_define_float64(Session, def, name, unit), $"define {name}");

    public void DefineString256(uint def, string name) => Check(acars_sc_define_string256(Session, def, name), $"define {name}");

    public void DefinePosition(uint def) => Check(acars_sc_define_position(Session, def), "define position");

    public void RequestData(uint request, uint def, uint objectId, SimPeriod period) =>
        Check(acars_sc_request_data(Session, request, def, objectId, (uint)period), "request data");

    public void SetFloat64(uint def, uint objectId, double value) => Check(acars_sc_set_float64(Session, def, objectId, value), "set data");

    public void SetPosition(uint def, uint objectId, in SimPosition position) => Check(acars_sc_set_position(Session, def, objectId, in position), "set position");

    public void SubscribeEvent(uint eventId, string name) => Check(acars_sc_subscribe_event(Session, eventId, name), $"subscribe {name}");

    public void SetEventState(uint eventId, bool on) => Check(acars_sc_set_event_state(Session, eventId, on ? 1 : 0), "set event state");

    public void CreateObject(string title, in SimPosition position, uint request) => Check(acars_sc_create_object(Session, title, in position, request), $"create {title}");

    public void RemoveObject(uint objectId, uint request) => Check(acars_sc_remove_object(Session, objectId, request), "remove object");

    public SimMessage Next()
    {
        Check(acars_sc_next_message(Session, out var m), "receive");
        byte[]? data = null;
        if (m.Data != IntPtr.Zero && m.DataLength > 0)
        {
            // The buffer is the library's and valid until the next call: copy it.
            data = new byte[m.DataLength];
            Marshal.Copy(m.Data, data, 0, data.Length);
        }
        return new SimMessage((SimMessageKind)m.Kind, m.RequestId, m.ObjectId, m.EventId, m.Value, m.Index, data);
    }

    public void Dispose()
    {
        var s = _session;
        _session = IntPtr.Zero;
        if (s != IntPtr.Zero) acars_sc_close(s);
    }
}
