# ACARS Smoke: SimObject package for MSFS 2024 (T34)

A stationary invisible marker with one smoke effect. The bridge (`SimConnectSource`) creates it with
`SimConnect_AICreateSimulatedObject("ACARS Smoke", …)` at the runway of the destination when the scenario
`dest_fire` runs and the aircraft is within 40 NM; it removes it on `smoke_stop`, when the aircraft is more than
60 NM away, after 90 minutes, or when the sim quits. Wind and drift are the effect engine's own: the bridge
sends no wind.

**Status: unverified draft.** Nothing here has run in MSFS. The files follow the MSFS 2024 SDK pages for
visual effects and `SimConnect_AICreateSimulatedObject`, but the SDK does not describe a smoke SimObject made
for SimConnect, so every step below that needs the sim is a human check.

## Why not `AICreateSimulatedObject_EX1`

The Skybound-derived `Microsoft.FlightSimulator.SimConnect.dll` / `SimConnect.dll` in `C:\Users\avail\SimConnectLibs\sdk2024`
export `AICreateSimulatedObject` but no `_EX1` (checked 2026-10-15). The plain call "only works with non-modular
aircraft", so this SimObject is a legacy (non-modular) `aircraft.cfg` container. With the official SDK wrapper
(T19) `_EX1` can replace the call in `SimConnectSource.ApplySmoke`; nothing else changes.

## What is here

| File | State |
|---|---|
| `PackageSources/SimObjects/Airplanes/ACARS_Smoke/aircraft.cfg` | draft, title `ACARS Smoke` (the string the bridge uses) |
| `…/model/model.cfg`, `ACARS_Smoke.xml`, `ACARS_Smoke.gltf` | draft: a one-triangle model with the node `ACARS_SMOKE_ROOT`; the XML spawns the effect through `ASOBO_GT_FX` |
| `PackageSources/VisualEffectLibs/ACARS/acars_smoke.vfxlib` | list only; **the effect `acars_smoke.xml` is not written** |

## To finish (human, in the MSFS 2024 SDK, DevMode)

1. Make the effect in the Visual Effects Editor: a dark smoke column, about 50 m wide and 300 m high, slow,
   moved by wind. Save it as `VisualEffectLibs\ACARS\acars_smoke.xml`. Its `InstanceID` goes to `FX_GUID` in
   `ACARS_Smoke.xml` (now all zeros).
2. Create a package project in the SDK, add these `PackageSources` folders, build, copy the result to the
   `Community` folder as `acars-smoke`.
3. DevMode → Aircraft selector: is the title `ACARS Smoke` listed? (`SimConnect_EnumerateSimObjectsAndLiveries`
   also lists it.) If the sim wants an aircraft Preset or a flight model, add what it asks for.
4. Run the app with the real bridge, scenario `dest_fire` (Scenarios → run now) in flight within 40 NM of
   the airport: the bridge must create the object, the smoke must stand at the runway and lean downwind.
5. `SimConnect` exception on creation (`CREATE_OBJECT_FAILED`) shows in the app's feed as `simconnect exception …`.

Open points the SDK leaves out: how `Altitude` counts with `OnGround = 1` (the bridge sends 0, ground
placement), whether the effect plays on a SimObject that no one is flying (forum reports differ), and the frame rate cost.
