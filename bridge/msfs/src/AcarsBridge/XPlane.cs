using System.Text;
using System.Text.Json;

namespace AcarsBridge;

/// <summary>One X-Plane dataref the bridge subscribes to; <see cref="Index"/> = array elements (null: scalar or whole value).</summary>
public sealed record DatarefSpec(string Name, int[]? Index = null, bool Required = false);

/// <summary>
/// The datarefs the X-Plane source reads (T18), checked against the official DataRefs.txt
/// (github.com/X-Plane/XPlane2Blender, io_xplane2blender/resources/DataRefs.txt, build 1208, file of
/// 2023-09; checked 2026-10-22). Name, type and unit as listed there:
/// <list type="bullet">
/// <item><c>position/latitude</c>, <c>longitude</c> double degrees; <c>elevation</c> double meters MSL;
///   <c>y_agl</c> float meters; <c>indicated_airspeed</c> float kias; <c>groundspeed</c> float m/s;
///   <c>vh_ind_fpm</c> float fpm; <c>true_psi</c> float true degrees.</item>
/// <item><c>failures/onground_any</c> int (1 = on the ground); <c>parking_brake_ratio</c> float 0..1;
///   <c>beacon_on</c> int; <c>acf_num_engines</c> int; <c>ENGN_running</c> int[16]; <c>N2_percent</c> float[16] percent;
///   <c>m_fuel_total</c> float kgs; <c>gear_handle_down</c> int; <c>flap_handle_request_ratio</c> float 0..1;
///   <c>acf_flap_detents</c> int; <c>door_open_ratio</c> float[20] 0..1.</item>
/// <item><c>transponder_mode</c> int: off 0, stdby 1, on (mode A) 2, alt (mode C) 3, test 4, GND (mode S) 5,
///   ta_only 6, ta/ra 7.</item>
/// <item><c>sim/time/paused</c> int; <c>sim_speed</c> int ratio ("0 = paused").</item>
/// <item><c>acf_ui_name</c> byte[250], <c>acf_descrip</c> byte[260], <c>acf_ICAO</c> byte[40]: strings, sent by
///   the Web API as base64 (value_type <c>data</c>).</item>
/// </list>
/// Not in X-Plane, decided with the user 2026-10-22 (docs/07, T18 "Допущения"): the sim clock is not sent
/// (no year dataref), the touchdown rate is measured by the bridge (<see cref="XPlaneState"/>).
/// </summary>
public static class XPlaneDatarefs
{
    public const string Lat = "sim/flightmodel/position/latitude";
    public const string Lon = "sim/flightmodel/position/longitude";
    public const string Elevation = "sim/flightmodel/position/elevation";
    public const string Agl = "sim/flightmodel/position/y_agl";
    public const string Ias = "sim/flightmodel/position/indicated_airspeed";
    public const string Gs = "sim/flightmodel/position/groundspeed";
    public const string Vs = "sim/flightmodel/position/vh_ind_fpm";
    public const string Hdg = "sim/flightmodel/position/true_psi";
    public const string OnGround = "sim/flightmodel/failures/onground_any";
    public const string ParkingBrake = "sim/cockpit2/controls/parking_brake_ratio";
    public const string Beacon = "sim/cockpit2/switches/beacon_on";
    public const string Engines = "sim/aircraft/engine/acf_num_engines";
    public const string EngRunning = "sim/flightmodel/engine/ENGN_running";
    public const string N2 = "sim/cockpit2/engine/indicators/N2_percent";
    public const string Fuel = "sim/flightmodel/weight/m_fuel_total";
    public const string Gear = "sim/cockpit2/controls/gear_handle_down";
    public const string FlapHandle = "sim/cockpit2/controls/flap_handle_request_ratio";
    public const string FlapDetents = "sim/aircraft/controls/acf_flap_detents";
    public const string Doors = "sim/flightmodel2/misc/door_open_ratio";
    public const string Xpdr = "sim/cockpit2/radios/actuators/transponder_mode";
    public const string Paused = "sim/time/paused";
    public const string SimSpeed = "sim/time/sim_speed";
    public const string UiName = "sim/aircraft/view/acf_ui_name";
    public const string Descrip = "sim/aircraft/view/acf_descrip";
    public const string Icao = "sim/aircraft/view/acf_ICAO";

    // Hot Start Challenger 650: its own systems do not drive these sim datarefs (seen live 2026-10-22,
    // X-Plane 12.4.3: parking_brake_ratio stays 0 with the brake set; flap_handle_request_ratio jumps 0 → 1 at
    // flaps 20). Found only while the CL650 is loaded; when they are there they win.
    /// <summary>CL650 parking brake lever, 0 released … 1 set (animated in between).</summary>
    public const string Cl650ParkBrake = "CL650/pedestal/park_brake";
    /// <summary>CL650 flap lever detent: 0 UP, 1 = 20, 2 = 30, 3 = 45 (fractional while the lever moves).</summary>
    public const string Cl650Flaps = "CL650/pedestal/flaps";

