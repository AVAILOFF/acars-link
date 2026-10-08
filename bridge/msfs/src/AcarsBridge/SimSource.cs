namespace AcarsBridge;

/// <summary>Receives what a sim source produces. Implemented by <see cref="BridgeHub"/>.</summary>
public interface ISimSink
{
    void OnStatus(BridgeStatus status);
    void OnTelemetry(TelemetrySnapshot snapshot);
}

/// <summary>A telemetry source (SimConnect, fake). Runs until cancelled, reconnecting on its own.</summary>
public interface ISimSource
{
    string Name { get; }
    Task RunAsync(ISimSink sink, CancellationToken ct);
}

/// <summary>
/// Reconnect delays: 1, 2, 4, 8, 16, 30, 30 … s (CLAUDE.md, invariant 6 in spirit: no tight retry loops).
/// Deterministic; <see cref="Reset"/> after a successful connection.
/// </summary>
public sealed class ReconnectPolicy(TimeSpan? initial = null, TimeSpan? max = null)
{
    private readonly TimeSpan _initial = initial ?? TimeSpan.FromSeconds(1);
    private readonly TimeSpan _max = max ?? TimeSpan.FromSeconds(30);
    private int _attempt;

    public TimeSpan NextDelay()
    {
        var factor = Math.Pow(2, Math.Min(_attempt, 16));
        _attempt++;
        var ms = Math.Min(_initial.TotalMilliseconds * factor, _max.TotalMilliseconds);
        return TimeSpan.FromMilliseconds(ms);
    }

    public void Reset() => _attempt = 0;
}

/// <summary>
/// Turns SimConnect callbacks into a steady ~1 Hz telemetry stream. Platform-neutral so pause and
/// sim-rate handling are unit-testable without the sim.
/// <list type="bullet">
/// <item>Frames are throttled to one per <see cref="MinInterval"/> of wall time (at sim rate ×4 the
///   SECOND period may fire faster than 1 Hz wall).</item>
/// <item>A pause change re-emits the last frame at once with the new <c>paused</c> flag.</item>
/// <item><see cref="Tick"/> re-emits the last frame if the sim went quiet (data may stop while
///   paused), so the app keeps getting 1 Hz snapshots with <c>paused: true</c>.</item>
/// <item>Nothing is emitted while the sim is not running (menus, flight loading).</item>
/// </list>
/// Not thread-safe: call from the source's message loop only.
/// </summary>
public sealed class SnapshotPump(TimeProvider clock, Action<TelemetrySnapshot> emit)
{
    public static readonly TimeSpan MinInterval = TimeSpan.FromMilliseconds(900);
    public static readonly TimeSpan KeepAlive = TimeSpan.FromMilliseconds(1500);

    private SimFrame? _last;
    private DateTimeOffset _lastEmit = DateTimeOffset.MinValue;

    public bool Running { get; private set; }
    public bool Paused { get; private set; }
    public double SimRate => _last is null ? 1 : _last[SimVars.SimRate];

    public void OnFrame(SimFrame frame)
    {
        _last = frame;
        if (Running && clock.GetUtcNow() - _lastEmit >= MinInterval) Emit();
    }

    /// <summary>Pause_EX1 flags: any non-zero value (full, active or sim pause) counts as paused.</summary>
    /// <returns>True if the paused state changed.</returns>
    public bool OnPauseFlags(uint flags)
    {
        var paused = flags != 0;
        if (paused == Paused) return false;
        Paused = paused;
        if (Running && _last is not null) Emit();
        return true;
    }

    /// <summary>SimConnect "Sim" event: 1 running, 0 not running.</summary>
    /// <returns>True if the running state changed.</returns>
    public bool OnSimRunning(bool running)
    {
        if (running == Running) return false;
        Running = running;
        if (!running) _last = null; // stale data from before a reload must not be replayed
        return true;
    }

    public void Tick()
    {
        if (Running && _last is not null && clock.GetUtcNow() - _lastEmit >= KeepAlive) Emit();
    }

    public void Reset()
    {
        _last = null;
        _lastEmit = DateTimeOffset.MinValue;
        Running = false;
        Paused = false;
    }

    private void Emit()
    {
        var now = clock.GetUtcNow();
        _lastEmit = now;
        emit(TelemetryMapper.Map(_last!, Paused, now));
    }
}
