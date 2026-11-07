// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { FlightPhase, PhaseEvent } from '../phase/fsm.js';
import type { VdgsReplaces } from '../sim/vdgs.js';
import type { FlightKind } from './flight-kind.js';

/**
 * A scenario as the engine runs it (docs/05-scenario-engine.md). `@acars/scenarios`
 * turns YAML into this after JSON Schema validation; {@link compileScenario} checks the
 * semantics (expressions, templates, variables).
 *
 * v0 (T06): triggers `phase_enter | phase | time | distance | event`, steps `send | wait`
 * (`minutes`, `phase`). T12: `wait: reply`, `branch`, `resend`, trigger `command` (pilot
 * commands, `scenario/pilot.ts`). T14: `set` (flags that outlive the flight, the run's
 * diversion and arrival gate). T22: `vdgs` (text for the GSX docking display). T39:
 * `wait: until` and `group`. T50: `draw`, `loop`, `break`, `if`.
 */

export type ScenarioCategory = 'docs' | 'ops' | 'irregular' | 'external' | 'fun';

/** Reference times for `time` triggers: OFP schedule/estimate or actual OOOI. */
export const TIME_REFS = [
  'sched_out',
  'sched_off',
  'sched_on',
  'sched_in',
  'est_out',
  'est_off',
  'est_on',
  'est_in',
  'out',
  'off',
  'on',
  'in',
] as const;
export type TimeRef = (typeof TIME_REFS)[number];

export const DISTANCE_TARGETS = ['dest', 'tod', 'orig'] as const;
export type DistanceTarget = (typeof DISTANCE_TARGETS)[number];

/** Pilot commands (docs/05 "Входящие команды пилота"), parsed by `scenario/pilot.ts`. */
export const PILOT_COMMANDS = [
  'REQ_WX',
  'REQ_GATE',
  'REQ_LOADSHEET',
  'DELAY',
  'DIVERT',
  'ETA',
  'HELP',
  'MEDICAL',
  'REQ_ATIS',
  'RDY',
  'REQ_GATE_CHANGE',
  'REQ_NOTAM',
] as const;
export type PilotCommand = (typeof PILOT_COMMANDS)[number];

export type Trigger =
  | { readonly on: 'phase_enter'; readonly phase: FlightPhase }
  | {
      readonly on: 'phase';
      readonly phase: FlightPhase;
      /** Start at a random moment of the phase instead of at once (T51). */
      readonly window?: StartWindow;
    }
  | { readonly on: 'event'; readonly event: TriggerEvent }
  | { readonly on: 'command'; readonly command: PilotCommand }
  | { readonly on: 'time'; readonly at: { readonly rel: TimeRef; readonly offset_min: number } }
  | {
      readonly on: 'distance';
      readonly dist: {
        readonly to: DistanceTarget;
        readonly lte_nm?: number;
        readonly gte_nm?: number;
      };
    };

/**
 * A random start inside a phase (T51, `on: phase` in the cruise): when the trigger fires and
 * `probability` holds, a share `f` of the way is drawn from the scenario's seeded Rng and the
 * scenario waits for the moment `flight.minutes_to_tod ≤ T0 − after_min − f × (T0 − after_min −
 * before_tod_min)`, where T0 is `flight.minutes_to_tod` at the trigger. The start is spread
 * evenly over the path from `after_min` after the trigger to `before_tod_min` before the top of
 * descent, whatever the pauses and the sim rate. A cruise too short for the window (`T0 − after_min
 * ≤ before_tod_min`) starts nothing. At the moment of the start the conditions, the cooldown and
 * the exclusions are checked again.
 */
export interface StartWindow {
  readonly after_min: number;
  readonly before_tod_min: number;
}

/** `none`: every trigger may start the scenario (the default for `on: command`). */
export type Cooldown = 'per_flight' | 'per_session' | 'none' | { readonly minutes: number };

export interface SendStep {
  readonly send: {
    readonly header?: string;
    readonly body: string;
    readonly footer?: string;
    /** App hint to this message instead of the scenario's (T57); UI only, never sent. */
    readonly hint?: string;
    /** T85: address of the step in the translation files; required with `hint`. */
    readonly id?: string;
  };
}

/**
 * Waits for the pilot's answer: a pilot telex whose first word is one of `options`. After
 * `timeout_min` of flight time without one, `default` counts as the answer.
 */
export interface ReplyWait {
  /** One word each: `A–Z0–9`, starting with a letter. */
  readonly options: readonly string[];
  /** Exactly one of these: minutes from now, or (in a `loop` with `every_min`) to its next round. */
  readonly timeout_min?: number;
  readonly timeout_round?: true;
  readonly default: string;
  /** App hints (T57): what each option means, one line per option; UI only, never sent. */
  readonly reply_hints?: Readonly<Record<string, string>>;
  /** T85: address of the step in the translation files; required with `reply_hints`. */
  readonly id?: string;
}

