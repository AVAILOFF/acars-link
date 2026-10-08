using System.Reflection;
using AcarsBridge;

const string Usage = """
    acars-msfs-bridge — MSFS SimConnect → WebSocket ws://127.0.0.1:<port>/

    Options:
      --port <n>          listen port (default 47830)
      --source <name>     simconnect (default) | fake
      --replay <file>     with --source fake: loop a JSONL file of TelemetrySnapshot v1
      --verbose           log HTTP/Kestrel details
      --help
    """;

var port = BridgeServer.DefaultPort;
var sourceName = "simconnect";
string? replay = null;
var verbose = false;

for (var i = 0; i < args.Length; i++)
{
    switch (args[i])
    {
        case "--port" when i + 1 < args.Length && int.TryParse(args[i + 1], out var p) && p is > 0 and < 65536:
            port = p;
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
            return 0;
        default:
            Console.Error.WriteLine($"unknown or incomplete option: {args[i]}\n\n{Usage}");
            return 2;
    }
}

var clock = TimeProvider.System;
ISimSource source;
switch (sourceName)
{
    case "fake":
        source = replay is null ? new FakeSimSource(clock) : FakeSimSource.FromJsonl(clock, replay);
        break;
    case "simconnect":
#if SIMCONNECT
        source = new SimConnectSource(clock);
        break;
#else
        Console.Error.WriteLine("SimConnect support is not compiled in (MSFS SDK not found at build time). " +
                                "Rebuild with -p:MsfsSdk=<SDK root>, or run with --source fake.");
        return 3;
#endif
    default:
        Console.Error.WriteLine($"unknown source: {sourceName}");
        return 2;
}

var version = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0";
var hub = new LoggingSink(new BridgeHub(version, source.Name));
var app = BridgeServer.Build(hub.Hub, port,
    verbose ? Microsoft.Extensions.Logging.LogLevel.Information : Microsoft.Extensions.Logging.LogLevel.Warning);

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true;
    cts.Cancel();
};

await app.StartAsync(cts.Token);
Console.WriteLine($"{Protocol.BridgeName} {version}: source={source.Name}, listening on ws://127.0.0.1:{port}{BridgeServer.Path}");

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
return 0;

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