    private static readonly int[] Engs = [.. Enumerable.Range(0, SimVars.MaxEngines)];
    private static readonly int[] Exits = [.. Enumerable.Range(0, SimVars.Exits)];

    /// <summary>Required ones must exist, or no flight is loaded (the Web API has no datarefs before the first flight).</summary>
    public static readonly IReadOnlyList<DatarefSpec> All =
    [
        new(Lat, Required: true),
        new(Lon, Required: true),
        new(Elevation, Required: true),
        new(Agl, Required: true),
        new(Ias, Required: true),
        new(Gs, Required: true),
        new(Vs, Required: true),
        new(Hdg, Required: true),
        new(OnGround, Required: true),
        new(ParkingBrake),
        new(Beacon),
        new(Engines),
        new(EngRunning, Engs),
        new(N2, Engs),
        new(Fuel),
        new(Gear),
        new(FlapHandle),
        new(FlapDetents),
        new(Doors, Exits),
        new(Xpdr),
        new(Paused),
        new(SimSpeed),
        new(UiName),
        new(Descrip),
        new(Icao),
        new(Cl650ParkBrake),
        new(Cl650Flaps),
    ];

    public const double FeetPerMeter = 1 / 0.3048;
    public const double KnotsPerMps = 3600.0 / 1852;

    /// <summary>X-Plane transponder mode → MSFS <c>TRANSPONDER STATE</c> (0 Off, 1 Standby, 2 Test, 3 On, 4 Alt, 5 Ground).</summary>
    public static int Transponder(int xplaneMode) => xplaneMode switch
    {
        0 => 0,
        1 => 1,
        2 => 3,
        3 or 6 or 7 => 4,
        4 => 2,
        5 => 5,
        _ => 0,
    };

    /// <summary>
    /// The aircraft title: <c>acf_ui_name</c>, else <c>acf_descrip</c>; the ICAO type in brackets when the name does not
    /// already contain it, so the display profiles (737, 777, 787) match.
    /// </summary>
    public static string Title(string uiName, string descrip, string icao)
    {
        var name = uiName.Length > 0 ? uiName : descrip;
        if (icao.Length == 0 || name.Contains(icao, StringComparison.OrdinalIgnoreCase)) return name;
        return name.Length == 0 ? icao : $"{name} ({icao})";
    }

    /// <summary>A base64 <c>data</c> value as a C string: up to the first NUL, trimmed.</summary>
    public static string DecodeString(string base64)
    {
        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(base64);
        }
        catch (FormatException)
        {
            return "";
        }
        var end = Array.IndexOf(bytes, (byte)0);
        return Encoding.UTF8.GetString(bytes, 0, end < 0 ? bytes.Length : end).Trim();
    }
}

/// <summary>
/// Current dataref values from <c>dataref_update_values</c> messages (the first one has all values, later ones
/// only the changed ones), turned into the same <see cref="SimFrame"/> as SimConnect gives, so
/// <see cref="SnapshotPump"/> and <see cref="TelemetryMapper"/> are shared.
/// Touchdown rate (approved 2026-10-22): |<c>vh_ind_fpm</c>| of the last update in the air before
/// <c>onground_any</c> goes 0 → 1 (updates come at ~10 Hz); kept until the next touchdown, 0 before the first.
/// Not thread-safe.
/// </summary>
public sealed class XPlaneState
{
    private readonly Dictionary<string, double[]> _numbers = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _strings = new(StringComparer.Ordinal);
    private bool? _onGround;
    private double _airborneFpm;
    private bool _airborne;

    /// <summary>Touchdown rate, ft/min, positive; 0 until the first touchdown seen.</summary>
    public double TouchdownFpm { get; private set; }

    /// <summary><c>sim/time/paused</c>, or <c>sim_speed</c> 0 ("0 = paused").</summary>
    public bool Paused => Scalar(XPlaneDatarefs.Paused) >= 0.5 || (_numbers.ContainsKey(XPlaneDatarefs.SimSpeed) && Scalar(XPlaneDatarefs.SimSpeed) == 0);

    /// <summary>
    /// Applies the <c>data</c> object of one update: keys are dataref ids, values a number, an array of numbers
    /// (the subscribed indices in order) or a base64 string. Unknown ids and other value kinds are ignored.
    /// </summary>
    public void Apply(JsonElement data, IReadOnlyDictionary<long, string> names)
    {
        if (data.ValueKind != JsonValueKind.Object) return;
        foreach (var p in data.EnumerateObject())
        {
            if (!long.TryParse(p.Name.Trim(), out var id) || !names.TryGetValue(id, out var name)) continue;
            switch (p.Value.ValueKind)
            {
                case JsonValueKind.Number:
                    _numbers[name] = [p.Value.GetDouble()];
                    break;
                case JsonValueKind.Array:
                    _numbers[name] = [.. p.Value.EnumerateArray().Select(v => v.ValueKind == JsonValueKind.Number ? v.GetDouble() : 0)];
                    break;
                case JsonValueKind.String:
                    _strings[name] = XPlaneDatarefs.DecodeString(p.Value.GetString()!);
                    break;
            }
        }
        TrackTouchdown();
    }

