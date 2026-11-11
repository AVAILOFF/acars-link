# 03 — Architecture

> Stage 0 decisions (see `08`): shell — **Electron**, bridge — **C# / .NET 10 LTS** (T79; .NET 8 before), no backend needed at the start, UI — EN + RU, since T85 a list of languages (`LANGUAGES`, docs/08 decision 7).

## Components

```
┌──────────────┐  named pipe/SimConnect  ┌───────────────────────┐
│  MSFS        │ ───────────────────────>│ sim-bridge (C#/.NET)  │
└──────────────┘                         │ WebSocket 127.0.0.1   │
                                         └──────────┬────────────┘
                                                    │ TelemetrySnapshot, 1 Hz
┌──────────────┐  OFP JSON                ┌─────────v──────────────────────────┐
│  SimBrief    │ ────────────────────────>│ app (Electron)                     │
└──────────────┘                          │  ├─ packages/core   (pure TS)      │
                                          │  │   phase FSM · scheduler ·       │
┌──────────────┐  telex/poll              │  │   scenario engine · formatter   │
│ Hoppie / SI  │ <───────────────────────>│  ├─ adapters: transport, data,     │
└──────────────┘                          │  │   storage, clock, rng           │
                                          │  └─ ui (React)                     │
┌──────────────┐  HTTPS (opt.)            └────────────────────────────────────┘
│ backend      │ <── LLM proxy, paid APIs (keys only here)
└──────────────┘
```

## Monorepo (proposal)

```
apps/desktop            Electron shell + React UI (languages — `LANGUAGES`, T85)
apps/backend            (opt.) LLM proxy, external data cache
bridge/msfs             C# console bridge SimConnect → WebSocket
packages/core           FSM, scheduler, scenarios, formatter — pure TS
packages/scenarios      YAML scenarios + JSON Schema + validator
packages/data-sources   METAR/TAF, VATSIM, EONET, OSM stands (adapters)
packages/transport      Hoppie, SayIntentions, Mock
tools/replay            recording and replay of telemetry for tests
```

Bridge process (T75, user decisions 2026-10-31): the installed app starts `acars-msfs-bridge.exe` itself and supervises it (`apps/desktop/src/main/bridge-supervisor.ts`). An exit the app did not ask for is followed by a restart after 1, 2, 4 … 30 s, at most 5 times in 5 minutes; then it stops until the app is restarted or the port/simulator is changed in the settings, with the status "does not start" and the last lines of `bridge.log`. The flight does not stop; the feed shows a line "The simulator bridge stopped and was started again; the flight goes on" (`bridge_restarted`). Exit code 4 means the port is taken by another program (`ExitCodes.PortInUse`): the bridge is not restarted, the status is "port busy" with a hint. The Node client does not expose the WebSocket response code when the token is refused (403) — 403 and "connection refused" are indistinguishable (checked 2026-10-31, Node 24 / undici 7.28: an `error` event without fields and `close` 1006 with an empty reason), so "port busy" is shown on the basis "our process exited with code 4 and the connection to the bridge was not opened"; if a bridge without a token is on the port (started manually) and the connection opened, the app works with it and shows nothing. The bridge protocol (v2) did not change. The bridge exits together with the app (T80, decision 2026-10-31): the app passes `--parent-pid` with the PID of the main process; the bridge holds a handle to that process and, when it ends (including a hard end — task manager, crash), closes the simulator session and the server and exits with code 0; if the parent is already gone at startup, it exits immediately. Without the argument (manual start) it works as before.

