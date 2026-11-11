# How to build the smoke package for the installer (T104)

A guide for a person with MSFS 2024 and the SDK. The result is the `avail-acars-smoke` folder, which the app installs into Community
with the "Install" button (Advanced settings → "Smoke package for MSFS 2024").

How it differs from [guide-smoke-rescue.md](guide-smoke-rescue.md), part 2: there the effect was made **from a copy
of the SimpleFX sample**. You can keep such a package for yourself, but you cannot distribute it: the SDK license (`D:\MSFS 2024
SDK\Licenses\MSFS SDK EULA.pdf`, item 1 b) allows SDK samples for internal use only. Here everything
is done **from scratch**: a new project, a new effect, our own texture from the repository. Nothing from the `Samples` folder is
copied — neither files nor graph nodes. A new effect from the wizard gets its own GUIDs right away, so the T34 problem
(smoke did not appear from Community because of the sample's GUIDs) does not occur here.

The mark **[?]** is a step that is not in the SDK documentation or has not yet been checked on this setup. If something
goes wrong on it, write down verbatim what the simulator said and send it.

Sources: the MSFS 2024 SDK pages [The Visual Effects Editor](https://docs.flightsimulator.com/msfs2024/retail/devmode/editors/vfx-editor/the-visual-effects-editor/index.md),
[Output](https://docs.flightsimulator.com/msfs2024/retail/devmode/editors/vfx-editor/nodes/output/index.md),
[The Material Editor](https://docs.flightsimulator.com/msfs2024/retail/devmode/editors/material-editor/the-material-editor/index.md)
(checked 2026-11-05); the asset group types are from your working T34 project `D:\msfs-projects\acars-smoke\acars-smoke\SimpleFX` (checked
in the simulator 2026-10-17).

---

## 0. Before you start

1. MSFS 2024 with **Developer Mode** on (Options → General Options → Developers).
2. **Start any flight.** The DevMode editors do not work from the main menu.
3. **Remove the old packages from Community.** Move (do not delete) `D:\MSFS2024\Community\mycompany-simple-fx`
   and `mycompany-simplefx-materiallib` somewhere outside Community, for example `D:\msfs-projects\old-community\`.
   The old package also has an object titled `ACARS Smoke`: if you leave both, it is unknown which one
   the bridge will create, and the check will show nothing. Restart MSFS.
4. Open the old project `D:\msfs-projects\acars-smoke\acars-smoke\SimpleFX` alongside **only to compare numbers** (section 4).
   You must not copy nodes, effect files, or the material from it.

## 1. New project

1. DevMode → **File → New Project** **[?]** (the VFX Editor page only says "create or open a project
   in the Project Editor"; if the item is named differently, choose project creation).
2. Folder: `D:\msfs-projects\acars-smoke` (outside the repository), project file `acars-smoke.xml`.
3. The **Add Package** window will open (for a new project it opens by itself; otherwise use the **Add Package** button at the bottom of the
   Project Editor).

## 2. Package and effect

1. In **Add Package** choose **Visual Effect**.
2. Package name: **`acars-smoke`** → **Create**. The Project Editor itself adds the default company to it
   (the Default company name field) — the result is **`avail-acars-smoke`**. That is what is needed: the app looks in Community
   for a folder with this name. Do not rename the package.
3. The **Visual Effects Wizard** will open. The effect name is anything, for example `acars-smoke` (the object finds the effect
   by InstanceId, not by name). **Create Visual Effect**.
   The Visual Effects Editor will open with the starter nodes.
4. Project Editor → menu **Project → Save**.
5. Check the effect path: in the Project Editor expand the package → the **VisualEffectsLib** group → the **Asset
   Directory** field. It must have **two levels** after `VisualEffectLibs`: `PackageSources\VisualEffectLibs\<company>\<group>\`.
   The simulator does not find an effect with one level from Community (Asobo, DevSupport, topic 15309). If there is
   one level, send what it says there.

## 3. Material with our own texture

1. Project Editor → select the `avail-acars-smoke` package → at the bottom the Project Inspector, in the Asset groups section — **Add
   Asset Group**.
2. In the Package Wizard: **Custom** → **Next**. Name: `acars-smoke-materiallib`, type **MaterialLib** → **Create**.
3. In the Project Inspector find **AssetDir** of the material group → **Show In Explorer**. Create a `Textures` folder
   there and copy into it the file from the repository:
   `bridge\msfs\package\PackageSources\MaterialLibs\acars-smoke-materiallib\Textures\acars_smoke.png`
   (512×512, made by the `tools/smoke-texture` script, our own work — it may be distributed).
   The result must be exactly this: `D:\msfs-projectscars-smoke\PackageSources\MaterialLibscars-smoke-materiallib\Texturescars_smoke.png`
   — `Textures` **inside** the group folder, next to the `.material` file. If you put `Textures` one level up
   (`MaterialLibs\Textures`), Load Texture gives "is not relative to the package source dir".
4. The **Material Editor** will open. If not, select the `acars-smoke-materiallib` group in the Project Editor → in the Project
   Inspector **Load in Editor** (as for the effect group).
5. Material Editor → **File → New**. A choice of **context** (where the material will be used) will appear —
   choose **VFX Editor**. The **Material Inspector** will open.
6. In the Material Inspector, from top to bottom:

   **Material Data**

   | Field | Value |
   |---|---|
   | Context | `VFX Editor` (already chosen) |
   | Information | should show the `avail-acars-smoke` package / the `acars-smoke-materiallib` group — check that the material ends up in our package |
   | Name | `AcarsSmoke` |
   | Tag | do not touch |
   | Type | `CODE_DIFFUSE` |

   **Textures** — hover over the first texture slot (Albedo / Diffuse) → the **Load Texture** button appears →
   choose `Textures\acars_smoke.png` from step 3. The other slots stay empty.

   **Extra Settings → VFX Settings**

   | Field | Value | Why |
   |---|---|---|
   | UV Offset / UV Scale / UV Rotation | `0` / `1` / `0` (default) | |
   | Opacity | `1` | transparency is set by the texture and the effect |
   | Metalness, Roughness | `0` | |
   | Diffuse Colour | white | the smoke colour is set by the effect |
   | Emissive Colour | black | otherwise the smoke glows at night |
   | **Blend Mode** | **`Alpha Blend`** | the texture has ordinary (non-premultiplied) transparency; `Additive` gives glowing smoke, `Opaque` — squares |
   | Two-Sided, Flip Backface | default | |

7. At the bottom of the Material Inspector — **Save**. The material appears in the Material Editor list.
8. Check: Material Editor → menu **Debug → Diagnostics**. The console must show no errors about
   `acars_smoke.png` (file not found, not a power of two).

> **[?] Material in the same package.** In the SDK sample the material is in a separate package, while the app installs
> only one folder, `avail-acars-smoke`. The documentation does not say whether the split is mandatory. If the build
> complains about the material, or in the simulator there is smoke but with a different texture (section 7), write: then I
> will teach the app to install a second package.

## 4. Effect graph

### 4.1. How to work with the graph

- Open the effect: Project Editor → the `VisualEffectLib` group → Project Inspector → **Load in Editor**, then
  click the effect in the Visual Effects Editor list. The graph is in the **Node Graph** window.
- **New node:** right-click on an empty spot in the Node Graph → search by name (or drag from the **Node List** window).
- **Node fields:** select the node — its fields are in the **Inspector** (a VFX editor window; if it is closed — the **View** menu).
- **Link:** drag with the mouse from the node output (the dot on the right, `OutputValue`) to the circle to the left of another node's field.
  A connected field takes its value from the link; the number in the field is ignored.
- **Curve** (the **GetBezierCurve** node): the `FXTime` input is time, the `Curve` field is the points. Below, points are written
  as `(x; y)`, where x is the fraction of the particle's life from 0 to 1 and y is the value. Place the points in the curve editor in the
  node Inspector **[?]** (how to add a point — send a screenshot of the Inspector if it does not work out).
- Save often: Visual Effects Editor → **File → Save**.

Below is your T34 effect (the smoke was checked at LEBL 2026-10-16), broken down by node. These are our numbers; place
new nodes, do not copy them from the old project.

### 4.2. Block chain

The wizard has already created **VisualEffect → Emitter**. If **Init**, **Update** and **Output** are missing, add them and
connect them from top to bottom: Emitter → Init → Update → Output.

**Emitter**

| Field | Value |
|---|---|
| `Rate` | `8` |
| `Capacity` | `800` |
| `MaxDistanceEmission` | `80000` |
| the rest | default (not changed in T34) |

**Init**

| Field | Value |
|---|---|
| `Lifetime` | `90` |
| `Size` | `9` |
| `Velocity` | `0, 0, 0` (the velocity is in Update) |

### 4.3. Shared nodes

Their outputs are needed by many nodes below. Place them to the left of the graph:

| Node | Field | Value | Called below |
|---|---|---|---|
| **GetParticleAttribute** | `ParticleAttributeType` | `AgeOverLifetime` | **Age** (0 → 1 over the particle's life) |
| **GetParticleAttribute** | `ParticleAttributeType` | `id` | **Number** (so that a particle's random number does not change every frame) |

For each **RandomValue** below: the `RandIndex` input ← **Number**; `RandSeed` is different for each (the numbers are in the tables).

### 4.4. Particle size → Update `Size`

`Size = (Curve A × 90 + 9) × random 0.75…1.25` — the puff grows from 9 to ~100 m over its life.

| No. | Node | Inputs |
|---|---|---|
| 1 | **GetBezierCurve** "Curve A" | `FXTime` ← Age; `Curve`: (0; 0), (0.1; 0.12), (0.3; 0.3), (0.6; 0.65), (1; 1) |
| 2 | **Float** | `x = 90` |
| 3 | **Multiply** | `x` ← node 1, `y` ← node 2 |
| 4 | **Float** | `x = 9` |
| 5 | **Add** | `x` ← node 3, `y` ← node 4 |
| 6 | **RandomValue** | `Min 0.75`, `Max 1.25`, `RandSeed 2048` |
| 7 | **Multiply** | `x` ← node 5, `y` ← node 6 → output to **Update `Size`** |

### 4.5. Velocity → Update `Velocity`

`Velocity = spread + lift + wind` — three branches, then two **Add** nodes.

**"Spread" branch** — the puffs spread sideways, more strongly toward the end of life:

| No. | Node | Inputs |
|---|---|---|
| 1 | **RandomValue** | `Min −0.9`, `Max 0.9`, `RandSeed 512` |
| 2 | **RandomValue** | `Min −0.9`, `Max 0.9`, `RandSeed 1024` |
| 3 | **LocalDirection** | `x` ← node 1, `z` ← node 2 (`y` empty) |
| 4 | **GetBezierCurve** "Curve B" | `FXTime` ← Age; `Curve`: (0; 0.3), (0.3; 1), (0.6; 3), (1; 5) |
| 5 | **Vector3** | `x`, `y`, `z` ← all three from node 4 |
| 6 | **Multiply** | `x` ← node 3, `y` ← node 5 |

**"Lift" branch** — fast upward at the start, slower later:

| No. | Node | Inputs |
|---|---|---|
| 7 | **GetBezierCurve** "Curve C" | `FXTime` ← Age; `Curve`: (0; 1), (0.1; 0.7), (0.25; 0.5), (0.5; 0.35), (1; 0.25) |
| 8 | **Float** | `x = −16` |
| 9 | **Multiply** | `x` ← node 7, `y` ← node 8 |
| 10 | **RandomValue** | `Min 0.75`, `Max 1.25`, `RandSeed 8192` |
| 11 | **Multiply** | `x` ← node 9, `y` ← node 10 |
| 12 | **GravityVector** | `GravityScale` ← node 11 (minus means upward) |

**"Wind" branch:**

| No. | Node | Inputs |
|---|---|---|
| 13 | **WindDirection** | fields default (not changed in T34) |
| 14 | **Vector3** | `x = y = z = 0.305` (feet → metres; do **not** enter 0.305 as a number in Multiply — only one axis would be multiplied) |
| 15 | **Multiply** | `x` ← node 13, `y` ← node 14 |
| 16 | **GetBezierCurve** "Curve D" | `FXTime` ← Age; `Curve`: (0; 0.15), (0.2; 0.4), (0.5; 0.8), (1; 1) |
| 17 | **Vector3** | `x`, `y`, `z` ← all three from node 16 |
| 18 | **Multiply** | `x` ← node 15, `y` ← node 17 |

**Add up:**

| No. | Node | Inputs |
|---|---|---|
| 19 | **Add** | `x` ← node 6 (spread), `y` ← node 12 (lift) |
| 20 | **Add** | `x` ← node 19, `y` ← node 18 (wind) → output to **Update `Velocity`** |

### 4.6. Colour and transparency → Output

1. Select **Output** → in the Inspector click **Color (RGBA) (+)**. Output gets a colour input.
2. Nodes:

| No. | Node | Inputs |
|---|---|---|
| 1 | **GetBezierCurve** "Curve E" (darkness) | `FXTime` ← Age; `Curve`: (0; 0.02), (0.25; 0.045), (0.6; 0.08), (1; 0.11) — almost black, lightening toward the end |
| 2 | **RandomValue** | `Min 0.7`, `Max 1.2`, `RandSeed 4096` |
| 3 | **Multiply** | `x` ← node 1, `y` ← node 2 |
| 4 | **GetBezierCurve** "Curve F" (transparency) | `FXTime` ← Age; `Curve`: (0; 0), (0.02; 0.9), (0.5; 0.85), (0.85; 0.6), (1; 0) — appears quickly, fades smoothly |
| 5 | **Vector4** | `x`, `y`, `z` ← node 3; `w` ← node 4 → output to the **Output colour input** |

3. **Material.** In the Inspector of the Output node, the **Material** section has a button with the name of the current material (or
   empty). Open the Material Editor alongside and **drag** `AcarsSmoke` from the material list onto this button.
   The button should now read `AcarsSmoke`.

   > The XML of the old effect has no material reference: it was most likely drawn with the default Asobo material,
   > not the SimpleFX texture. So the new smoke may look different — that is what we check in section 7.

### 4.7. Check in place and save

1. Visual Effects Editor → **File → Save**, Project Editor → **Project → Save**.
2. Visual Effects Editor → **View → Template/Instance Debugger** → the **Spawner** tab → your aircraft →
   any Contact Point → **Spawn**. A dark column with soft puffs (not squares) should rise from the aircraft.
3. If something is wrong — a screenshot of the graph and the Inspector of the selected node.

## 5. The ACARS Smoke object

1. **The effect's InstanceId.** Open in a text editor the effect XML (AssetDir from step 2.5):
   `D:\msfs-projects\acars-smoke\PackageSources\VisualEffectLibs\acars-smoke\VisualEffectLib\acars-smoke.xml`
   (not the `…_edition.xml` file). Find the line `<VisualEffect.VisualEffect InstanceId="{…}">` — there is only one.
   Copy the value entirely, with the curly braces.
2. Copy from the repository the folder
   `bridge\msfs\package\PackageSources\SimObjects\Landmarks\ACARS_Smoke`
   into the project: `D:\msfs-projects\acars-smoke\PackageSources\SimObjects\Landmarks\ACARS_Smoke`.
   Do **not** copy the `bridge\msfs\package\PackageSources\VisualEffectLibs` folder.
3. In the **copied** `model\ACARS_Smoke.xml` replace the zeros in `<FX_GUID>` with the InstanceId from item 1.
4. `sim.cfg`: the line `title=ACARS Smoke` — **do not change it**, this is the title the bridge looks for.
5. Project Editor → click the `avail-acars-smoke` package → Project Inspector → **Add Asset Group** → Package
   Wizard: **Custom** → **Next** → name `ACARS_Smoke`, type **SimObject** → **Create** (the type is as in your
   T34 project, where it works).
6. Select the new `ACARS_Smoke` group → in the Project Inspector check the paths (as for the effect group in step 2.5):

   | Field | Value |
   |---|---|
   | Asset Group Type | `SimObject` |
   | AssetDir | `PackageSources\SimObjects\Landmarks\ACARS_Smoke\` |
   | OutputDir | `SimObjects\Landmarks\ACARS_Smoke\` |

   If the wizard set different paths, enter these (or choose the folder with the folder button to the right of the field).
7. Project Editor → **Project → Save**.

## 6. Package properties and build

1. Project Editor → select the `avail-acars-smoke` package → Project Inspector, the package properties (the exact field
   labels are not described in the documentation **[?]** — look for similar ones):

   | Field | Value |
   |---|---|
   | Title | `ACARS Smoke` |
   | Creator | `avail` (as the Default creator name; `AVAILOFF` is also fine) |
   | package version (Version) | `1.0.0` |

   Project Editor → **Project → Save**.

   **Do not change the Title in later versions.** The app uses it to tell our package from someone else's folder with the same
   name. **Raise** the version on every new build — otherwise "Update" will not appear.
2. **Build All in project** (the button at the top of the Project Editor). Progress and errors are in the Console window (DevMode → Debug → Console **[?]**); there must be no red errors, and the package loses its `Outdated` mark.
3. The result is `D:\msfs-projects\acars-smoke\Packages\avail-acars-smoke\`. Open `manifest.json` in it:
   it must have `"title": "ACARS Smoke"` and `"package_version": "1.0.0"`. Without them the app will not see the package.

## 7. Check through the app

1. Copy `Packages\avail-acars-smoke` into the repository: `bridge\msfs\package\dist\avail-acars-smoke`.
2. **Close MSFS.** `pnpm desktop:dev` → Advanced settings → "Smoke package for MSFS 2024":
   "MSFS 2024 (Steam): not installed", the **Install** button is active. Press it — "Done — restart MSFS",
   the package appeared in `D:\MSFS2024\Community\avail-acars-smoke`.
3. Start MSFS, begin a flight. DevMode → **Tools → SimObject Spawner** → the **Packages** filter = `avail-acars-smoke`
   → `ACARS Smoke` in the list → **Spawn**. Smoke should rise.
4. Full check: LEBL, at the stand, the app connected, Scenarios → `dep_fire` → "Run now".
   After ~1 min — a column of smoke by runway 24L, on the side stated in the telex.
5. What to look at:
   - **texture:** the puffs are soft, without square particle edges;
   - **height and density:** like the old smoke (if worse — send a screenshot and we will tune the numbers);
   - **wind:** set a 15-25 knot wind in the weather; the smoke should drift **downwind** (a west wind — smoke to the
     east). If the column is vertical, write it down; we will deal with the wind separately;
   - **FPS:** whether it drops noticeably near the smoke.
6. Check "Remove": MSFS closed → "Remove" → there is no `avail-acars-smoke` folder in Community.

## 8. What to send

- whether everything went through, and on which **[?]** steps you had to do it differently (verbatim, what you chose);
- a screenshot of the smoke from far away and up close.

After that I will commit `bridge/msfs/package/dist/avail-acars-smoke` (the built package; also the project sources:
`D:\msfs-projects\acars-smoke` without `_PackageInt`, `Packages` and the old `acars-smoke\SimpleFX` subfolder), and it will go into the installer.
