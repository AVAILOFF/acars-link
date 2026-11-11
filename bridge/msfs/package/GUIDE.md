# T34 — smoke at the runway: step-by-step human check

The short version is in `README.md`, "To finish". This is the same thing in detail, with the expected result at every
step and what to do if it fails. Everything marked **[?]** is not described in the SDK or not verified: write down
what you actually saw, that is the result of the check.

## How it works (what we are checking)

```
dest_fire (scenario) ──smoke: start──▶ app ──OurAirports runways.csv──▶ middle of the planned runway
                                              │
                                              └─ smoke_start {lat, lon} ──▶ bridge (ws://127.0.0.1:47830)
bridge: aircraft ≤ 40 NM from the point ──▶ AICreateSimulatedObject("ACARS Smoke", lat, lon, OnGround=1)
        aircraft > 60 NM / smoke_stop / 90 min / MSFS exit ──▶ AIRemoveObject
SimObject "ACARS Smoke" ──ACARS_Smoke.xml──▶ ASOBO_GT_FX on the ACARS_SMOKE_ROOT node ──FX_GUID──▶ acars_smoke effect
```

The bridge does not pass the wind: the smoke drift is only the effect's own work (the `WindDirection` node in the
effect graph). So the effect must be built to react to wind (step 2).

## 0. What you need

- MSFS 2024 with Developer Mode on (Options → General Options → Developers → Developer Mode).
- MSFS 2024 SDK (DevMode → Help → SDK Installer). The SDK contains the **SimpleFX** sample ("Engine Smoke"): a
  ready-made smoke, a convenient starting point.
- The bridge built with SimConnect: `pnpm bridge:build`. The build output must contain the line
  `acars-msfs-bridge: SimConnect support ON (…)`. If it says OFF, point to the SDK: `dotnet build bridge/msfs -p:MsfsSdk="C:\MSFS 2024 SDK"`.
- The app (`pnpm desktop`) with live data on: without METAR the scenario will not start.
- A SimBrief plan that has a **planned destination runway** and an **alternate** airport.

## 1. Check that the effect plays at all (without our package)

The goal is to make sure the VFX Editor and spawning work before building anything.

1. Start any flight, on the ground or in the air. Do not open the editor from the main menu.
2. DevMode → File → Open project… → `SimpleFX.xml` from the SDK samples folder. In Project Editor →
   **Build All In Project**.
3. View → **VFX Templates / Instances Debugger** → **Spawner** tab → choose your aircraft and a contact point →
   **Spawn**.

**Expected:** the smoke from the sample appears at the aircraft. If there is no smoke, there is no point going on:
the problem is in the SDK or DevMode, not in our package.

## 2. Make the smoke effect