Default stack (as in the user's other projects): pnpm, TypeScript strict, React, Zustand, Vitest, Biome, Playwright for UI. The bridge is C# (.NET 10 LTS, T79); SimConnect goes through `acars_simconnect.dll` (C++, `bridge/msfs/native`, static linking of the client from the official MSFS SDK; P/Invoke from C#, T73). The SDK's managed wrapper and `SimConnect.dll` are not used and not shipped.

**Electron or Tauri:** Electron was chosen (08, decision 1): simpler and with a mature ecosystem; the cost is a ~100 MB installer.

## Core: contract

```ts
interface CoreInput {
  ofp: Ofp;                       // normalized SimBrief
  telemetry: TelemetrySnapshot;   // latest snapshot
  inbound: InboundMessage[];      // pilot replies since the previous tick
  now: number;                    // from Clock, ms UTC
}
interface CoreOutput {
  outbound: OutboundMessage[];    // { to, from, text, kind: telex | cpdlc (+ /data2/ header) }
  commands: SimCommand[];         // commands to the simulator (T21)
  phase: FlightPhase;
  events: CoreEvent[];            // for the UI and the log (phases, scenarios, XATC ATC)
  listen: string[];               // XATC ATC station callsigns to poll (T23)
}
// core.tick(input) → output. State lives inside the instance, serializable (resume after a restart).
// core.report() → FlightReport — flight summary (T69), see below.
```

### Flight summary (T69)

User decisions 2026-10-30 (`07`, T69). `AcarsCore.report()` is a pure calculation of `flightReport` (`packages/core/src/summary/report.ts`) from core data: the phase machine's OOOI and the fuel/position of the snapshot exactly at the moment of each OOOI (`PhaseMachine.oooiAt`), the OFP plan (`sched_out…sched_in`, `sched_block`, `est_time_enroute`, `plan_ramp`/`plan_takeoff`/`plan_landing`, `taxi`, `enroute_burn`), the touchdown rate from the simulator (T46; none — `null`, "no data"), go-arounds (entries into `GO_AROUND`), the delay with IATA codes (T43), the diversion airport (T50), message counters (airline — issued by scenarios; pilot — telexes to the airline, except `ignored`; of them replies to `wait: reply`) and the non-standard scenarios that fired. Numbers only, no assessments; the difference is "actual − plan". The landing airport is the one nearest to the touchdown point among the OFP airports (destination, departure, alternates, ETOPS) and the diversion airport within `LANDED_WITHIN_NM` = 5 NM; farther away it is an unknown airport with coordinates; a diversion is a landing somewhere other than the destination airport. The summary is taken at the moment the flight is closed at the gate (`endFlight` → TURNAROUND/DONE): turnaround messages after that belong to the next flight. The app writes it as a `summary` line right after `end` in the flight recording and adds it to the flight logbook `<userData>/logbook.json` (no limit on the number of flights); `pnpm replay summary <recording>` calculates it again with the same code (`--check` compares with the `summary` line).

### Flight resume after the app is closed or crashes (T64)

User decisions 2026-10-29 (`07`, T64). The flight is restored from the flight recording (T11), there is no separate state file: at startup the app finds the latest recording (by name — the start time) and offers to continue if it has `start`, has no `end` and `stop`, the header was written after T64 (it has the `simTime` field) and the file changed no more than 24 h ago (`RESUME_MAX_AGE_MS`, `apps/desktop/src/main/recording.ts`). "Continue" is a `FlightSession` with `resume`: the core is created from the header (`recordedCoreOptions`, `tools/replay/src/run.ts` — the same options as in `pnpm replay run`), all recording events are run through the core again (invariant 4), the feed is rebuilt from the same run; the transport, bridge, data and file are not touched meanwhile. Each telex of the run is compared with the `out` line of the recording; a mismatch (different scenarios, a different app version) is a `resume_mismatch` refusal, the flight is not loaded. Then telexes without a `sent` line are sent again (decision 5), the transport listens to the XATC stations again, and the recording is appended to the same file (`resume`, decision 3). The run is fast: a synthetic RJTT–KLAX 12 h (43,580 ticks, 18 MB) takes 1.7 s including the Node startup (measured 2026-10-29). "Discard" writes `stop` at the end of the recording, the flight is no longer offered; a new flight does the same with the previous one. Closing the window and exiting the app do not stop the flight (`FlightSession.suspend`: the file is closed without `stop`). With the "Record flights" setting off, the recording is still written — to the temporary folder `<userData>/flight-temp` — and deleted when the flight is stopped or discarded (decision 6). Not restored: simulator effects that were active at the moment of the crash (smoke, vehicles — the app removes them at startup, `SimEffects.clear`), and a flight close that started in TURNAROUND/DONE (`end` is already written).

Rng: xoshiro128** (`packages/core/src/random/rng.ts`), seed = `"<callsign>/<OFP request_id>"` or set by the user. String → FNV-1a 32 → expansion to 128 bits (a SplitMix32-like mixer). The seeding scheme is part of the replay contract, fixed by golden tests. The state is serialized (`getState`/`rngFromState`).

Clock: the interface `now(): number` (ms UTC). The core has only `ManualClock`; the app supplies the real clock.

## TelemetrySnapshot (v1)

SimVar names and units are `[VERIFY]` against the MSFS SDK documentation before the bridge is implemented.

| Field | SimVar | Units |
|---|---|---|
| `v` | — | schema version, `1` |
| `t` | — | snapshot time, ms UTC (bridge clock) |
| `lat`, `lon` | PLANE LATITUDE / PLANE LONGITUDE | degrees |
| `altFt` | PLANE ALTITUDE | feet |
| `aglFt` | PLANE ALT ABOVE GROUND | feet |
| `iasKt` | AIRSPEED INDICATED | knots |
| `gsKt` | GROUND VELOCITY | knots |
| `vsFpm` | VERTICAL SPEED | feet per minute |
| `hdgTrue` | PLANE HEADING DEGREES TRUE | degrees |
| `onGround` | SIM ON GROUND | bool |
| `parkingBrake` | BRAKE PARKING POSITION; for Fenix (TITLE starts with `Fenix`) also `L:S_MIP_PARKING_BRAKE` ≥ 0.5 (either one) | bool |
| `beacon` | LIGHT BEACON | bool |
| `engRunning[n]` | GENERAL ENG COMBUSTION:n | bool |
| `engN2[n]` | ENG N2 RPM:n or TURB ENG N2:n | percent |
| `fuelKg` | FUEL TOTAL QUANTITY WEIGHT | **request in kilograms** |
| `gearDown` | GEAR HANDLE POSITION | bool |
| `flapsIdx` | FLAPS HANDLE INDEX | number |
| `doorsOpen[n]` | EXIT OPEN:n | percent (does not work in many add-ons) |
| `xpdrState` | TRANSPONDER STATE:1 | enum |
| `simRate` | SIMULATION RATE | number |
| `paused` | system event Pause | bool |
| `aircraftTitle` | TITLE | string |
| `touchdownFpm` | PLANE TOUCHDOWN NORMAL VELOCITY (T46) | **feet per second** × 60 → ft/min; the sim holds the value until the next touchdown; optional in TS (old recordings) |
| `ground` | L:FSDT_GSX_BOARDING_STATE, _DEBOARDING_STATE, _REFUELING_STATE, _CATERING_STATE, _DEPARTURE_STATE, L:FSDT_GSX_BOARDING_CARGO (T98) | number → `{ boarding, deboarding, refuel, catering, departure: 0..6, cargo: bool }`; 1 can be called, 2 unavailable, 3 skipped, 4 requested, 5 in progress, 6 completed (GSX Pro for MSFS manual 4.0.9 Pro, p. 106, checked 2026-11-07); optional: absent if all six L:vars are 0 (GSX not running; an L:var nobody has set reads as 0), in X-Plane and in old recordings. A compatible addition, `telemetryVersion` and the bridge protocol version do not change (as with `simUtcMs`) |

Example — `reference/telemetry.sample.json`.

Fenix A320 parking brake (2026-10-23, bug: the app "taxied" at the stand): Fenix 3.0.0.7438 (update of 2026-10-21) does not drive BRAKE PARKING POSITION — it is 0 in all flights since 22.10. **Checked by a human** (MSFS 2024, Fenix A320, LIRF, stand, engines off, 2026-10-23, SimConnect probe): `L:S_MIP_PARKING_BRAKE` follows the handle 1 → 0 → 1, `L:B_HYD_PARKING_BRAKE_SET` is 0 all the time, BRAKE PARKING POSITION is 0. Reading an L-variable: `AddToDataDefinition("L:NAME", "number")`, FLOAT64 only (SDK, SimConnect_AddToDataDefinition, checked 2026-10-23). **Approved by the user 2026-10-23:** Fenix is detected by the TITLE prefix `Fenix`, brake = SimVar or LVar; for other aircraft — SimVar only. The brake in the rescue vehicles (T54) follows the same rule.

## Display profiles

`DisplayProfile { id, matchIcao[], matchTitleRegex?, lineWidth, maxLines?, uppercase, allowedChars, pageBreak? }`. Line widths for specific add-ons are unknown — they are collected through the "Human check".

Implementation — `packages/core/src/format/` (T05). The default is 24 characters (MCDU/CDU columns; the base width is unknown `[VERIFY]`), B77x — 27, B78x — 30. Default characters: `A–Z 0–9`, space and `.,:;/-+()'?!=%#*&@`; `{}` (Hoppie packet delimiters), quotes, `\`, `<>`, `|` are forbidden. Layout: header, a line of hyphens, body, a line of dots, footer; a body line of `-`/`.`/`=`/`*` (≥ 3) is stretched to the full width. Wrapping at a space or after `/`/`-` inside a word, otherwise a hard wrap.
