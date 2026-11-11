# 04 — Flight phase FSM

The main source of events for scenarios. Input: a stream of `TelemetrySnapshot` (~1 Hz) and the OFP. Output: the current phase and transition events.

## Phases

```
PREFLIGHT → BOARDING → PUSHBACK → TAXI_OUT → TAKEOFF → CLIMB → CRUISE → DESCENT → APPROACH → LANDED → TAXI_IN → ON_BLOCK → (TURNAROUND | DONE)
                                                     ↑                                 │
                                                     └──────── GO_AROUND ──────────────┘
```

| Transition | Condition (draft, tune on recordings) | Stability |
|---|---|---|
| PREFLIGHT → BOARDING | flight started by the user, on the ground, engines off | immediate |
| BOARDING → PUSHBACK | beacon ON and (brake released or GS > 1 kt backwards) | 5 s |
| PUSHBACK → TAXI_OUT | any engine running and GS > 5 kt | 10 s |
| TAXI_OUT → TAKEOFF | on the ground, GS > 40 kt | 3 s |
| TAKEOFF → CLIMB | `onGround=false` and AGL > 500 ft | 5 s |
| CLIMB → CRUISE | alt ≥ (OFP cruise level − 1000 ft) and \|VS\| < 500 | 60 s |
| CRUISE → DESCENT | VS < −800 fpm and alt < cruise − 2000 ft | 60 s |
| DESCENT → APPROACH | AGL < 5000 ft or < 30 nm to destination | 10 s |
| APPROACH → LANDED | `onGround=true`, GS > 30 kt | 2 s |
| APPROACH → GO_AROUND | VS > +500 fpm and AGL rose after < 1000 ft | 5 s |
| LANDED → TAXI_IN | GS < 30 kt | 5 s |
| TAXI_IN → ON_BLOCK | GS < 1 kt, brake ON, all engines off | 10 s |
| *+ TAKEOFF → TAXI_OUT* | *rejected takeoff: on the ground, GS < 20 kt* | *10 s* |
| *+ CLIMB → DESCENT* | *VS < −800 fpm (OFP level not reached: short sector, diversion to the alternate)* | *60 s* |
| *+ GO_AROUND → CLIMB* | *AGL > 5000 ft and VS > 0 (diversion to the alternate)* | *10 s* |
| *+ GO_AROUND → APPROACH* | *VS < +300 fpm (level-off/descent for another approach)* | *10 s* |
| *+ ON_BLOCK → TURNAROUND \| DONE* | *user decision* | *immediate* |

Rows in *italics with "+"* were added in T04: without them the FSM gets stuck. Tune them on recordings together with the rest.

Implementation: `packages/core/src/phase/fsm.ts`. Stability timers run on "flight time" (snapshot Δt × `simRate`, without pauses); OOOI OUT is brake released and GS ≥ 1 kt for 3 s in a row (the time is the start of movement); DISCONTINUITY is a position jump > 2 nm + 1.5 × GS × flight Δt; ALT_CHANGE is a new level (±1000 ft, |VS| < 300) held for 30 s.

A step climb in cruise is an `ALT_CHANGE` event, not a phase change.

## Requirements

- **Hysteresis and stability:** a condition must hold for N seconds (the "Stability" column).
- **Pause and time acceleration:** while `paused`, the stability timers do not run. The internal "flight time" is scaled by `simRate`.
- **Teleport and slew:** a position jump > X nm per tick produces a `DISCONTINUITY` event; the FSM makes no false transitions.
- **Telemetry loss:** no data for > 30 s → `TELEMETRY_LOST`. Scenarios are paused, the phase is kept.
- **Resume:** the FSM state is serialized. After an app restart the flight continues.
- **OOOI events:** OUT (brake released and movement), OFF (liftoff), ON (touchdown), IN (on block) — with UTC time.

## Derived values for triggers

- `distToDestNm`, `distToTodNm` (TOD from the OFP navlog, `ident == "TOD"` `[VERIFY]` navlog format), `etaUtc`.
- `minutesToSchedOut` / `minutesSinceOff`.
- `fuelStable` (stabilization after refueling: tolerance ~100 kg, 2+ samples).

## Testing

- `tools/replay`: record telemetry to JSONL + OFP → run through the FSM → snapshot of the phase sequence.
- Recordings needed: a normal flight, a go-around, an engine restart during taxi, a flight with pause and ×4, a teleport to the runway (no taxi), a SimConnect drop.
- Synthetic profile generators for unit tests (without MSFS).
