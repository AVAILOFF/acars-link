# Smoke and rescue services: detailed guide for you

This document covers everything **you** have to do by hand to get the following in the simulator:

1. **smoke at the destination runway** (task T34): the code is ready, the visual effect and the MSFS package are missing;
2. **fire trucks and an ambulance on arrival** (task T54): there is no code yet, first we need data that
   can only be obtained in the simulator.

Each step is described as: what to do → what should happen → what to do if it did not work.
The mark **[?]** means the SDK documentation does not cover this or nobody has verified it. Write down what you
actually saw: that is the result.

State as of 2026-10-15.

---

## Contents

- [Part 0. How it works](#part-0-how-it-works)
- [Part 1. Preparing the computer](#part-1-preparing-the-computer)
- [Part 2. Smoke: effect and package](#part-2-smoke-effect-and-package)
- [Part 3. Smoke: in-flight check](#part-3-smoke-in-flight-check)
- [Part 4. Rescue services: what is needed before starting](#part-4-rescue-services-what-is-needed-before-starting)
- [Part 5. Rescue services: starting the task and checking](#part-5-rescue-services-starting-the-task-and-checking)
- [Part 6. What to send me](#part-6-what-to-send-me)
- [Appendix. Common problems](#appendix-common-problems)

---

## Part 0. How it works

### Smoke

```
dest_fire scenario (core)
   │  ~120 NM before the destination, with 2 % probability (or manually via "Run now")
   │  telex FIRE REPORTED NEAR RWY …  +  step "smoke: start"
   ▼
app (controller.ts)
   │  finds the midpoint of the planned runway in OurAirports runways.csv
   │  sends the bridge smoke_start {lat, lon}
   ▼
bridge acars-msfs-bridge (ws://127.0.0.1:47830)
   │  remembers the point
   │  aircraft closer than 40 NM  → AICreateSimulatedObject("ACARS Smoke", lat, lon, on the ground)
   │  farther than 60 NM, smoke_stop, 90 minutes, MSFS exit → AIRemoveObject
   ▼
MSFS: invisible "ACARS Smoke" object from our package (in Community)
   │  its XML starts the smoke visual effect (by InstanceID)
   ▼
smoke column at the runway, drifting with the wind: handled by the effect itself
```

Three things to understand:

- **The app and the bridge already do everything.** The only thing missing is what is done in the MSFS editor: the
  smoke effect itself and the package with the `ACARS Smoke` object. Without the package the bridge tries to create the object, MSFS does not
  find it, and you see the error `CREATE_OBJECT_FAILED`.
- **The bridge does not pass the wind.** The smoke leans with the wind only if the effect is built that way (the `WindDirection` node).
- **The object is created only at 40 NM**, although the telex arrives at 120 NM. MSFS does not load
  objects farther out anyway, and an extra object would cost FPS.

### Rescue services (how it will work after T54)

```
scenario MAYDAY / PAN / cabin fire / medical
   │  step "rescue: full | standby | medical"
   ▼
app: landing runway threshold and heading (OurAirports) + list of vehicles from settings
   │  rescue_start {level, rwy, count, titles}
   ▼
bridge (RescueController)
   ≤ 15 NM  → vehicles appear beside the runway (45 m from the centerline, 70 m apart, 100 m from the threshold)
   touchdown → they follow the aircraft (full only), 25 m behind
   stop     → they surround the aircraft in a circle of 50 m radius
   +10 min  → they disappear (or farther than 30 NM: go-around)
```

The vehicles are **standard MSFS objects** (as in the Emergency Response On Demand mod); there is no need to make a package of our own for them. But you need to know their names exactly, otherwise the bridge cannot create them. This is
your main job for T54 (part 4).

---

## Part 1. Preparing the computer

Done once, needed for both smoke and vehicles.

### 1.1. Developer Mode in MSFS 2024

1. Start MSFS 2024.
2. **Options → General Options → Developers → Developer Mode = ON**.
3. The DevMode menu bar appears at the top (File, Edit, View, Tools, Debug, Help…). If you cannot see it, move
   the mouse to the top of the screen.

### 1.2. MSFS 2024 SDK

1. DevMode → **Help → SDK Installer**, download and install the SDK. Remember the path, for example
   `C:\MSFS 2024 SDK`.
2. The **SimpleFX** sample (engine smoke) is **not included** in the main SDK; samples are downloaded separately:
   DevMode → **Help → Samples** → the **"Samples"** installer (the main one, not "Xbox Samples" and not "DA62").
   Install it, then find the file `SimpleFX.xml` on disk (Windows search by name, usually inside
   the SDK folder, section `Samples\DevmodeProjects`) and remember the path. Your SDK is installed in `D:\MSFS 2024 SDK`
   (checked 2026-10-15: there are no samples there yet).

**If the installer is not in the Help menu:** the SDK can be downloaded from the SDK documentation page
(docs.flightsimulator.com → MSFS 2024 → SDK). Then give the path when building the bridge (step 1.3).

### 1.3. Build the bridge with SimConnect support

In the repository folder:

```bash
pnpm bridge:build
```

In the output find the line:

```
acars-msfs-bridge: SimConnect support ON (…)
```

- **ON**: all good.
- **OFF**: the build did not find the SDK. Give the path explicitly:

```bash
dotnet build bridge/msfs -p:MsfsSdk="C:\MSFS 2024 SDK"
```

  To avoid typing the path every time: copy `bridge/msfs/Local.props.example` to `bridge/msfs/Local.props`
  and put the path there. This file is not committed to git.

The finished bridge is located here:

```
bridge\msfs\src\AcarsBridge\bin\Debug\net10.0\acars-msfs-bridge.exe
```

**The app does not start the bridge itself.** You have to start it manually before each flight (part 3).

### 1.4. Check that the bridge sees the simulator

1. MSFS: start any flight (at the parking stand).
2. Run `acars-msfs-bridge.exe --verbose`. Do not close the window.
3. Start the app:

```bash
pnpm desktop
```

4. In the app, the **"Sim bridge"** status line should show: connected, source `simconnect`,
   simulator `connected`.

If it says `fake`, you started the bridge with `--source fake`. If `disconnected`, MSFS is still loading the flight:
the bridge retries by itself (1, 2, 4, 8, 16, 30 s).

### 1.5. Live data

App → **Settings → "Live data and events" → "Live data" = on**.

Without live data:
- `runways.csv` is not downloaded from OurAirports, and without it there are no runway coordinates, so there will be neither smoke nor
  vehicles;
- there is no destination METAR, and without wind the fire scenario will not start.

---

## Part 2. Smoke: effect and package

> The package for the installer (T104) is built following [guide-smoke-package.md](guide-smoke-package.md): from an empty project, without the SimpleFX sample. The package from this part is for yourself only: SDK samples must not be distributed (SDK EULA, item 1 b).

### 2.1. Make sure effects work at all

The goal is to rule out problems with the SDK itself before building anything.

1. Start any flight. **Not in the main menu**: DevMode editors do not work in the menu.
2. DevMode → **File → Open project…** → select `SimpleFX.xml` from the SDK samples.
3. The **Project Editor** opens. Click **Build All In Project**. Wait for the build to finish; there must be no red errors
   in the console.
4. Open the Visual Effects Editor: in the Project Editor expand the package `mycompany-simple-fx` → select the
   **VisualEffectsLib** group → in the **Project Inspector** window click **Load In Editor**.
   (The View menu of the Project Editor itself is not the one: it has only Project Inspector and Undo History.)
5. In the **View menu of the Visual Effects Editor window** → **Template/Instance Debugger** → the **Spawner** tab.
6. Select your aircraft, then any **Contact Point** (for example, an engine) → **Spawn**. The aircraft is easy to
   find like this: Camera menu → Developer Camera, key `F5`. The same spawn buttons are in the Inspector if you
   select the effect in the Visual Effects Editor.

**Expected result:** smoke from the sample comes out of the aircraft.

**If there is no smoke:** there is no point in going further. The problem is in the SDK or in DevMode, not in our package. Check
the SDK version (it must match the simulator version), rebuild the sample, restart MSFS.

### 2.2. Create your own project

The simplest way is not to build the effect from scratch but to take a **copy of the SimpleFX sample** and rework its engine smoke
into a smoke column. The copy already has everything needed: a material with the smoke texture (`vfx_smoke.png`) and a ready
graph. Creating an empty effect via New Project / Wizard is not needed.

1. Close the SimpleFX project in DevMode if it is open.
2. Copy the **whole folder** `D:\MSFS 2024 SDK\Samples\DevmodeProjects\Misc\SimpleFX` to
   `C:\msfs-projects\acars-smoke` (outside the repository). Do not touch the original in the SDK.
3. DevMode → **File → Open project…** → `C:\msfs-projects\acars-smoke\SimpleFX.xml`.
4. Project Editor → **Build All In Project**: the build should pass, as with the original.

The project has two packages: `mycompany-simplefx-materiallib` (material and smoke texture) and `mycompany-simple-fx`
(the `EngineSmoke` effect itself). Renaming them is optional, but **both** go to Community afterwards.

> The copy has the same internal identifiers (GUIDs) as the sample. If someone puts both our
> package and the original sample in Community, they may conflict **[?]**. When the effect is ready, send me its
> XML: I will replace the GUIDs with new ones, which is a mechanical edit.

### 2.3. Build the smoke column effect

#### How the graph is organized (using EngineSmoke as an example)

Open the effect in the editor: Project Editor → expand `mycompany-simple-fx` → group **VisualEffectsLib** →
Project Inspector → **Load In Editor**. In the Visual Effects Editor window you will see a node graph. The
main chain runs from top to bottom, and "computing" nodes are connected to it from the left:

```
VisualEffect (EngineSmokeSample)
   └─ Emitter            — how many particles and for how long to emit
       └─ Init           — what a particle is like when born: lifetime, size, velocity
           └─ Update     — what happens to it next (empty in the sample)
               └─ Output — how it looks: color and transparency

Velocity (Velocity in Init) = Add(
     LocalDirection(x = RandomValue −0.5…0.5, z = RandomValue −0.5…0.5),   ← random sideways spread
     GravityVector(GravityScale = −1)                                       ← upward (gravity reversed)
)

Color (ParticleColor in Output) = Vector4(
     r = g = b = 0.2,                                   ← gray
     w (transparency) = BezierCurve(AgeOverLifetime)    ← 0 → 1 → 0: appears and fades
)
```

Each node parameter is a field in the **Inspector**: select a node with the mouse and its fields appear on the right. You can
type a number straight into the field, or feed the output of another node into it (drag a link with the mouse from the output to the input).

Right now the sample is a small gray puff: a particle lives 4 s, has radius 1 m and rises ~10 m/s. We need to make a
large, slow, dark column and add wind. That is four edits.

#### Edit 1. Emitter: endless and visible from far away

Select the **Emitter** node, in the Inspector:

| Field | Value | Why |
|---|---|---|
| `TimeEmission` | `-1` | no end in time; the bridge removes the object itself |
| `RateType` | `Time` | particles per second |
| `Rate` | `4` | 4 particles per second; with a 60 s lifetime that is ≈ 240 particles on screen, cheap for FPS |
| `Capacity` | `300` | maximum particles at once. The default is 16; at 4 per second and a 60 s lifetime 240 are needed, otherwise new particles will not appear and the column will look "ragged" |
| `EmitInLocalSpace` | **off** | velocity in world axes: "up" is up, wind follows the compass directions |
| `MaxDistanceEmission` | `80000` | beyond this distance from the camera (in meters) particles are not born. The object is created at 40 NM ≈ 74 km, hence 80 km. Whether the field has an upper limit, the documentation does not say **[?]**; if smoke appears only up close, write down from what distance |

#### Edit 2. Init: large slow particles

Select the **Init** node:

| Field | Was | Now | Why |
|---|---|---|---|
| `Lifetime` (seconds) | 4 | `60` | the particle has time to rise high |
| `Size` (radius, meters) | 1 | `25` | puff width ~50 m |

Column height ≈ rise speed × lifetime. The rise from here on is ~5 m/s, so ~300 m.

#### Edit 3. Velocity: slower upward, wider sideways, plus wind

1. **GravityVector** node: `GravityScale` `−1` → **`−0.5`**. Gravity ≈ 9.8 m/s, so the rise will be ≈ 5 m/s.
2. Two **RandomValue** nodes (sideways spread): `MinRandValue` `−0.5` → **`−2`**, `MaxRandValue` `0.5` → **`2`**.
   The puffs spread wider, the column is thicker at the base.
3. **Wind.** The wind velocity must be added to the particle velocity. Wind units are feet per second, particle
   velocity is in meters per second, so the wind must be multiplied by 0.3048.
   1. Right-click on an empty spot of the graph → search `wind` → add **WindDirection**. In the Inspector:
      option **`Raw`** (wind vector with speed, ft/s).
   2. Right-click → add **Multiply** (inputs `x`, `y`). Drag with the mouse **from** the yellow `OutputValue` dot
      of the WindDirection node **to** the circle left of `x` on Multiply.
      Into input `y` put a **Vector3** node with `x = y = z = 0.3048`. Do **not** type 0.3048 as a number straight into `y`:
      per the documentation, a number multiplied by a vector becomes `(0.3048, 1, 1)`, and only
      one wind axis would be scaled down.
   3. Right-click → add a second **Add**. The first input is the output of the **old Add** (the one currently going into
      `Velocity`), the second input is the output of **Multiply**.
   4. Connect the output of the **new Add** to the **`Velocity`** field of the **Init** node (instead of the old Add).

   The result: `Velocity = (sideways spread + rise) + wind × 0.3048`.

   What to expect: with 12 knots of wind (≈ 6 m/s) and a 5 m/s rise, the smoke will lean about 50° from vertical.
   If the lean looks too strong, replace `0.3048` with a smaller number (for example, `0.15`); this is a game
   tuning value, not physics.

Why we add the wind in **Init** and not in **Update**: in Init the velocity is set once when the particle is born,
and it flies straight. How adding velocity in Update works is not described in the documentation **[?]**; you can
try it if you do not like the result in Init.

#### Edit 4. Color: dark smoke

**Vector4** node (color): `x`, `y`, `z` `0.2` → **`0.08`** (almost black). Leave input `w` (transparency, curve
0 → 1 → 0) alone: thanks to it the puffs smoothly appear and fade.

If the smoke is too dense and covers the runway completely, limit the transparency: add a **Multiply** between
BezierCurve and `w` with the number `0.6`.

#### Save and build

1. Visual Effects Editor → **File → Save**.
2. Project Editor → **Build All In Project**. The console shows `0 failed`.
3. Go on to the check (2.4).

**If something in the window is named differently** from here (for example, a field or a node), send a screenshot of the graph and the
Inspector and I will sort it out from that.

### 2.4. Check the effect on your aircraft

1. Save the effect: Visual Effects Editor → **File → Save**.
2. **Build All In Project**.
3. As in step 2.1: Visual Effects Editor → View → Template/Instance Debugger → Spawner → your aircraft → Spawn
   (effect `EngineSmokeSample`).
4. Set the wind: MSFS weather panel → preset or manual setup, wind 15–25 knots.
5. Fly the camera around the aircraft (drone camera).

**Expected result:** the column leans **with the wind**, that is, it goes to the side **opposite** to the one the wind
blows from. Wind 270° (from the west) → smoke goes east.

**If the smoke is vertical:** `WindDirection` is not connected or is connected to a node that does not affect
particle motion. Go back to step 2.3.

**If the smoke leans against the wind:** the vector must be reversed (multiplied by −1) before being fed to the particles.

### 2.5. Record the effect's InstanceID

This is an identifier of the form `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}`. The `ACARS Smoke` object uses it to find the
effect. Where to get it (either way):

- Visual Effects Editor → View → Template/Instance Debugger → the **Asset Packages** tab → your effect;
- or open `PackageSources\VisualEffectLibs\MyCompany\simple-fx\EngineSmoke.xml` in Notepad and find the
  `InstanceId` attribute of the `<VisualEffect.VisualEffect>` element. In the sample copy it is
  `{88CDD86E-643D-4026-9A17-4E18755E5566}`, until I replace the GUIDs (step 2.2).

Copy it in full, with the curly braces.

### 2.6. Add the ACARS Smoke object

The object is an "aircraft" without a model (one empty node with no geometry) that does nothing, only starts
the effect at its location. Its files are already in the repository.

1. Copy the folder
   `bridge\msfs\package\PackageSources\SimObjects\`
   from the repository into the `PackageSources` of your project (`C:\msfs-projects\acars-smoke\PackageSources\`), **next to** the effect folder
   created by the editor.
2. Do **not** copy the file `bridge\msfs\package\PackageSources\VisualEffectLibs\ACARS\acars_smoke.vfxlib`:
   the editor has already created its own `.vfxlib` with the real effect.
3. In the **copied** file
   `PackageSources\SimObjects\Airplanes\ACARS_Smoke\model\ACARS_Smoke.xml`
   find the line with `<FX_GUID>` and replace the zeros
   `{00000000-0000-0000-0000-000000000000}`
   with the InstanceID from step 2.5.
4. In the same directory check `aircraft.cfg`: the line `title = "ACARS Smoke"`. **Do not change** it: this is exactly the
   name the bridge looks for.

### 2.7. Build the package

1. In the Project Editor select the package `mycompany-simple-fx` and add a **second asset group** (Asset Group)
   to it for the object.
2. The source folder of the group is `PackageSources\SimObjects\Airplanes\ACARS_Smoke`.
3. Group type: for a non-modular `aircraft.cfg` in MSFS 2024 it has not been verified **[?]**. Choose from the list the type
   suited to SimObject / Aircraft. **Write down which one you chose**.
4. **Build All In Project**.
5. Watch the DevMode console. Possible errors:
   - glTF errors: the model is a single empty node written by hand (the first version with a triangle did not build); if the builder does not like it,
     **copy the error text verbatim**;
   - `aircraft.cfg` or `model.cfg` errors: also verbatim.
6. The finished packages appear in the `Packages` folder next to the project file: `mycompany-simple-fx` and
   `mycompany-simplefx-materiallib`.

### 2.8. Install the package

1. Find the **Community** folder:
   - Options → General Options → Developers shows the path to Community; or
   - the file `UserCfg.opt`, line `InstalledPackagesPath`: append `\Community` to that path.
2. Copy **both** folders from step 2.7 there (effect and material).
3. **Restart MSFS** (packages from Community are read only at startup).

### 2.9. Check that MSFS sees the object

Either way:

- DevMode → **Tools → Aircraft Selector** → look for `ACARS Smoke` in the list **[?]**;
- DevMode → **Tools → SimObject Spawner** → filter **Packages** = `mycompany-simple-fx` → our object should be in the **Objects**
  list. You can click **Spawn** right away: the object is created on the ground at the developer camera point, and
  smoke should start.

**If the object is not there:** the bridge will not be able to create it either. Possible causes:
- the package is not in Community or MSFS was not restarted;
- wrong asset group type (step 2.7.3): try another one;
- the simulator needs something else for an "aircraft" (a preset, a flight model). Write down exactly what it prints in
  the console and what you added to make the object appear. Those changes must then be returned to the repository.

**If the object is there but there is no smoke:**
- check `<FX_GUID>` (step 2.6.3): the InstanceID must match character for character;
- Visual Effects Editor → View → Template/Instance Debugger: did an effect instance appear when the object was created;
- the object's XML starts the effect through the `ASOBO_GT_FX` template from `Asobo\Generic\FX.xml`. Whether this template exists in
  MSFS 2024 has not been verified **[?]**. If the console shows an error about `ASOBO_GT_FX` or `FX.xml`, send it to me.

---

## Part 3. Smoke: in-flight check

### 3.1. Prepare the flight plan

The fire scenario triggers on its own rarely (2 % per flight). For the check it is started manually, but **the scenario
conditions must be met**, otherwise it will not start:

| Condition | How to ensure it |
|---|---|
| phase `CRUISE` or `DESCENT` | be airborne after the climb, in cruise or in descent |
| no diversion | do not reply `DIVERT` in other scenarios of this flight |
| destination runway is present | in SimBrief choose the **arrival runway** (the Arrival Runway field) |
| alternate is present | in SimBrief specify an **alternate airport** |
| wind in the destination METAR | wind with a direction: `27012KT` works, `00000KT` (calm) and `VRB03KT` do not |

**Flight tips:**
- a short flight of 80–150 NM: it is a short way to 40 NM, and there will still be a cruise;
- an example is EFHK–EETN (Helsinki–Tallinn), if the Tallinn METAR wind is not calm and not VRB;
- set the MSFS weather to **Live**: then the wind in the simulator matches the wind from the METAR printed in the telex,
  and you can compare the drift direction.

### 3.2. Startup order

1. **MSFS** → a flight at the departure airport stand.
2. **Bridge:**
   ```
   bridge\msfs\src\AcarsBridge\bin\Debug\net10.0\acars-msfs-bridge.exe --verbose
   ```
   Do not close the window until the end of the check.
3. **App** (`pnpm desktop`) → "Sim bridge" status: connected, `simconnect`.
4. Load the OFP from SimBrief, start the flight, do the logon and FLT NBR as usual.
5. Take off.

### 3.3. Start the fire

1. Climb and wait for the `CRUISE` phase (a minute after reaching the cruise level) or start the descent.
2. Flight window → **"Irregular event"** → select **"Fire at destination airport"** → **"Run now"**.
3. **The feed should show:**
   - the line "Started manually: dest_fire";
   - a telex roughly like this:
     ```
     FIRE REPORTED NEAR RWY 08
     SMOKE DRIFTING E, WIND 270/12KT
     VIS REDUCED IN SMOKE, RESCUE ON SCENE
     PREPARE DIVERSION EFHK
     NO ESTIMATE, NEXT UPDATE 1432Z
     REPLY HOLD OR DIVERT
     ```
     Note the compass direction after `SMOKE DRIFTING`: the smoke in the simulator should go the same way.
4. **If the scenario did not start**, the feed says which condition is not met. Compare with the table in 3.1.

### 3.4. Smoke command errors

The feed **must not** contain the line "Sim command smoke failed". If it is there, this is what
the text after the colon means:

| Text | Cause | What to do |
|---|---|---|
| `no planned runway in the OFP` | the plan has no arrival runway | choose one in SimBrief, load the OFP again |
| `no coordinates for XXXX RWY nn` | the runway is not in OurAirports or there is no network | check "Live data" and the internet; write down the airport and runway |
| `unavailable sim not connected` | the bridge is not connected to MSFS | step 1.4 |

### 3.5. Reply and approach

1. Reply to the telex with **`HOLD`** or just wait 8 minutes: `HOLD` is chosen automatically.
   **Do not reply `DIVERT`:** the smoke will remain, but you will fly away from it.
2. Fly to the airfield. At **40 NM** the bridge creates the object.
3. If creation failed, the error will be in the **bridge status** in the app (not in the message feed):
   `simconnect exception CREATE_OBJECT_FAILED …`. This means MSFS did not find the `ACARS Smoke` object:
   go back to steps 2.8–2.9.
4. Look at the runway twice: from afar (20–30 NM) and up close, on approach. An external camera is convenient.

### 3.6. What to record

Tick each item and add what you saw:

- [ ] the smoke stands at the **midpoint of the planned runway**, not off to the side and not hanging in the air;
- [ ] from what distance the smoke is noticeable (NM);
- [ ] the smoke leans **with the wind**, toward the compass direction from the telex (`SMOKE DRIFTING …`);
- [ ] the effect plays at all on an object that nobody controls **[?]** (forums disagree);
- [ ] FPS at 20–30 NM from the airfield: before the smoke appears (farther than 40 NM) and with smoke. Counter: DevMode
      (Debug → statistics) or your overlay;
- [ ] after 20 minutes of HOLD (or later: the time is random, from 20 minutes to 2 hours, with updates every
      20 minutes) the telex `FIRE NEAR RWY … UNDER CONTROL` arrives and **the smoke disappears**.

To avoid waiting up to 2 hours you can speed up the simulation (×2, ×4): the time in the scenario is flight time.

### 3.7. Check that the smoke is removed

Each case is a separate short test, can be at the same airfield:

1. **By scenario**: after "UNDER CONTROL" (step 3.6).
2. **Removal farther than 60 NM**: start the fire, approach closer than 40 NM (smoke appeared), fly away farther than
   60 NM, come back: the smoke should disappear and appear again at 40 NM. Between 40 and 60 NM nothing changes;
   this is by design.
3. **Stopping the flight** in the app: the smoke disappears immediately.
4. **Exit from MSFS** with live smoke, then a new start and a flight to the same airfield without stopping the flight in
   the app: the bridge creates the smoke again, because the request is still active (up to 90 minutes or until the flight
   is stopped).
5. **90 minutes**: after the fire starts, the smoke lives no longer than 90 minutes, even if the scenario has not ended.
   This item need not be checked specially: it is covered by tests.

---

## Part 4. Rescue services: what is needed before starting

> **Obsolete (2026-10-17):** the current guide for rescue services is `docs/guide-rescue.md`.

Task T54 is approved (own implementation in the bridge), but the card has places that must not be guessed. I
will start the code when they are closed.

### 4.0. Already checked by me (2026-10-15): nothing needed from you

| What | Result |
|---|---|
| Landing runway from the OFP | the SimBrief field `destination.plan_rwy` is present in all our OFPs (for example, RJBB `06L`), the core already parses it (`ofp/parse.ts`, `planRwy`) |
| Vehicle movement | the `SIMCONNECT_DATA_WAYPOINT` structure exists in your SimConnect wrapper (`SimConnectLibs/sdk2024/…/Microsoft.FlightSimulator.SimConnect.dll`), so a vehicle route via `AI WAYPOINT LIST` can be built. Whether it works in the simulator will be shown by the check after implementation |
| SimObject Spawner | exists in MSFS 2024: DevMode → Tools → SimObject Spawner (SDK documentation) |

### 4.1. Step 1: find the vehicle names (required, only you)

The bridge creates a vehicle by its **name** (`title` in the object's `sim.cfg` / `aircraft.cfg`). The default names
are taken from the Emergency Response On Demand mod settings. Whether such objects exist in your MSFS is unknown.

**We check these five:**

| # | Name | Expected |
|---|---|---|
| 1 | `ASO_Firetruck02` | fire truck |
| 2 | `Truck Fire Long 02` | fire truck (long) |
| 3 | `Truck Fire Short` | fire truck (short) |
| 4 | `Truck Fire Short 02` | fire truck (short) |
| 5 | `SUV_NorthAm` | SUV of the fire-fighting commander |

**How to check:**

1. MSFS 2024, any flight **on the ground** at a large airport (for example, EDDF), Developer Mode on.
2. DevMode → **Tools → SimObject Spawner**.
3. Filter **Packages**: "All Packages".
4. Open the **Objects** list and look for each name from the table. If the list accepts text input, type
   part of the name: `Fire`, `Truck`, `SUV` **[?]**.
5. Clear the **Lock Position** checkbox and move the developer camera (Developer Camera; where it is enabled
   in 2024 is **[?]**) to the apron next to you. The **Display Position Debug** checkbox shows a sphere at the point where
   the object will appear: the spawn point is always on the ground.
6. Select an object → **Spawn**.
7. For each one write down:
   - whether it was found in the list and under which **exact** name (upper/lower case, spaces, underscores);
   - whether it appeared on the ground (not underground, not in the air);
   - what it looks like: a fire truck, what livery, an SUV;
   - whether it has flashing lights (Play Animation, if the button exists).
8. Delete the created objects with the **Remove All** button at the bottom of the window.

**If the names in the Objects list differ from the table** (for example, the folder name is shown rather than `title`):
DevMode → **Tools → Virtual File System** → find the object's folder (search for `fire`, `truck`) → open
`sim.cfg` or `aircraft.cfg` → the `title = …` lines. Write down exactly those: the bridge uses `title`.

**If the list has more fire trucks** (other models, airfield foam vehicles, Rosenbauer Panther and
so on), write them down too. The more different models, the better the convoy looks.

### 4.2. Step 2: find an ambulance

The mod settings have no ambulance, so one has to be found.

1. In the same SimObject Spawner, search for the words: `ambulance`, `medic`, `EMS`, `rescue`, `paramedic`,
   `hospital`.
2. If nothing: Tools → Virtual File System, the same search by folder names.
3. If found, spawn it, check that it really is an ambulance, and write down the exact `title`.
4. If not found, write "no ambulance". Then the `medical` level will give only a message in the feed, without
   a vehicle (approved that way in the card). Later a name can be added in the app settings if you
   find one in some add-on.

### 4.3. Step 3: MSFS 2020 (if you have it)

If MSFS 2020 is installed, repeat steps 4.1–4.2 there. In 2020 there is no SimObject Spawner **[?]**; search
through the Aircraft Selector or Virtual File System.

If you do not have MSFS 2020, say so: then the T54 report will say "not checked in 2020".

### 4.4. Step 4: choose the source for the number of vehicles

How many fire trucks to place depends on the **airport's rescue and fire-fighting category**. It is
determined by the largest aircraft (fuselage length and width), ICAO Annex 14, Volume I, Table 9-1. The number of vehicles
per category comes from Annex 14 / Doc 9137, Part 1.

Currently the card has this table:

| Category | Typical aircraft (guideline) | Vehicles |
|---|---|---|
| 1–5 | small, regional | 1 |
| 6–7 | A320, B737 | 2 |
| 8–10 | A330, B777, A350, A380 | 3 |

Plus one SUV for the fire-fighting commander.

But it comes from a **secondary source** (a KCAA presentation at ICAO ESAF 2022 citing Doc 9137).
Annex 14 and Doc 9137 are paid and not publicly available. Under the realism rule I need your decision: choose
**one** option:

- **a) Primary source.** You have Annex 14 Volume I or Doc 9137 Part 1 (PDF): send the file or the path to it.
  I will verify the table and record the source with the verification date.
- **b) Secondary source as an assumption.** The table stays as above, and the card records "per the
  KCAA presentation / ICAO ESAF 2022, not per the primary source".
- **c) Game rule.** Without a reference to ICAO, for example: narrow-body, 2 vehicles; wide-body, 3;
  regional, 1.

### 4.5. Step 5: pass the smoke check

Parts 2–3 of this guide are done, and `ACARS Smoke` is created by the bridge **without** `CREATE_OBJECT_FAILED`.

This is not a formality: the vehicles are created by the same `AICreateSimulatedObject` call. If it does not work for
smoke, the vehicles will not appear either, and it must be sorted out first.

If the smoke as a whole cannot be done (for example, you are stuck on the effect), but the `ACARS Smoke` object is created (visible in
SimObject Spawner and there is no error in the bridge status), that is enough to start T54.

---

## Part 5. Rescue services: starting the task and checking

### 5.1. Start the task

When steps 4.1–4.5 are done, start a new session and write:

> Do T54. Fire truck names: <list from 4.1, exact titles>. SUV: <title or "none">.
> Ambulance: <title or "none">. MSFS 2020: <result of 4.3 or "none">. Category table: option <a/b/c>.
> Smoke checked: <yes / object is created, effect not ready>.

What I will do per the card:

1. **Core and scenarios.** The scenario step `rescue: full | standby | medical` and `rescue: stop`. I will connect it to
   the scenarios:
   - `emergency_mayday`, `ped_fire_cabin` → `full` (vehicles wait at the runway, follow the aircraft, surround it);
   - `emergency_pan` → `standby` (vehicles stand at their positions, do not move);
   - `medical_onboard`, the `MEDICAL` command → `medical` (ambulance at the stand after on-block);
   - if PAN comes first and then MAYDAY, the higher level applies.
2. **App.** Landing runway threshold and heading from OurAirports (planned one from the OFP, otherwise the longest; on a
   diversion, the diversion airport), the `rescue_start` command to the bridge, settings:
   - "Rescue services in the simulator": on/off;
   - lists of object names (fire trucks, ambulance): editable.
3. **Bridge.** `RescueController` with tests (like `SmokeController`): appearance at 15 NM, following,
   surrounding, removal after 10 minutes, at 30 NM and on MSFS exit, re-creation in a new session.
4. A report with a "Human check" section.

### 5.2. Check after implementation

Conditions: MSFS 2024, FBW A32NX (or any A320), a flight with an arrival runway in SimBrief, live data on,
the "Rescue services in the simulator" setting on, the XATC station on.

**Test A: MAYDAY (full level):**

1. Log on to XATC (station `X` + FIR code), send MAYDAY in cruise, answer the question with `CONTINUE`
   (continue to the destination).
2. Approach. At **15 NM** fire trucks should appear at the landing runway threshold (for an A320, 2 if you
   kept the a/b table) and an SUV, beside the runway, about 45 m from the centerline.
3. After **touchdown** the vehicles follow the aircraft, staying about 25 m behind.
4. After **stopping** (less than 1 knot for more than 2 seconds) they surround the aircraft in a circle of about 50 m radius.
5. **10 minutes** after stopping they disappear.
6. FPS: write down the value before 15 NM and with the vehicles.

**Test B: PAN (standby level):**
the same, but with PAN. The vehicles stand at their positions at the runway and **do not follow** the aircraft.

**Test C: go-around:**
MAYDAY, the vehicles appeared, go around and fly farther than 30 NM: the vehicles should disappear. Come back
closer than 15 NM: they appear again.

**Test D: MEDICAL (medical level):**
the `MEDICAL` command in flight, landing, taxi-in, on-block. If an ambulance was found (step 4.2), it is at the stand.
If not, only a message in the feed.

**Test E: landing on a different runway:**
MAYDAY, land on a runway other than the planned one. The vehicles stand at the planned runway; after touchdown they drive to where the aircraft stopped
(in a straight line).

**Test F: MSFS 2020** (if you have it): repeat test A briefly.

**What counts as normal** (these are approved simplifications, not errors):
- the vehicles drive **in a straight line**, over grass and through buildings, not along taxiways;
- the vehicles stand at the runway **in advance**, and do not drive out of a fire station;
- the 15 / 30 NM thresholds and 10 minutes are game numbers.

**What to record:** for each test, what appeared, where, how many, how it moved, how long it lasted, FPS,
verbatim errors (feed and bridge status), screenshots.

---

## Part 6. What to send me

### After smoke (parts 2–3)

1. The effect's **InstanceID**.
2. The files **`EngineSmoke.xml` and `EngineSmoke_edition.xml`** (the effect) and the `.vfxlib` from your project; we will return them to
   `bridge/msfs/package/PackageSources/VisualEffectLibs/ACARS/`.
3. **All files you had to change** to get the package to build: `aircraft.cfg`, `model.cfg`,
   `ACARS_Smoke.xml`, glTF, and which asset group type you chose.
4. The checklist from step 3.6 with answers.
5. The results of step 3.7.
6. Verbatim build and SimConnect errors, if any.
7. Screenshots: smoke from afar (20–30 NM) and up close; FPS before and after.

### To start T54 (part 4)

1. The table of names from step 4.1: exact `title` → present / absent → what it looks like.
2. The ambulance name or "none" (step 4.2).
3. The MSFS 2020 result or "no 2020" (step 4.3).
4. The category table option: a (with a file), b or c (step 4.4).

### After T54 (part 5)

The results of tests A–F in the format from 5.2.

---

## Appendix. Common problems

| Symptom | Cause | Where to look |
|---|---|---|
| `SimConnect support OFF` in the bridge build output | SDK not found | step 1.3, `-p:MsfsSdk=…` or `Local.props` |
| Bridge status `fake` | the bridge was started with `--source fake` | start without the flag |
| Bridge status `disconnected` | MSFS is still loading the flight or is closed | wait, the bridge reconnects by itself |
| The fire scenario does not start | a condition is not met | a line in the feed; the table in 3.1 |
| `no coordinates for … RWY …` | no live data or the runway is not in OurAirports | step 1.5; write down the airport |
| `ACARS Smoke` is not in Aircraft Selector / Spawner | the package is not in Community, not built, or has the wrong group type | steps 2.7–2.9 |
| `CREATE_OBJECT_FAILED` in the bridge status | MSFS did not find an object with `title = "ACARS Smoke"` | steps 2.8–2.9 |
| Object created, no errors, no smoke | wrong `FX_GUID` or no `ASOBO_GT_FX` template | step 2.6.3; Template/Instance Debugger (View menu of the Visual Effects Editor window) |
| Smoke underground or in the air | how MSFS computes altitude at `OnGround = 1` **[?]** | write down at what altitude it stands |
| Smoke is vertical in strong wind | the effect has no `WindDirection` | step 2.3 |
| Smoke leans against the wind | the wind vector is not reversed | step 2.4 |
| MSFS crashes when stopping an effect in the Template/Instance Debugger | noticed 2026-10-15 (MSFS 1.9.18, graphics mods disabled, error 0xC0000005 in `FlightSimulator2024.exe` itself) **[?]** | do not stop the effect, end the flight instead; during check 3.7 write down whether MSFS crashes when the bridge removes the smoke |
| FPS drops sharply | too many particles in the effect | reduce the particle count, increase their size |
| A vehicle does not appear (after T54) | wrong `title` | step 4.1, Virtual File System → `title` |

---

## Sources

MSFS 2024 SDK documentation, verified 2026-10-15:

- [The Visual Effects Editor](https://docs.flightsimulator.com/msfs2024/retail/devmode/editors/vfx-editor/the-visual-effects-editor/)
- [SimpleFX sample](https://docs.flightsimulator.com/msfs2024/retail/samples-tutorials/samples/misc/simplefx/)
- [WindDirection node](https://docs.flightsimulator.com/msfs2024/retail/devmode/editors/vfx-editor/nodes/winddirection/)
- [Visual Effects](https://docs.flightsimulator.com/msfs2024/retail/content-configuration/visualeffects/visual-effects/)
- [DevMode: Tools menu](https://docs.flightsimulator.com/msfs2024/html/2_DevMode/Menus/Tools.htm)
- [SimObject Spawner](https://docs.flightsimulator.com/msfs2024/html/2_DevMode/Menus/Tools/SimObject_Spawner.htm)

In the repository: `bridge/msfs/package/GUIDE.md` (the same for smoke, original version), `bridge/msfs/package/README.md`,
`bridge/msfs/README.md`, cards T34 and T54 in `docs/07-roadmap-tasks.md`.
