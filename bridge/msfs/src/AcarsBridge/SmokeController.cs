namespace AcarsBridge;

/// <summary>What the sim thread should do with the smoke object now.</summary>
public enum SmokeAction
{
    None,
    /// <summary>Create the object at <see cref="SmokeController.Target"/>.</summary>
    Spawn,
    /// <summary>Remove the object that was created.</summary>
    Remove,
}

/// <summary>
/// Decides when the smoke column (T34) exists in the sim. A fire is reported 120 NM out, but scenery and
/// objects far from the aircraft are not loaded, so the object is created only when the aircraft comes
/// within <see cref="SpawnNm"/> and removed when it is farther than <see cref="RemoveNm"/> (hysteresis), on
/// <c>smoke_stop</c>, or after <see cref="MaxLife"/>. Thread-safe: commands arrive on a network thread, positions
/// on the SimConnect thread, which alone calls SimConnect.
/// </summary>
public sealed class SmokeController(TimeProvider clock)
{
    public const double SpawnNm = 40;
    public const double RemoveNm = 60;
    public static readonly TimeSpan MaxLife = TimeSpan.FromMinutes(90);

    private readonly object _gate = new();
    private (double Lat, double Lon)? _target;
    private DateTimeOffset _started;
    private bool _spawned;
    /// <summary>The target changed while an object stands at the old one: remove it, then spawn anew.</summary>
    private bool _moved;

    /// <summary>Where the smoke should be, null when none is wanted.</summary>
    public (double Lat, double Lon)? Target
    {
        get { lock (_gate) return _target; }
    }

    public bool Active
    {
        get { lock (_gate) return _target is not null; }
    }

    public void Start(double lat, double lon)
    {
        lock (_gate)
        {
            if (_spawned && _target != (lat, lon)) _moved = true;
            _target = (lat, lon);
            _started = clock.GetUtcNow();
        }
    }

    public void Stop()
    {
        lock (_gate) _target = null;
    }

    /// <summary>The sim session ended: the object is gone with it, the request stays for the next session.</summary>
    public void SessionEnded()
    {
        lock (_gate) _spawned = false;
    }

    /// <summary>Called with every aircraft position; returns what to do now.</summary>
    public SmokeAction OnPosition(double lat, double lon)
    {
        lock (_gate)
        {
            if (_target is not { } t || clock.GetUtcNow() - _started > MaxLife)
            {
                _target = null;
                return _spawned ? Take(false) : SmokeAction.None;
            }
            if (_moved && _spawned)
            {
                _moved = false;
                return Take(false); // spawned at the new point on the next position
            }
            _moved = false;
            var nm = DistanceNm(lat, lon, t.Lat, t.Lon);
            if (!_spawned && nm <= SpawnNm) return Take(true);
            if (_spawned && nm > RemoveNm) return Take(false);
            return SmokeAction.None;
        }
    }

    private SmokeAction Take(bool spawn)
    {
        _spawned = spawn;
        return spawn ? SmokeAction.Spawn : SmokeAction.Remove;
    }

    /// <summary>Great-circle distance, nautical miles (haversine, mean Earth radius 3440.065 NM).</summary>
    public static double DistanceNm(double lat1, double lon1, double lat2, double lon2)
    {
        static double Rad(double d) => d * Math.PI / 180;
        var dLat = Rad(lat2 - lat1);
        var dLon = Rad(lon2 - lon1);
        var a = Math.Sin(dLat / 2) * Math.Sin(dLat / 2) +
                Math.Cos(Rad(lat1)) * Math.Cos(Rad(lat2)) * Math.Sin(dLon / 2) * Math.Sin(dLon / 2);
        return 3440.065 * 2 * Math.Asin(Math.Min(1, Math.Sqrt(a)));
    }
}
