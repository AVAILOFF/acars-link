namespace AcarsBridge;

/// <summary>One numeric SimVar requested as FLOAT64.</summary>
public sealed record SimVarDef(string Name, string Unit);

/// <summary>
/// The SimVars the bridge requests, in data-definition order. <see cref="SimFrame.Values"/> follows
/// this order; use the <see cref="SimVars"/> index constants to read it.
///
/// Names and units checked against the MSFS SDK SimVar docs (docs.flightsimulator.com, 2026-10):
/// <list type="bullet">
/// <item>ENG N2 RPM is a 0..16384 scale, so N2 comes from TURB ENG N2:n (percent). Engines are 1-based.</item>
/// <item>FUEL TOTAL QUANTITY WEIGHT is natively pounds; requested in "kilograms".</item>
/// <item>GEAR HANDLE POSITION is "Percent Over 100" (0 up … 1 down).</item>
/// <item>EXIT OPEN:n is "Percent Over 100"; requested in "percent" (0..100). Index base not stated in the
///   docs; aircraft.cfg numbers exits from 0, so 0..3 is used. [ПРОВЕРИТЬ человеком]</item>
/// <item>TRANSPONDER STATE: unindexed in the 2020 docs, ":1" in the 2024 docs (docs/03 uses ":1").
///   Enum 0 Off, 1 Standby, 2 Test, 3 On, 4 Alt, 5 Ground. [ПРОВЕРИТЬ человеком в 2020]</item>
/// <item>SIMULATION RATE is an environment variable, unit Number.</item>
/// </list>
/// TITLE is requested separately as STRING256 (see SimConnectSource).
/// </summary>
public static class SimVars
{
    public const int MaxEngines = 4;
    public const int Exits = 4;

    public const int Lat = 0;
    public const int Lon = 1;
    public const int Alt = 2;
    public const int Agl = 3;
    public const int Ias = 4;
    public const int Gs = 5;
    public const int Vs = 6;
    public const int Hdg = 7;
    public const int OnGround = 8;
    public const int ParkingBrake = 9;
    public const int Beacon = 10;
    public const int EngineCount = 11;
    public const int Combustion1 = 12; // .. +3
    public const int N2First = Combustion1 + MaxEngines; // 16 .. 19
    public const int Fuel = N2First + MaxEngines; // 20
    public const int Gear = Fuel + 1;
    public const int Flaps = Gear + 1;
    public const int ExitFirst = Flaps + 1; // 23 .. 26
    public const int Xpdr = ExitFirst + Exits; // 27
    public const int SimRate = Xpdr + 1; // 28
    public const int Count = SimRate + 1;

    public static readonly IReadOnlyList<SimVarDef> Definitions = Build();

    private static List<SimVarDef> Build()
    {
        var d = new List<SimVarDef>
        {
            new("PLANE LATITUDE", "degrees"),
            new("PLANE LONGITUDE", "degrees"),
            new("PLANE ALTITUDE", "feet"),
            new("PLANE ALT ABOVE GROUND", "feet"),
            new("AIRSPEED INDICATED", "knots"),
            new("GROUND VELOCITY", "knots"),
            new("VERTICAL SPEED", "feet/minute"),
            new("PLANE HEADING DEGREES TRUE", "degrees"),
            new("SIM ON GROUND", "Bool"),
            new("BRAKE PARKING POSITION", "Bool"),
            new("LIGHT BEACON", "Bool"),
            new("NUMBER OF ENGINES", "number"),
        };
        for (var i = 1; i <= MaxEngines; i++) d.Add(new($"GENERAL ENG COMBUSTION:{i}", "Bool"));
        for (var i = 1; i <= MaxEngines; i++) d.Add(new($"TURB ENG N2:{i}", "percent"));
        d.Add(new("FUEL TOTAL QUANTITY WEIGHT", "kilograms"));
        d.Add(new("GEAR HANDLE POSITION", "percent over 100"));
        d.Add(new("FLAPS HANDLE INDEX", "number"));
        for (var i = 0; i < Exits; i++) d.Add(new($"EXIT OPEN:{i}", "percent"));
        d.Add(new("TRANSPONDER STATE:1", "Enum"));
        d.Add(new("SIMULATION RATE", "number"));
        return d;
    }
}

/// <summary>Raw sample from the sim: numeric SimVars in <see cref="SimVars.Definitions"/> order + TITLE.</summary>
public sealed record SimFrame(double[] Values, string Title)
{
    public double this[int index] => Values[index];
}

/// <summary>SimFrame + pause state + wall clock → TelemetrySnapshot v1.</summary>
public static class TelemetryMapper
{
    public static TelemetrySnapshot Map(SimFrame f, bool paused, DateTimeOffset now)
    {
        if (f.Values.Length != SimVars.Count)
            throw new ArgumentException($"expected {SimVars.Count} values, got {f.Values.Length}");

        var engines = Math.Clamp((int)Math.Round(f[SimVars.EngineCount]), 0, SimVars.MaxEngines);
        var running = new bool[engines];
        var n2 = new double[engines];
        for (var i = 0; i < engines; i++)
        {
            running[i] = Flag(f[SimVars.Combustion1 + i]);
            n2[i] = Round(Math.Max(0, f[SimVars.N2First + i]), 1);
        }

        var doors = new double[SimVars.Exits];
        for (var i = 0; i < SimVars.Exits; i++)
            doors[i] = Round(Math.Clamp(f[SimVars.ExitFirst + i], 0, 100), 0);

        return new TelemetrySnapshot
        {
            T = now.ToUnixTimeMilliseconds(),
            Lat = Round(f[SimVars.Lat], 6),
            Lon = Round(f[SimVars.Lon], 6),
            AltFt = Round(f[SimVars.Alt], 0),
            AglFt = Round(f[SimVars.Agl], 0),
            IasKt = Round(f[SimVars.Ias], 1),
            GsKt = Round(f[SimVars.Gs], 1),
            VsFpm = Round(f[SimVars.Vs], 0),
            HdgTrue = Heading(f[SimVars.Hdg]),
            OnGround = Flag(f[SimVars.OnGround]),
            ParkingBrake = Flag(f[SimVars.ParkingBrake]),
            Beacon = Flag(f[SimVars.Beacon]),
            EngRunning = running,
            EngN2 = n2,
            FuelKg = Round(Math.Max(0, f[SimVars.Fuel]), 0),
            GearDown = f[SimVars.Gear] >= 0.5,
            FlapsIdx = (int)Math.Round(f[SimVars.Flaps]),
            DoorsOpen = doors,
            XpdrState = (int)Math.Round(f[SimVars.Xpdr]),
            SimRate = Round(f[SimVars.SimRate], 3),
            Paused = paused,
            AircraftTitle = CString(f.Title),
        };
    }

    private static bool Flag(double v) => v >= 0.5;

    /// <summary>STRING256 may carry a NUL terminator and padding.</summary>
    private static string CString(string s)
    {
        var nul = s.IndexOf('\0');
        return (nul >= 0 ? s[..nul] : s).Trim();
    }

    /// <summary>Degrees in [0, 360), one decimal (359.96 → 0, not 360).</summary>
    private static double Heading(double deg)
    {
        var h = Round(deg % 360, 1);
        if (h < 0) h += 360;
        return h >= 360 ? 0 : h;
    }

    private static double Round(double v, int digits)
    {
        if (double.IsNaN(v) || double.IsInfinity(v)) return 0;
        var r = Math.Round(v, digits, MidpointRounding.AwayFromZero);
        return r == 0 ? 0 : r; // no "-0" on the wire
    }
}
