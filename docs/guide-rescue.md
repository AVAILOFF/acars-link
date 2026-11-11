# Rescue services in the simulator: how to add them

A step-by-step guide for task **T54**: in an emergency, the landing airport meets the aircraft with fire trucks
and an ambulance. It describes what **you** need to do (only you can check this in MSFS), what I will do afterwards,
and how to verify the result. It also describes how to add your own vehicles later, for example from an add-on.

Status as of 2026-10-17: the vehicles are found (part 2), the rules are chosen (part 3), what remains is to start T54 (part 4).
The card is T54 in `docs/07-roadmap-tasks.md`; the decisions and assumptions are recorded there.
This guide replaces parts 4-5 of `docs/guide-smoke-rescue.md`.

The mark **[?]** means the SDK documentation does not cover this, or nobody has verified it. Write down what you
actually saw. That is the result.

---

## Contents

- [Part 0. How it will work](#part-0-how-it-will-work)
- [Part 1. What is already done](#part-1-what-is-already-done)
- [Part 2. Vehicles in MSFS: found](#part-2-vehicles-in-msfs-found)
- [Part 3. Which vehicles and how many: decided](#part-3-which-vehicles-and-how-many-decided)
- [Part 4. Start the task](#part-4-start-the-task)
- [Part 5. Verification after implementation](#part-5-verification-after-implementation)
- [Part 6. How to add your own vehicle later](#part-6-how-to-add-your-own-vehicle-later)
- [Appendix. Common problems](#appendix-common-problems)

---

## Part 0. How it will work

```
scenario: MAYDAY / PAN / cabin fire / medical
   │  step "rescue: full | standby | medical"
   ▼
core: landing airport (diversion, otherwise the OFP destination) + level
   ▼
app (controller.ts)
   │  landing runway threshold and heading from OurAirports (planned runway from the OFP, otherwise the longest)
   │  number of vehicles by aircraft + object titles from the settings
   │  rescue_start {level, rwy, count, titles}
   ▼
bridge (RescueController, ws://127.0.0.1:47830)
   ≤ 15 NM  → vehicles appear 150 m from the runway centreline on the upwind side, from 400 m to the far end
   touchdown → they follow the aircraft, 25 m behind (full only)
   stop     → they surround the aircraft in a circle of 50 m radius
   +10 min  → they disappear; farther than 30 NM (go-around) — also
   ▼
MSFS: standard vehicles (SimObject objects) created via AICreateSimulatedObject
```

Which scenarios trigger what (approved 2026-10-15):

| Scenario | Level | What happens |
|---|---|---|
| `emergency_mayday`, `ped_fire_cabin` | `full` | vehicles wait by the runway, follow the aircraft, surround it |
| `emergency_pan` | `standby` | vehicles stand by the runway and do not move |
| `medical_onboard`, the `MEDICAL` command | `medical` | ambulance at the stand after on-block |
| PAN, then MAYDAY | higher level | `standby` → `full` |

The main point: **you do not need to make your own package for the vehicles**, unlike the smoke. The bridge creates
objects already installed in MSFS by their **title**. If there is no title or the object cannot be created, the
vehicles will not appear. So your main work is part 2.

---

## Part 1. What is already done

Nothing is needed from you here; this is for understanding.

| What | Status |
|---|---|
| Bridge with SimConnect, Developer Mode, SDK | set up for the smoke (`guide-smoke-rescue.md`, part 1) |
| Object creation by the bridge | works: the `ACARS Smoke` smoke is created with a plain `AICreateSimulatedObject`, checked by a human 2026-10-16/17 (LEBL) |
| Landing runway from the OFP | the SimBrief field `destination.plan_rwy` exists, the core parses it (`planRwy`) |
| Route for moving vehicles | the `SIMCONNECT_DATA_WAYPOINT` structure exists in your SimConnect wrapper (`SimConnectLibs/sdk2024`) |
| MAYDAY / PAN / medical scenarios | exist; the messages already say "RESCUE AND FIRE SERVICES ALERTED", but there are no vehicles yet |
| T54 code (`rescue`, `RescueController`, settings) | written 2026-10-17 (branch `task/T54-rescue`), awaiting verification (part 5) |

What we learned from the smoke that matters for the vehicles:

1. **An object in the SimObject Spawner list does not mean it can be created.** The first smoke variant (`aircraft.cfg`)
   was in the list but did not appear. So the vehicles must be **spawned**, not just found in the list.
2. **A plain `AICreateSimulatedObject` works only with non-modular objects** (SDK). There is no `_EX1` variant in your
   wrapper. If a vehicle in MSFS 2024 is modular, the bridge will not create it **[?]**.
3. The first smoke object of a session was created without the effect, so the bridge re-creates it after 15 s. The vehicles
   have no effect, so this is most likely not needed **[?]**. We will check in part 5 (the emergency lights).

---

## Part 2. Vehicles in MSFS: found

Checked by you on 2026-10-17 in MSFS 2024 (DevMode → Tools → SimObject Spawner, filter "All packages", search for
`fire`, `medic`, `pickup`). All objects below are created with the **Spawn** button and stand on the ground.

### 2.1. Fire trucks

| title | What it is |
|---|---|
| `ASO_Firetruck02` | airport, white, 4 axles |
| `Truck Fire Airport Medium` | airport, light green |
| `Microsoft_Truck_Fire_Medium_Red` | airport, red, animated; **drives backwards** (checked 2026-10-17), removed from the default lists |
| `FSDT_Firetruck_Panther_6x6_red` | Rosenbauer Panther from GSX (add-on), animated |
| `Truck Fire Long 02` | municipal with a ladder (US) |
| `Microsoft_Truck_Fire_Long` | municipal with a ladder, animated |
| `Truck Fire Short` | municipal, European |
| `Car Bush Firefighting` | SUV (not used: there is no incident commander vehicle) |

`SUV_NorthAm` from the ERoD mod settings does not exist in MSFS 2024. `Truck Fire Short 02` is not confirmed.

### 2.2. Ambulances

| title | What it is |
|---|---|
| `Car Bush Medic` | SUV |
| `Truck Utility Europe Medic Box` | European van with a box body |
| `Truck Utility Europe Medic Flush` | European van |
| `Truck Utility NorthAm Medic` | American, box body |
| `Van Asia High Roof Medic` | Asian high-roof van |
| `Van Asia High Roof Medic Japan` | Japanese |
| `Van Asia Low Roof Medic` | Asian low-roof van (found in the list, did not spawn) |

### 2.3. Parentheses in titles are liveries

The Spawner list has rows like `Pickup 01 (FIREFIGHT_01)`. The parentheses are a **livery**, not part of the `title`:
`Pickup 01` has one container and six paint schemes (`AERIALAD_02`, `FIREFIGHT_01`, `TRAFFIC_DEFAULT`, and others). This is how
**modular** objects look in MSFS 2024.

A livery can only be passed to `AICreateSimulatedObject_EX1` (parameter `szLivery`, SDK 2024). Our SimConnect wrapper
does not have this function, so the bridge creates the vehicle by the title **without parentheses**, with the default livery.
All vehicles in the tables above look right without parentheses. Not suitable:
- `Pickup 01` — without parentheses it is a utility vehicle, blue-red, not a fire vehicle;
- the yellow livery of `ASO_Firetruck02` — without `_EX1` it stays white.

Whether a plain `AICreateSimulatedObject` creates modular vehicles will be checked in part 5 **[?]**. The ERoD mod creates
`ASO_Firetruck02` with the same call, so most likely yes. If not, the official SimConnect wrapper
with `_EX1` is needed (task T19).

You do not have MSFS 2020: the T54 report will say "not checked in 2020".

---

## Part 3. Which vehicles and how many: decided

All the rules below are **game** rules (user decisions of 2026-10-17), not ICAO standards or data on real
airport services. They are recorded in the T54 card.

**How many fire trucks** — by aircraft category:

| Category | Aircraft | Fire trucks |
|---|---|---|
| 1-5 | small, regional (E170/E175, CRJ, ATR, DH8 up to Q400), a type not in the table | 1 |
| 6-7 | A320, B737, E190, E195, DH8D | 4 |
| 8-10 | A330, B777, A350, A380 | 8 |

There is no incident commander vehicle.

A runway without a planned one (diversion) — the longest; landing into the wind from the airport METAR, with no wind — on the `le` end
(user decisions of 2026-10-17, recorded in the card).

**Which fire trucks** — by landing airport. A large airport is `type = large_airport` in OurAirports
(`airports.csv`); the region is by the first letters of the ICAO code.

| Airport | Fire trucks |
|---|---|
| large, North America (`K`, `C`) | `Truck Fire Airport Medium` |
| large, other regions | `ASO_Firetruck02`, `Truck Fire Airport Medium` |
| not large, North America | `Truck Fire Long 02`, `Microsoft_Truck_Fire_Long` |
| not large, other regions | `Truck Fire Short` |

**Which ambulance** — by region:

| Region (ICAO) | Ambulance |
|---|---|
| Japan (`RJ`, `RO`) | `Van Asia High Roof Medic Japan` |
| rest of Asia (`R`, `V`, `W`, `Z`) | `Van Asia High Roof Medic`, `Van Asia Low Roof Medic` |
| North America (`K`, `C`) | `Truck Utility NorthAm Medic` |
| Europe (`E`, `L`) and the rest | `Truck Utility Europe Medic Box`, `Truck Utility Europe Medic Flush` |

If a model group has fewer models than there are vehicles, they alternate in a cycle. All groups can be edited in the
settings. `FSDT_Firetruck_Panther_6x6_red` (GSX) is not included by default; it can be added manually.

---

## Part 4. Start the task

Everything needed from you before the start has been collected. Begin a **new session** and write:

> Do T54.

The vehicle titles and rules are already in the card. What I will do from it:

1. **Core and scenarios.** The steps `rescue: { level: full | standby | medical }` and `rescue: stop`; hooking them up to the
   scenarios in the table of part 0; the higher level on PAN → MAYDAY; recording in the replay (like `smoke`).
2. **App.** The landing runway threshold and heading (OurAirports, planned from the OFP, otherwise the longest; for a diversion —
   the diversion airport), the `rescue_start` command to the bridge, the number and models of vehicles per part 3, settings:
   - "Rescue services in the simulator" — on/off;
   - groups of object titles (fire trucks and ambulances per airport) — editable;
3. **Bridge.** `RescueController` (logic without SimConnect, under tests, like `SmokeController`) and the commands
   `rescue_start` / `rescue_stop` on the allowlist.
4. `pnpm check`, `pnpm bridge:test`, a report with a "Human check" section.

The branch is `task/T54-rescue`. Commit after green checks; push and merge only at your request.

---

## Part 5. Verification after implementation

**Conditions:** MSFS 2024, FBW A32NX (or any A320), a SimBrief flight with an arrival runway, the bridge built with SimConnect
(`pnpm bridge:build -p:MsfsSdk=…`), live data and the XATC ATC station on, the "Rescue services in the simulator"
setting on.

**Test A — MAYDAY (full).**
1. Log on to XATC (`X` + FIR code), MAYDAY in cruise, answer `CONTINUE` to the question.
2. At **15 NM** the fire trucks appear at the landing runway threshold — four for an A320, models by
   airport (part 3) — beside the runway, about 45 m from the centreline. The paint is the default, as in the Spawner without parentheses.
3. After **touchdown** the vehicles follow the aircraft, about 25 m behind.
4. After **stopping** (under 1 knot for more than 2 s) they surround the aircraft in a circle of about 50 m radius.
5. **10 minutes** after stopping they disappear.
6. FPS — before 15 NM and with the vehicles.
7. Right after appearing the vehicles **stand** and do not roll (before the 2026-10-17 fix they slowly drove away on their own).
   Write down which way each model faces: toward the runway or away from it.
8. On the circle the vehicles stop and stand until they disappear.
9. In the bridge console — lines `rescue slot N <title> hdg asked X, sim Y`: copy them out (this shows whether each model holds its heading).
10. After touchdown the vehicles drive **forwards**; to a point on the other side of the aircraft — **around it**, not through the aircraft.

**Test B — PAN (standby).** The same with PAN: the vehicles stand by the runway and **do not move**.

**Test C — go-around.** MAYDAY, vehicles appeared → go-around farther than 30 NM → they disappear.
Closer than 15 NM again → they appear.

**Test D — MEDICAL.** The `MEDICAL` command in flight, landing, on-block. The ambulance is at the stand, the model by region (part 3).
For example, in Europe — `Truck Utility Europe Medic Box` or `Flush`, in Japan — `Van Asia High Roof Medic Japan`.

**Test D2 — region and airport size.** Test A at a large US airport (for example, KJFK) — light green
`Truck Fire Airport Medium`; at a small European one — `Truck Fire Short`.

**Test E — another runway.** MAYDAY, landing on a runway other than the planned one. The vehicles stand at the planned one, and after touchdown drive to the
stopping place in a straight line.

**Test F — new session.** The vehicles stand → go to the MSFS menu and load the flight again (the request is still active) →
the vehicles are created again.

**This is normal** (approved simplifications, not errors):
- the vehicles drive **in a straight line**, across grass and through buildings, not along taxiways;
- the vehicles stand by the runway **in advance** rather than driving out from a depot;
- 15 / 30 NM and 10 minutes are game numbers.

**What to write down:** for each test — what appeared, where, how many, how it moved, how long it lasted, whether there are
emergency lights, FPS, verbatim errors (the feed and the bridge status), screenshots.

---

## Part 6. How to add your own vehicle later

Works **after T54**: the vehicle titles will be in the app settings.

1. **Install the add-on** with the vehicle into `Community` (or find the object in the stock packages).
2. **Find the title:** DevMode → Tools → SimObject Spawner → "All packages" → the second drop-down list, search
   by part of the name. You need a row **without parentheses**: parentheses mean a livery (part 2.3).
3. **Spawn the row without parentheses** and look at the paint. This is exactly how the vehicle will appear at the runway: our bridge
   cannot choose a livery. If it did not appear or the paint is wrong, the vehicle is not suitable.
4. If the title is truncated in the Spawner, you can read it from the file: Tools → Virtual File System → **Browse**
   (filter **Files**, **Recursive**, search by name) — the path to `sim.cfg` / `aircraft.cfg`; open the file
   through **VFS Projector** (Start → Open Explorer → `VFSProjection`), the line `title = …`. Files with a lock 🔒
   cannot be opened. For an add-on in Community the file is simply on disk.
5. **Enter the `title`** in the app settings: "Rescue services" → the list of fire trucks or ambulances. Exactly,
   with case and spaces. The order in the list is the order of vehicles: the first model is the vehicle closest
   to the threshold (and first in the column), then in a cycle. For the ambulance the first model of the group is taken.
6. **Check which way the nose points** right after appearing at the runway: the vehicles should stand facing the runway. Some
   MSFS 2024 models are drawn nose against their heading (checked 2026-10-17: `Truck Fire Airport Medium`,
   `Microsoft_Truck_Fire_Medium_Red`; `ASO_Firetruck02` — correct). If your model stands with its back to the runway, enter its
   title in the "Reversed models" setting — the bridge will turn it 180°.
7. **Check** with test A from part 5. If it did not appear, the feed will have a line with the title and the error; the other
   vehicles work.

License: each user installs the add-on with the vehicle themselves; we do not distribute it. Only the titles of stock MSFS objects go into
the repository and the default settings.

---

## Appendix. Common problems

| Symptom | Cause | What to do |
|---|---|---|
| The vehicle is in the Spawner list but does not appear after Spawn | the container is not created (as with the first smoke) or the object is modular | write down the path and `category`; look for another model |
| The vehicle is underground or in the air | how MSFS sets the altitude with `OnGround = 1` **[?]** | write down at what altitude it stands |
| The vehicle does not appear (after T54) | wrong `title` | Virtual File System → `title`, fix it in the settings |
| No vehicle, bridge status `CREATE_OBJECT_FAILED` | MSFS did not find an object with this `title` | the same |
| Bridge status `SimConnect support OFF` | the bridge was built without the SDK | `pnpm bridge:build -p:MsfsSdk="C:\MSFS 2024 SDK"` |
| Vehicles did not appear at 15 NM | no runway coordinates (live data off or the runway is not in OurAirports) | a line in the feed; turn on live data |
| Vehicles stand but do not move after touchdown on MAYDAY | level `standby` (PAN) or the `AI WAYPOINT LIST` route does not work **[?]** | check the level in the feed; write it down |
| Vehicles move but lag or jerk | the route is updated every 350 ms, the vehicle has its own speed | write down how far they lag |
| FPS drops a lot | many vehicles | write down the FPS; shorten the list in the settings |

---

## Sources

- The T54 and T34 cards in `docs/07-roadmap-tasks.md` (user decisions 2026-10-15…17).
- [SimObject Spawner](https://docs.flightsimulator.com/msfs2024/html/2_DevMode/Menus/Tools/SimObject_Spawner.htm),
  [DevMode: Tools](https://docs.flightsimulator.com/msfs2024/html/2_DevMode/Menus/Tools.htm) — MSFS 2024 SDK
  documentation, checked 2026-10-15.
- [SimConnect_AICreateSimulatedObject_EX1](https://docs.flightsimulator.com/msfs2024/html/6_Programming_APIs/SimConnect/API_Reference/AI_Object/SimConnect_AICreateSimulatedObject_EX1.htm),
  [The Virtual File System](https://docs.flightsimulator.com/msfs2024/retail/devmode/menus/tools_info/the-virtual-file-system/index.md) —
  checked 2026-10-17.
- `bridge/msfs/README.md` (bridge commands), `bridge/msfs/package/README.md` (what was learned from the smoke).
- Idea and timings: the Emergency Response On Demand v1.97 mod (TechN9ne225), analysed 2026-10-15; its code is not used.
