import type { FlightPhase, PhaseEvent } from '../phase/fsm.js';

/**
 * A scenario as the engine runs it (docs/05-scenario-engine.md). `@acars/scenarios`
 * turns YAML into this after JSON Schema validation; {@link compileScenario} checks the
 * semantics (expressions, templates, variables).
 *
 * v0 (T06): triggers `phase_enter | phase | time | distance | event`, steps `send | wait`
 * (`minutes`, `phase`). T12: `wait: reply`, `branch`, `resend`, trigger `command` (pilot
 * commands, `scenario/pilot.ts`). T14: `set` (flags that outlive the flight, the run's
 * diversion and arrival gate).
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
] as const;
export type PilotCommand = (typeof PILOT_COMMANDS)[number];

export type Trigger =
  | { readonly on: 'phase_enter'; readonly phase: FlightPhase }
  | { readonly on: 'phase'; readonly phase: FlightPhase }
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

/** `none`: every trigger may start the scenario (the default for `on: command`). */
export type Cooldown = 'per_flight' | 'per_session' | 'none' | { readonly minutes: number };

export interface SendStep {
  readonly send: {
    readonly header?: string;
    readonly body: string;
    readonly footer?: string;
  };
}

/**
 * Waits for the pilot's answer: a pilot telex whose first word is one of `options`. After
 * `timeout_min` of flight time without one, `default` counts as the answer.
 */
export interface ReplyWait {
  /** One word each: `A–Z0–9`, starting with a letter. */
  readonly options: readonly string[];
  readonly timeout_min: number;
  readonly default: string;
}

export type WaitStep =
  | { readonly wait: { readonly minutes: number } }
  | { readonly wait: { readonly phase: FlightPhase } }
  | { readonly wait: { readonly reply: ReplyWait } };

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
 * the air, not the destination); `ops.arr_gate` — the arrival gate from now on.
 */
export interface SetStep {
  readonly set: Readonly<Record<string, SetValue>>;
}

/** Engine fields a `set` may change besides `flags.*`. */
export const SET_TARGETS = ['flight.divert', 'ops.arr_gate'] as const;
export type SetTarget = (typeof SET_TARGETS)[number];

export type Step = SendStep | WaitStep | BranchStep | ResendStep | SetStep;

export interface ScenarioDef {
  readonly id: string;
  readonly version: 1;
  readonly category: ScenarioCategory;
  readonly title: string;
  readonly enabled_by_default: boolean;
  readonly trigger: Trigger;
  /** All must be true (expression language: `scenario/expr.ts`). */
  readonly conditions?: readonly string[];
  /** 0..1, rolled once each time the scenario becomes a candidate. Default 1. */
  readonly probability?: number;
  /** Default `per_flight`; `none` for `on: command`. */
  readonly cooldown?: Cooldown;
  readonly excludes?: readonly string[];
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