/**
 * Waits until a condition (the language of `conditions`) holds; checked on every tick, also
 * when the step is reached. After `timeout_min` of flight time it is given up. A following
 * `branch` tells the outcomes apart: {@link UNTIL_OUTCOMES} (`reply.option`).
 */
export interface UntilWait {
  readonly until: string;
  readonly timeout_min: number;
}

/** Arms of a `branch` after `wait: until`. */
export const UNTIL_OUTCOMES = ['MET', 'TIMEOUT'] as const;

export type WaitStep =
  | { readonly wait: { readonly minutes: number } }
  | { readonly wait: { readonly phase: FlightPhase } }
  | { readonly wait: { readonly reply: ReplyWait } }
  | { readonly wait: UntilWait };

/** Steps by the last answer (`reply.option`); an answer without an arm goes on after it. */
export interface BranchStep {
  readonly branch: Readonly<Record<string, readonly Step[]>>;
}

/** Sends again the latest message one of these scenarios sent in this flight. */
export interface ResendStep {
  readonly resend: { readonly of: readonly string[] };
}

/** A literal, or a template (string) rendered when the step runs. */
export type SetValue = string | number | boolean | null;

/**
 * Assignments (T14): `flags.<name>` — airline memory that later scenarios of this flight and of
 * the next flights read (`null` clears it); `flight.divert` — diversion airport (ICAO, only in
 * the air, not the destination); `ops.arr_gate` — the arrival gate from now on; `flight.delay_min` (T43) — raise the flight's delay to at least
 * this many minutes (before OUT), as a pilot `DELAY` would; `flight.hold` (T48) — minutes of holding announced to the XATC station in the air (`null` ends it).
 */
export interface SetStep {
  readonly set: Readonly<Record<string, SetValue>>;
}

/** Engine fields a `set` may change besides `flags.*`. */
export const SET_TARGETS = [
  'flight.divert',
  'ops.arr_gate',
  'flight.delay_min',
  'flight.hold',
] as const;
export type SetTarget = (typeof SET_TARGETS)[number];

/** A VDGS line: a template, or `{ red: template }` for a red line. */
export type VdgsLineDef = string | { readonly red: string };

/**
 * Text for the GSX docking display (T22, `sim/vdgs.ts`): lines per display type, `narrow`
 * required; `wide` and `x` fall back to `narrow`. Templates are rendered when the step runs; a
 * line that does not fit fails the scenario. Each run replaces the scenario's text; `stop`
 * takes it down (T102).
 */
export interface VdgsStep {
  readonly vdgs:
    | 'stop'
    | {
        /**
         * Airport of the display (T102): `dest` (default) — the arrival airport or the diversion;
         * `orig` — the departure stand.
         */
        readonly at?: 'orig' | 'dest';
        /**
         * Replace GSX's standard message of this id instead of adding one (T102, GSX "override":
         * GSX shows its own when the conditions of ours are not met).
         */
        readonly replaces?: VdgsReplaces;
        /** Page time, seconds (default 6). */
        readonly duration_sec?: number;
        readonly narrow: readonly VdgsLineDef[];
        readonly small?: readonly VdgsLineDef[];
        readonly wide?: readonly VdgsLineDef[];
        readonly x?: readonly VdgsLineDef[];
        /** SafeDock FLEX, 10 × 5 (T102); without it, `narrow`. */
        readonly flex?: readonly VdgsLineDef[];
      };
}

/**
 * Smoke column in the simulator (T34): `start` — at the middle of the planned runway of the
 * destination, `stop` — take it down. `{ start: orig | dest, along_nm, side_nm: [min, max] }` —
 * beside the planned runway of that airport: up to `along_nm` either way along its axis from the
 * middle and `side_nm` off the axis to a random side (hundredths of NM, from the scenario's
 * seeded Rng), so the fire stays on the airfield and seldom in water (approved by the user
 * 2026-10-16). The place goes to `run.fire_at` for the text (`S SIDE OF RWY 24L`). Needs the
 * bridge and the smoke package (docs/06); without them nothing happens in the sim.
 */
export interface SmokeStep {
  readonly smoke:
    | 'start'
    | 'stop'
    | {
        readonly start: 'orig' | 'dest';
        readonly along_nm?: number;
        readonly side_nm?: readonly [number, number];
      };
}