    private void TrackTouchdown()
    {
        if (!_numbers.ContainsKey(XPlaneDatarefs.OnGround)) return;
        var onGround = Scalar(XPlaneDatarefs.OnGround) >= 0.5;
        if (!onGround)
        {
            _airborne = true;
            _airborneFpm = Scalar(XPlaneDatarefs.Vs);
        }
        else if (_onGround == false && _airborne)
        {
            TouchdownFpm = Math.Abs(_airborneFpm);
            _airborne = false;
        }
        _onGround = onGround;
    }

    private bool Has(string name) => _numbers.ContainsKey(name);

    /// <summary>The loaded aircraft (<c>acf_ui_name</c> + <c>acf_ICAO</c>); empty until the sim sent them.</summary>
    public string Aircraft => $"{Text(XPlaneDatarefs.UiName)}|{Text(XPlaneDatarefs.Icao)}";

    private double Scalar(string name) => _numbers.TryGetValue(name, out var v) && v.Length > 0 ? v[0] : 0;

    private double Element(string name, int i) => _numbers.TryGetValue(name, out var v) && i < v.Length ? v[i] : 0;

    private string Text(string name) => _strings.TryGetValue(name, out var s) ? s : "";

    /// <summary>The values in <see cref="SimVars"/> layout and units. ABSOLUTE TIME stays 0: no sim clock (simUtcMs omitted).</summary>
    public SimFrame Frame()
    {
        var v = new double[SimVars.Count];
        v[SimVars.Lat] = Scalar(XPlaneDatarefs.Lat);
        v[SimVars.Lon] = Scalar(XPlaneDatarefs.Lon);
        v[SimVars.Alt] = Scalar(XPlaneDatarefs.Elevation) * XPlaneDatarefs.FeetPerMeter;
        v[SimVars.Agl] = Scalar(XPlaneDatarefs.Agl) * XPlaneDatarefs.FeetPerMeter;
        v[SimVars.Ias] = Scalar(XPlaneDatarefs.Ias);
        v[SimVars.Gs] = Scalar(XPlaneDatarefs.Gs) * XPlaneDatarefs.KnotsPerMps;
        v[SimVars.Vs] = Scalar(XPlaneDatarefs.Vs);
        v[SimVars.Hdg] = Scalar(XPlaneDatarefs.Hdg);
        v[SimVars.OnGround] = Scalar(XPlaneDatarefs.OnGround);
        // Approved 2026-10-22: the parking brake ratio counts as set from 0.5 (the CL650 lever likewise).
        var brake = Has(XPlaneDatarefs.Cl650ParkBrake) ? XPlaneDatarefs.Cl650ParkBrake : XPlaneDatarefs.ParkingBrake;
        v[SimVars.ParkingBrake] = Scalar(brake) >= 0.5 ? 1 : 0;
        v[SimVars.Beacon] = Scalar(XPlaneDatarefs.Beacon);
        v[SimVars.EngineCount] = Scalar(XPlaneDatarefs.Engines);
        for (var i = 0; i < SimVars.MaxEngines; i++)
        {
            v[SimVars.Combustion1 + i] = Element(XPlaneDatarefs.EngRunning, i);
            v[SimVars.N2First + i] = Element(XPlaneDatarefs.N2, i);
        }
        v[SimVars.Fuel] = Scalar(XPlaneDatarefs.Fuel);
        v[SimVars.Gear] = Scalar(XPlaneDatarefs.Gear);
        // Approved 2026-10-22: no handle index in X-Plane; the handle ratio times the number of detents.
        v[SimVars.Flaps] = Has(XPlaneDatarefs.Cl650Flaps)
            ? Math.Round(Scalar(XPlaneDatarefs.Cl650Flaps))
            : Math.Round(Scalar(XPlaneDatarefs.FlapHandle) * Scalar(XPlaneDatarefs.FlapDetents));
        // Approved 2026-10-22: the first four doors in the aircraft's own order, ratio → percent.
        for (var i = 0; i < SimVars.Exits; i++) v[SimVars.ExitFirst + i] = Element(XPlaneDatarefs.Doors, i) * 100;
        v[SimVars.Xpdr] = XPlaneDatarefs.Transponder((int)Math.Round(Scalar(XPlaneDatarefs.Xpdr)));
        var speed = Scalar(XPlaneDatarefs.SimSpeed);
        v[SimVars.SimRate] = speed > 0 ? speed : 1;
        v[SimVars.Touchdown] = TouchdownFpm / 60; // the mapper takes feet per second
        var title = XPlaneDatarefs.Title(Text(XPlaneDatarefs.UiName), Text(XPlaneDatarefs.Descrip), Text(XPlaneDatarefs.Icao));
        return new SimFrame(v, title);
    }
}
