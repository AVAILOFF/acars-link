import type { FlightPhase, PhaseEvent } from '../phase/fsm.js';

/**
 * A scenario as the engine runs it (docs/05-scenario-engine.md). `@acars/scenarios`
 * turns YAML into this after JSON Schema validation; {@link compileScenario} checks the
 * semantics (expressions, templates, variables).
 *
 * v0 (T06): triggers `phase_enter | phase | time | distance | event`, steps `send | wait`
 * (`minutes`, `phase`). `reply`, `branch`, `set` come with T12.
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

export type Trigger =
  | { readonly on: 'phase_enter'; readonly phase: FlightPhase }
  | { readonly on: 'phase'; readonly phase: FlightPhase }
  | { readonly on: 'event'; readonly event: TriggerEvent }
  | { readonly on: 'time'; readonly at: { readonly rel: TimeRef; readonly offset_min: number } }
  | {
      readonly on: 'distance';
      readonly dist: {
        readonly to: DistanceTarget;
        readonly lte_nm?: number;
        readonly gte_nm?: number;
      };
    };

export type Cooldown = 'per_flight' | 'per_session' | { readonly minutes: number };

export interface SendStep {
  readonly send: {
    readonly header?: string;
    readonly body: string;
    readonly footer?: string;
  };
}

export type WaitStep =
  | { readonly wait: { readonly minutes: number } }
  | { readonly wait: { readonly phase: FlightPhase } };

export type Step = SendStep | WaitStep;

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
  /** Default `per_flight`. */
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
