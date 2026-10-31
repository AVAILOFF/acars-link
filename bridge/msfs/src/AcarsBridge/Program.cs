// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

using System.Reflection;
using AcarsBridge;

const string Usage = """
    acars-msfs-bridge — MSFS SimConnect or X-Plane 12 Web API → WebSocket ws://127.0.0.1:<port>/

    Options:
      --port <n>          listen port (default 47830)
      --source <name>     auto (default: MSFS or X-Plane 12, whichever runs) | simconnect | xplane | fake
      --xplane-port <n>   with --source auto or xplane: X-Plane's web server port (default 8086)
      --replay <file>     with --source fake: loop a JSONL file of TelemetrySnapshot v1
      --verbose           log HTTP/Kestrel details
      --help

    Environment:
      ACARS_BRIDGE_TOKEN  launch token set by the app: clients must send it in X-Acars-Bridge-Token
                          (unset when started by hand: any local native client may connect)
    """;

var port = BridgeServer.DefaultPort;
var sourceName = AutoSimSource.SourceName;
string? replay = null;
var xplanePort = XPlaneSource.DefaultPort;
var verbose = false;

for (var i = 0; i < args.Length; i++)
{
    switch (args[i])
    {
        case "--port" when i + 1 < args.Length && int.TryParse(args[i + 1], out var p) && p is > 0 and < 65536:
            port = p;
            i++;
            break;
        case "--xplane-port" when i + 1 < args.Length && int.TryParse(args[i + 1], out var xp) && xp is > 0 and < 65536:
            xplanePort = xp;
            i++;
            break;
        case "--source" when i + 1 < args.Length:
            sourceName = args[++i];
            break;
        case "--replay" when i + 1 < args.Length:
            replay = args[++i];
            break;
        case "--verbose":
            verbose = true;
            break;
        case "--help" or "-h":
            Console.WriteLine(Usage);
            return ExitCodes.Ok;
        default:
            Console.Error.WriteLine($"unknown or incomplete option: {args[i]}\n\n{Usage}");
            return ExitCodes.BadArguments;
    }
}

var clock = TimeProvider.System;
ISimSource source;
switch (sourceName)
{
    case "fake":
        source = replay is null ? new FakeSimSource(clock) : FakeSimSource.FromJsonl(clock, replay);
        break;
    case "xplane":
        source = new XPlaneSource(clock, xplanePort);
        break;
    case AutoSimSource.SourceName:
        // MSFS first in each round (T59): when both run, the first to answer wins.
#if SIMCONNECT
        source = new AutoSimSource([new SimConnectSource(clock), new XPlaneSource(clock, xplanePort)], clock);
#else
        Console.Error.WriteLine("SimConnect support is not compiled in: --source auto looks for X-Plane 12 only.");
        source = new AutoSimSource([new XPlaneSource(clock, xplanePort)], clock);
#endif
        break;
    case "simconnect":
#if SIMCONNECT
        source = new SimConnectSource(clock);
        break;
#else
        Console.Error.WriteLine("SimConnect support is not compiled in (MSFS SDK not found at build time). " +
                                "Rebuild with -p:MsfsSdk=<SDK root>, or run with --source fake.");
        return ExitCodes.NoSimConnect;
#endif
    default:
        Console.Error.WriteLine($"unknown source: {sourceName}");
        return ExitCodes.BadArguments;
}

// T65: the token comes in the environment (not on the command line, which audit logs may keep);
// never printed. Cleared at once so nothing started from here inherits it.
var token = Environment.GetEnvironmentVariable(AccessPolicy.TokenVariable);
Environment.SetEnvironmentVariable(AccessPolicy.TokenVariable, null);
if (string.IsNullOrEmpty(token))
{
    token = null;
    Console.WriteLine($"No {AccessPolicy.TokenVariable}: any local client without a web Origin may connect (bridge started by hand).");
}

var version = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0";
var commands = new CommandDispatcher(source as ICommandTarget, clock);
var hub = new LoggingSink(new BridgeHub(version, source.Name, commands.Commands));
var app = BridgeServer.Build(hub.Hub, port, commands,
    verbose ? Microsoft.Extensions.Logging.LogLevel.Information : Microsoft.Extensions.Logging.LogLevel.Warning, token);

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true;
    cts.Cancel();
};

try
{
    await app.StartAsync(cts.Token);
}
catch (Exception e) when (BridgeServer.IsAddressInUse(e))
{
    // T75: another program holds the port (a bridge started by hand, say). A code of its own tells the app
    // not to start this process again in a loop.
    Console.Error.WriteLine(BridgeServer.PortInUseMessage(port));
    return ExitCodes.PortInUse;
}
Console.WriteLine($"{Protocol.BridgeName} {version}: source={source.Name}, listening on ws://127.0.0.1:{port}{BridgeServer.Path}" +
                  $" (protocol {Protocol.MinProtocolVersion}-{Protocol.ProtocolVersion}, commands: {string.Join(", ", commands.Commands)})");

var run = source.RunAsync(hub, cts.Token);
try
{
    await Task.Delay(Timeout.Infinite, cts.Token);
}
catch (OperationCanceledException)
{
}
await run;
hub.Hub.Complete();
await app.StopAsync();
return ExitCodes.Ok;

/// <summary>Prints status changes to the console (no telemetry spam).</summary>
internal sealed class LoggingSink(BridgeHub hub) : ISimSink
{
    public BridgeHub Hub => hub;

    public void OnStatus(BridgeStatus status)
    {
        if (status != hub.LastStatus)
            Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] {Protocol.Status(status)}");
        hub.OnStatus(status);
    }

    public void OnTelemetry(TelemetrySnapshot snapshot) => hub.OnTelemetry(snapshot);
}
