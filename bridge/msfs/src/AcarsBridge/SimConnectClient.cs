// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

using System.Runtime.InteropServices;
using System.Text;

namespace AcarsBridge;

/// <summary>What a SIMOBJECT_DATA message carries: the request, the object and the raw bytes of the data definition.</summary>
internal sealed class SimObjectData(uint requestId, uint objectId, byte[] bytes)
{
    public uint RequestId { get; } = requestId;
    public uint ObjectId { get; } = objectId;
    public byte[] Bytes { get; } = bytes;

    /// <summary>A definition of FLOAT64 data only, as a struct of doubles (the layouts in <see cref="SimConnectSource"/>).</summary>
    public T Read<T>() where T : unmanaged
    {
        if (Bytes.Length < Marshal.SizeOf<T>())
            throw new InvalidDataException($"simconnect data: {Bytes.Length} bytes, {typeof(T).Name} needs {Marshal.SizeOf<T>()}");
        return MemoryMarshal.Read<T>(Bytes);
    }

    /// <summary>The telemetry definition: <paramref name="count"/> × FLOAT64, then TITLE as STRING256 (zero padded).</summary>
    public (double[] Values, string Title) ReadFrame(int count)
    {
        const int Title = 256;
        if (Bytes.Length < count * sizeof(double) + Title)
            throw new InvalidDataException($"simconnect data: {Bytes.Length} bytes, the frame needs {count * sizeof(double) + Title}");
        var values = new double[count];
        MemoryMarshal.Cast<byte, double>(Bytes.AsSpan(0, count * sizeof(double))).CopyTo(values);
        var text = Bytes.AsSpan(count * sizeof(double), Title);
        var end = text.IndexOf((byte)0);
        return (values, Encoding.UTF8.GetString(end < 0 ? text : text[..end]));
    }
}

/// <summary>
/// One SimConnect session over <see cref="ISimConnectNative"/>: the calls of the bridge, and the messages as events
/// (T73; the shape of the managed wrapper it replaces). Not thread-safe: the session thread only.
/// </summary>
internal sealed class SimConnectClient(ISimConnectNative native) : IDisposable
{
    /// <summary>Messages taken so far, of any kind, so <see cref="SimQueue"/> can tell an empty queue.</summary>
    public long Handled { get; private set; }

    public event Action? OnRecvOpen;
    public event Action? OnRecvQuit;
    /// <summary>The exception code (<see cref="ExceptionName"/>) and the index of the parameter that caused it.</summary>
    public event Action<uint, uint>? OnRecvException;
    /// <summary>Event id and its data (Pause_EX1: the flags; Sim: 0 or 1).</summary>
    public event Action<uint, uint>? OnRecvEvent;
    public event Action<uint>? OnRecvEventFrame;
    public event Action<SimObjectData>? OnRecvSimobjectData;
    /// <summary>Request id and the id the sim gave the new object.</summary>
    public event Action<uint, uint>? OnRecvAssignedObjectId;

    /// <summary>The user aircraft in <see cref="RequestData"/>.</summary>
    public const uint UserObject = 0;

    public void DefineFloat64(uint def, string name, string unit) => native.DefineFloat64(def, name, unit);
    public void DefineTitle(uint def) => native.DefineString256(def, "TITLE");
    public void DefinePosition(uint def) => native.DefinePosition(def);
    public void RequestData(uint request, uint def, uint objectId, SimPeriod period) => native.RequestData(request, def, objectId, period);
    public void SetFloat64(uint def, uint objectId, double value) => native.SetFloat64(def, objectId, value);
    public void SetPosition(uint def, uint objectId, in SimPosition position) => native.SetPosition(def, objectId, in position);
    public void SubscribeToSystemEvent(uint eventId, string name) => native.SubscribeEvent(eventId, name);
    public void SetSystemEventState(uint eventId, bool on) => native.SetEventState(eventId, on);
    public void CreateObject(string title, in SimPosition position, uint request) => native.CreateObject(title, in position, request);
    public void RemoveObject(uint objectId, uint request) => native.RemoveObject(objectId, request);

    /// <summary>Takes one message and raises its event.</summary>
    /// <returns>False when the queue was empty.</returns>
    public bool ReceiveMessage()
    {
        var m = native.Next();
        if (m.Kind == SimMessageKind.None) return false;
        Handled++;
        switch (m.Kind)
        {
            case SimMessageKind.Open:
                OnRecvOpen?.Invoke();
                break;
            case SimMessageKind.Quit:
                OnRecvQuit?.Invoke();
                break;
            case SimMessageKind.Exception:
                OnRecvException?.Invoke(m.Value, m.Index);
                break;
            case SimMessageKind.Event:
                OnRecvEvent?.Invoke(m.EventId, m.Value);
                break;
            case SimMessageKind.EventFrame:
                OnRecvEventFrame?.Invoke(m.EventId);
                break;
            case SimMessageKind.SimobjectData:
                OnRecvSimobjectData?.Invoke(new SimObjectData(m.RequestId, m.ObjectId, m.Data ?? []));
                break;
            case SimMessageKind.AssignedObjectId:
                OnRecvAssignedObjectId?.Invoke(m.RequestId, m.ObjectId);
                break;
        }
        return true;
    }

    public void Dispose() => native.Dispose();

    // SIMCONNECT_EXCEPTION of SimConnect.h (MSFS SDK 1.8.1), in order from 0.
    private static readonly string[] ExceptionNames =
    [
        "NONE", "ERROR", "SIZE_MISMATCH", "UNRECOGNIZED_ID", "UNOPENED", "VERSION_MISMATCH", "TOO_MANY_GROUPS",
        "NAME_UNRECOGNIZED", "TOO_MANY_EVENT_NAMES", "EVENT_ID_DUPLICATE", "TOO_MANY_MAPS", "TOO_MANY_OBJECTS",
        "TOO_MANY_REQUESTS", "WEATHER_INVALID_PORT", "WEATHER_INVALID_METAR", "WEATHER_UNABLE_TO_GET_OBSERVATION",
        "WEATHER_UNABLE_TO_CREATE_STATION", "WEATHER_UNABLE_TO_REMOVE_STATION", "INVALID_DATA_TYPE",
        "INVALID_DATA_SIZE", "DATA_ERROR", "INVALID_ARRAY", "CREATE_OBJECT_FAILED", "LOAD_FLIGHTPLAN_FAILED",
        "OPERATION_INVALID_FOR_OBJECT_TYPE", "ILLEGAL_OPERATION", "ALREADY_SUBSCRIBED", "INVALID_ENUM",
        "DEFINITION_ERROR", "DUPLICATE_ID", "DATUM_ID", "OUT_OF_BOUNDS", "ALREADY_CREATED",
        "OBJECT_OUTSIDE_REALITY_BUBBLE", "OBJECT_CONTAINER", "OBJECT_AI", "OBJECT_ATC", "OBJECT_SCHEDULE",
        "JETWAY_DATA", "ACTION_NOT_FOUND", "NOT_AN_ACTION", "INCORRECT_ACTION_PARAMS", "GET_INPUT_EVENT_FAILED",
        "SET_INPUT_EVENT_FAILED", "EVENT_NAME_RESERVED", "INTERNAL", "CAMERA_API",
    ];

    /// <summary>The name of a SIMCONNECT_EXCEPTION code, else the number.</summary>
    public static string ExceptionName(uint code) => code < ExceptionNames.Length ? ExceptionNames[code] : code.ToString();
}
