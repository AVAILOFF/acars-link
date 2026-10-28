// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

using System.Net;
using System.Net.Sockets;
using System.Runtime.CompilerServices;
using AcarsBridge;

namespace AcarsBridge.Tests;

internal sealed class ManualClock(DateTimeOffset start) : TimeProvider
{
    private DateTimeOffset _now = start;

    public static ManualClock At(long epochMs) => new(DateTimeOffset.FromUnixTimeMilliseconds(epochMs));

    public override DateTimeOffset GetUtcNow() => _now;

    public void Advance(TimeSpan by) => _now += by;
}

internal sealed class RecordingSink : ISimSink
{
    public List<BridgeStatus> Statuses { get; } = [];
    public List<TelemetrySnapshot> Telemetry { get; } = [];

    public void OnStatus(BridgeStatus status) => Statuses.Add(status);

    public void OnTelemetry(TelemetrySnapshot snapshot) => Telemetry.Add(snapshot);
}

internal static class Frames
{
    /// <summary>Raw SimConnect values that should map to reference/telemetry.sample.json.</summary>
    public static SimFrame Sample()
    {
        var v = new double[SimVars.Count];
        v[SimVars.Lat] = 50.03790012;
        v[SimVars.Lon] = 8.56219987;
        v[SimVars.Alt] = 364.2;
        v[SimVars.Agl] = 0.3;
        v[SimVars.Ias] = 0.02;
        v[SimVars.Gs] = 0;
        v[SimVars.Vs] = -0.4;
        v[SimVars.Hdg] = 250.41;
        v[SimVars.OnGround] = 1;
        v[SimVars.ParkingBrake] = 1;
        v[SimVars.Beacon] = 0;
        v[SimVars.EngineCount] = 2;
        v[SimVars.Fuel] = 6420.3;
        v[SimVars.Gear] = 1;
        v[SimVars.Flaps] = 0;
        v[SimVars.ExitFirst] = 100;
        v[SimVars.Xpdr] = 1;
        v[SimVars.SimRate] = 1;
        v[SimVars.Touchdown] = 3.2;
        v[SimVars.AbsTime] = SimVars.UnixEpochAbsSeconds + 1791374400;
        return new SimFrame(v, "FenixA320_DLH\0");
    }

    public static SimFrame With(this SimFrame f, int index, double value)
    {
        var v = (double[])f.Values.Clone();
        v[index] = value;
        return f with { Values = v };
    }
}

internal static class Repo
{
    /// <summary>Finds a repo file by walking up from this source file (works with any output path).</summary>
    public static string File(string relative, [CallerFilePath] string self = "")
    {
        for (var dir = new DirectoryInfo(Path.GetDirectoryName(self)!); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, relative);
            if (System.IO.File.Exists(candidate)) return candidate;
        }
        throw new FileNotFoundException(relative);
    }

    public static int FreePort()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        var port = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }
}