1. Create a working project **outside the repository**, for example `C:\msfs-projects\acars-smoke\`: DevMode → File → New project.
   Package name: `acars-smoke`.
2. Project Editor → **Add Package** → type **Visual Effect** → name `acars-smoke` → **Create**.
3. In the Visual Effects Wizard name the effect **`acars_smoke`** → **Create Visual Effect**. Save the project right
   away (Project Editor → Project → Save).
4. Build the smoke column. The easiest way is to take the graph from `EngineSmoke.xml` of the SimpleFX sample as a
   model. Parameters:
   - dark grey smoke, about 50 m wide at the base, about 300 m high, particles rise slowly;
   - the effect is endless, with no end in time: the object lives up to 90 minutes, the bridge removes it itself;
   - **wind:** add a **`WindDirection`** node (right click in the Node Graph, search "wind"), in the Inspector choose
     the `Raw` option: it is the wind direction and speed vector in ft/s. Feed it into particle speed or force.
     Which block node to connect it through is not stated in the documentation **[?]**: pick the variant where the
     smoke visibly leans.
5. Test the effect on your aircraft the same way as in step 1.3 (Spawner or spawn from the Inspector). Try
   different winds (Weather → Preset with 15–25 kt wind): the column must lean **downwind**, that is, go
   in the direction opposite to where the wind blows from.
6. Visual Effects Editor → File → **Save**.
7. Write down the effect's **InstanceID**. It is in the Template/Instances Debugger on the **Asset Packages** tab or
   in the `InstanceID` attribute of the `<VisualEffect.VisualEffect>` element in the saved `acars_smoke.xml`.
   Format: `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}`.

## 3. Add the SimObject and build the package

1. Copy `bridge/msfs/package/PackageSources/SimObjects/` into the working project's `PackageSources`, next to the
   effect folder the editor created. Do **not** copy our `VisualEffectLibs/ACARS/acars_smoke.vfxlib`:
   the editor has already created its own `.vfxlib` with the effect.
2. In the copied `SimObjects/Airplanes/ACARS_Smoke/model/ACARS_Smoke.xml` replace
   `{00000000-0000-0000-0000-000000000000}` in `<FX_GUID>` with the InstanceID from step 2.7.
3. In Project Editor add a second asset group for the SimObject to the `acars-smoke` package and set its source
   folder to `PackageSources\SimObjects\Airplanes\ACARS_Smoke`. What the group type is called for a non-modular
   `aircraft.cfg` in 2024 has not been verified **[?]**: take the type from the list that fits SimObject/Aircraft.
4. **Build All In Project**. Watch the DevMode console: glTF build errors (the model is one invisible triangle
   written by hand) or `aircraft.cfg` errors. Write them down verbatim.
5. The finished package is in `Packages\acars-smoke` next to the project file. Copy it to the **Community** folder
   (path: Options → General Options → Developers, "Community folder", or in `UserCfg.opt`, the
   `InstalledPackagesPath` line). Restart MSFS.

**Check:** DevMode → Aircraft Selector — is `ACARS Smoke` in the list **[?]**. If the simulator requires an aircraft
preset, a flight model or something else, write down exactly what, and what you added to make it appear.
If `ACARS Smoke` is not in the list, the bridge cannot create the object.

## 4. Prepare the flight

The `dest_fire` scenario fires by itself with a probability of 2 % at 120 NM before the destination. For the check
it is started manually, but **the scenario's conditions must be met**:

| Condition | How to ensure it |
|---|---|
| phase `CRUISE` or `DESCENT` | be airborne after the climb, in cruise or in descent |
| no diversion | do not answer `DIVERT` in other scenarios of this flight |
| `ofp.dest_rwy` | the destination runway is selected in the SimBrief plan |
| `ofp.altn` | the plan has an alternate |
| `wx.dest_smoke_drift` | the destination METAR has a wind with a direction: `27012KT` is fine, `00000KT` (calm) and `VRB03KT` are not |

A short flight of 80–150 NM is the most convenient: it is not long to fly until 40 NM. Example: EFHK–EETN, if the
Tallinn METAR wind is not variable. Set the MSFS weather to **Live**: then the drift in the simulator matches the
wind from the METAR that is written in the telex.

Start order:
1. MSFS, flight at a stand.
2. Bridge: `bridge\msfs\src\AcarsBridge\bin\Debug\net10.0\acars-msfs-bridge.exe` (optionally with `--verbose`).
   Do not close the window.
3. `pnpm desktop` → the status shows the bridge connected, source `simconnect`.
4. Load the OFP, start the flight, logon and FLT NBR — as usual.

## 5. Start the fire and look at the smoke

1. In cruise or in descent: flight window → "Irregular event" → **Fire at destination airport** →
   **Run now**.
2. **Expected in the feed:** "Started manually: dest_fire", then the telex `FIRE REPORTED NEAR RWY …`, containing
   `SMOKE DRIFTING <bearing>, WIND <ddd>/<nn>KT`. If the scenario did not start, the feed says which condition
   is not met.
3. **There must be no errors in the feed.** Possible lines "Sim command smoke failed" and what they mean:
   - `no planned runway in the OFP` — there is no runway in the plan;
   - `no coordinates for XXXX RWY nn` — the runway is not in OurAirports or there is no network;
   - `unavailable sim not connected` — the bridge is not connected to MSFS.
4. Answer the telex `HOLD` (or wait 8 minutes: HOLD is chosen by default). Do not answer `DIVERT`:
   the smoke would then stay, but you would fly away from it.
5. Approach the airport. At **40 NM** the bridge creates the object. A SimConnect error is visible in the bridge
   status in the app as `simconnect exception CREATE_OBJECT_FAILED …`. It is a **status**, not a feed line:
   `README.md` is inaccurate at this point.
6. Look at the runway: from far away, at 20–30 NM, and up close, on approach.

**What to write down (the result of the check):**
- [ ] the smoke stands at the **middle of the planned runway**, not to the side and not in the air (check `Altitude = 0` + `OnGround = 1`);
- [ ] visible from afar: from what distance it is noticeable;
- [ ] leans **downwind**, towards the bearing from the telex (`SMOKE DRIFTING …`);
- [ ] whether the effect plays on an object that nobody controls (forums say different things about this) **[?]**;
- [ ] FPS: the value at 20–30 NM from the airport without smoke (before 40 NM) and with smoke, by the DevMode counter or your own overlay;
- [ ] after 20 minutes of HOLD the telex `FIRE NEAR RWY … UNDER CONTROL` arrives and the **smoke disappears**.

## 6. Check that the smoke is removed

Each case is a separate short test (can be at the same airport):
1. **By the scenario** — after "UNDER CONTROL" (step 5).
2. **Distance over 60 NM** — start the fire, approach closer than 40 NM (the smoke appeared), fly away beyond 60 NM, come back:
   the smoke must disappear, and appear again at 40 NM.
3. **Stopping the flight** in the app — the smoke disappears.
4. **Exiting MSFS** with the smoke alive, then a new start and a flight to the same airport: the bridge creates
   the smoke again, because the request is still valid (up to 90 minutes or until the flight is stopped).

## If something is wrong

| Symptom | Where to look |
|---|---|
| `ACARS Smoke` is not in Aircraft Selector | step 3: the asset group type, `aircraft.cfg` or glTF errors in the build console |
| `CREATE_OBJECT_FAILED` in the bridge status | the header `title = "ACARS Smoke"` is not found: the package is not in Community or not built |
| the object is created (no errors) but there is no smoke | `FX_GUID` (step 3.2), whether `Asobo\Generic\FX.xml` and the `ASOBO_GT_FX` template exist in 2024 **[?]**; VFX Instances Debugger — did the effect instance appear |
| smoke underground or in the air | how MSFS counts `Altitude` with `OnGround = 1` **[?]**: write down at what height it stands |
| smoke is vertical in a strong wind | the effect graph has no `WindDirection` (step 2.4) |

## What to send after the check

The answers to the step 5 checklist, verbatim build and SimConnect errors if there were any, a screenshot of the smoke
from a distance and up close, FPS "before/after". If anything was changed for the package (group type, preset,
`aircraft.cfg`, XML), send the changed files: they must go back into `bridge/msfs/package/`, and the InstanceID into
`ACARS_Smoke.xml` in the repository.

Sources (MSFS 2024 SDK, checked 2026-10-15):
[The Visual Effects Editor](https://docs.flightsimulator.com/msfs2024/retail/devmode/editors/vfx-editor/the-visual-effects-editor/),
[SimpleFX sample](https://docs.flightsimulator.com/msfs2024/retail/samples-tutorials/samples/misc/simplefx/),
[WindDirection node](https://docs.flightsimulator.com/msfs2024/retail/devmode/editors/vfx-editor/nodes/winddirection/),
[Visual Effects](https://docs.flightsimulator.com/msfs2024/retail/content-configuration/visualeffects/visual-effects/).