/**
 * Rescue services at the landing airport (T54): `{ level: full }` — fire trucks wait beside the
 * runway, follow the aircraft after touchdown and surround it when it stops; `standby` — they wait
 * and do not move; `medical` — an ambulance beside the aircraft once it is parked. The airport is
 * `flight.divert`, else the destination. `stop` — take them all down. Needs the sim bridge;
 * without it nothing happens in the sim.
 */
export interface RescueStep {
  readonly rescue: 'stop' | { readonly level: RescueLevel };
}

export const RESCUE_LEVELS = ['full', 'standby', 'medical'] as const;
export type RescueLevel = (typeof RESCUE_LEVELS)[number];

/** A value `draw` gives a run variable: a literal, or `[min, max]` — a uniform integer. */
export type DrawValue = string | number | boolean | null | readonly [number, number];

/**
 * Random values for this run (T50): one of `options` by weight (default 1), then each of its
 * `run.<name>` gets its value. Drawn from the scenario's seeded Rng when the step runs, so the
 * same seed gives the same flight; the values live in the run state. Read them as
 * `run.<name>` in conditions and templates. A name an option does not set is null.
 */
export interface DrawStep {
  readonly draw: readonly {
    readonly weight?: number;
    readonly set: Readonly<Record<string, DrawValue>>;
  }[];
}

/**
 * Repeats `steps` until `until` holds (the end: `reply.option` = `MET`) or `stop` holds
 * (`STOP`); both are checked on every tick, also while a wait inside waits, and when a round
 * ends. `break` leaves the loop with the last answer. `loop.min` — flight minutes since the
 * loop was entered. No loop inside a loop (T50).
 */
export interface LoopStep {
  readonly loop: {
    readonly until: string;
    readonly stop?: string;
    /**
     * Rounds of this many minutes of flight time from the entry (T50): a `wait: reply` with
     * `timeout_round` ends at the next round, however often the pilot answered in between.
     */
    readonly every_min?: number;
    readonly steps: readonly Step[];
  };
}

/** Runs `steps` only when the condition holds when the step is reached (T50). */
export interface IfStep {
  readonly if: string;
  readonly steps: readonly Step[];
}

/** Leaves the innermost `loop` at once. */
export interface BreakStep {
  readonly break: true;
}

export type Step =
  | SendStep
  | WaitStep
  | BranchStep
  | ResendStep
  | SetStep
  | VdgsStep
  | SmokeStep
  | RescueStep
  | DrawStep
  | LoopStep
  | BreakStep
  | IfStep;

/** Outcomes of a `loop` besides the answers of its body: the arms of a `branch` after it. */
export const LOOP_OUTCOMES = ['MET', 'STOP'] as const;

export interface ScenarioDef {
  readonly id: string;
  readonly version: 1;
  readonly category: ScenarioCategory;
  readonly title: string;
  /** For the app UI only; translations — `@acars/scenarios` locale files (T85). */
  readonly description?: string;
  /**
   * App hint to the scenario's messages (T57): who sends it, what it is about, what the pilot is
   * expected to do. Unlike `description` it does not tell the outcomes. UI only, never sent.
   */
  readonly hint?: string;
  readonly enabled_by_default: boolean;
  readonly trigger: Trigger;
  /** All must be true (expression language: `scenario/expr.ts`). */
  readonly conditions?: readonly string[];
  /** 0..1, rolled once each time the scenario becomes a candidate. Default 1. */
  readonly probability?: number;
  /** Default `per_flight`; `none` for `on: command`. */
  readonly cooldown?: Cooldown;
  readonly excludes?: readonly string[];
  /**
   * Kinds of flight the scenario is for (T89, `flight-kind.ts`); absent = every kind. A start on
   * another kind is skipped, a start by hand ("run now") too.
   */
  readonly operations?: readonly FlightKind[];
  /**
   * Scenario group (T39): the group's `max_per_flight` (described in `@acars/scenarios`)
   * limits how many of its members start in one flight.
   */
  readonly group?: string;
  /** Higher first when several start on one tick. Default 0. */
  readonly priority?: number;
  readonly steps: readonly Step[];
}

/**
 * Phase-machine events a scenario may trigger on. TELEMETRY_LOST is left out: scenarios
 * are paused while telemetry is lost (docs/04), so such a scenario could never run.
 */
export const TRIGGER_EVENTS = [
  'PHASE_CHANGE',
  'OOOI_OUT',
  'OOOI_OFF',
  'OOOI_ON',
  'OOOI_IN',
  'ALT_CHANGE',
  'DISCONTINUITY',
  'TELEMETRY_RESTORED',
  'SIM_PAUSED',
  'SIM_RESUMED',
] as const satisfies readonly PhaseEvent['type'][];
export type TriggerEvent = (typeof TRIGGER_EVENTS)[number];
