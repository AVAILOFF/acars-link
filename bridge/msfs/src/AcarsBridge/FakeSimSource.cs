using System.Text.Json;

namespace AcarsBridge;

/// <summary>
/// Sim-less source for developing the app (T10) and for tests: emits snapshots at 1 Hz.
/// With a JSONL file (one TelemetrySnapshot per line), plays it in a loop; otherwise repeats a
/// parked A320 at EDDF (same values as reference/telemetry.sample.json). <c>t</c> is always
/// rewritten to the bridge clock.
/// </summary>
public sealed class FakeSimSource(TimeProvider clock, IReadOnlyList<TelemetrySnapshot>? frames = null) : ISimSource
{
    public static readonly TelemetrySnapshot Parked = new()
    {
        Lat = 50.0379, Lon = 8.5622, AltFt = 364, AglFt = 0, HdgTrue = 250.4,
        OnGround = true, ParkingBrake = true, Beacon = false,
        EngRunning = [false, false], EngN2 = [0, 0], FuelKg = 6420, GearDown = true, FlapsIdx = 0,
        DoorsOpen = [100, 0, 0, 0], XpdrState = 1, SimRate = 1, Paused = false,
        AircraftTitle = "FenixA320_DLH",
    };

    private readonly IReadOnlyList<TelemetrySnapshot> _frames = frames is { Count: > 0 } ? frames : [Parked];

    public string Name => "fake";

    public static FakeSimSource FromJsonl(TimeProvider clock, string path)
    {
        var frames = File.ReadLines(path)
            .Where(l => !string.IsNullOrWhiteSpace(l))
            .Select(l => JsonSerializer.Deserialize<TelemetrySnapshot>(l, Protocol.Json)
                ?? throw new InvalidDataException($"{path}: empty line"))
            .ToList();
        return new FakeSimSource(clock, frames);
    }

    public async Task RunAsync(ISimSink sink, CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1), clock);
        var i = 0;
        TelemetrySnapshot? prev = null;
        try
        {
            do
            {
                var f = _frames[i++ % _frames.Count] with { T = clock.GetUtcNow().ToUnixTimeMilliseconds() };
                if (prev is null || prev.Paused != f.Paused || prev.SimRate != f.SimRate)
                    sink.OnStatus(new BridgeStatus(SimLink.Connected, true, f.Paused, f.SimRate, Detail: "fake"));
                sink.OnTelemetry(f);
                prev = f;
            } while (await timer.WaitForNextTickAsync(ct));
        }
        catch (OperationCanceledException)
        {
        }
    }
}
