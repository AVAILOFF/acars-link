import { FormatError, type FormattedMessage, formatMessage } from '../format/formatter.js';
import { DEFAULT_PROFILE, type DisplayProfile } from '../format/profile.js';
import type { Ofp } from '../ofp/types.js';
import { FLIGHT_PHASES, type FlightPhase, type OooiKind, type PhaseEvent } from '../phase/fsm.js';
import { createRng, type Rng, type RngState, rngFromState } from '../random/rng.js';
import type { TelemetrySnapshot } from '../telemetry/types.js';
import type { CompiledScenario } from './compile.js';
import { buildContext, RouteGeometry, type ScenarioContext } from './context.js';
import type { Lookup } from './expr.js';
import { buildFlightData, type FlightData } from './ops-data.js';
import { TemplateError } from './template.js';
import type { TimeRef } from './types.js';

/**
 * Scenario runtime v0 (docs/05 "Исполнение").
 *
 * Each tick: running scenarios advance (`wait` → `send` …); then every scenario whose
 * trigger *and* conditions turned true this tick is a new candidate: cooldown and
 * excludes are checked, `probability` is rolled once, the winners start in priority
 * order. Nothing runs while telemetry is lost (docs/04).
 *
 * Determinism: each scenario has its own Rng seeded `${seed}/${id}`, so adding a
 * scenario does not change the dice of the others. `wait.minutes` counts flight time
 * (sim rate, pauses), `time` triggers use the injected clock (`now`).
 */

export interface OutboundMessage {
  readonly scenarioId: string;
  /** Station callsign (sender). */
  readonly from: string;
  /** Aircraft callsign (recipient). */
  readonly to: string;
  readonly kind: 'telex';
  readonly message: FormattedMessage;
  readonly t: number;
}

export type ScenarioEvent =
  | { readonly type: 'SCENARIO_STARTED'; readonly id: string; readonly t: number }
  | {
      readonly type: 'SCENARIO_SKIPPED';
      readonly id: string;
      readonly t: number;
      readonly reason: 'probability' | 'cooldown' | 'excluded' | 'running';
    }
  | { readonly type: 'SCENARIO_DONE'; readonly id: string; readonly t: number }
  | {
      readonly type: 'SCENARIO_ERROR';
      readonly id: string;
      readonly t: number;
      readonly error: string;
    };

export interface EngineTickInput {
  readonly now: number;
  readonly phase: FlightPhase;
  /** Phase-machine events of this tick. */
  readonly events: readonly PhaseEvent[];
  readonly telemetry: TelemetrySnapshot | null;
  readonly oooi: Readonly<Record<OooiKind, number | null>>;
  readonly flightTimeMs: number;
  readonly telemetryLost: boolean;
}

export interface EngineTickOutput {
  readonly outbound: readonly OutboundMessage[];
  readonly events: readonly ScenarioEvent[];
}

export interface ScenarioEngineOptions {
  readonly ofp: Ofp;
  /** Enabled scenarios. Ids must be unique. */
  readonly scenarios: readonly CompiledScenario[];
  readonly seed: number | string;
  readonly profile?: DisplayProfile;
  /** Station callsign template, docs/08 decision 6: `{flight}`, `{airline}`. */
  readonly station?: string;
  /** Scenario ids already run in this app session (`cooldown: per_session`). */
  readonly sessionFired?: readonly string[];
}

interface ScenarioState {
  candidate: boolean;
  starts: number;
  lastStartMs: number | null;
  rng: RngState;
}

interface Run {
  readonly id: string;
  step: number;
  /** Flight time to resume at (`wait.minutes`). */
  untilFlightMs: number | null;
  untilPhase: FlightPhase | null;
}

export interface ScenarioEngineState {
  readonly v: 1;
  readonly scenarios: Readonly<Record<string, Readonly<ScenarioState>>>;
  readonly runs: readonly Readonly<Run>[];
  readonly sessionFired: readonly string[];
}

export const DEFAULT_STATION = 'OPS{flight}';

const PHASE_ORDER: ReadonlyMap<FlightPhase, number> = new Map(FLIGHT_PHASES.map((p, i) => [p, i]));

/** `current` is `target` or later in the flight (GO_AROUND counts as after APPROACH). */
function phaseReached(current: FlightPhase, target: FlightPhase): boolean {
  return (PHASE_ORDER.get(current) ?? 0) >= (PHASE_ORDER.get(target) ?? 0);
}

const TIME_REF_VAR: Readonly<Record<TimeRef, keyof ScenarioContext>> = {
  sched_out: 'ofp.sched_out',
  sched_off: 'ofp.sched_off',
  sched_on: 'ofp.sched_on',
  sched_in: 'ofp.sched_in',
  est_out: 'ofp.est_out',
  est_off: 'ofp.est_off',
  est_on: 'ofp.est_on',
  est_in: 'ofp.est_in',
  out: 'flight.out',
  off: 'flight.off',
  on: 'flight.on',
  in: 'flight.in',
};

const DIST_VAR = {
  dest: 'flight.dist_to_dest_nm',
  tod: 'flight.dist_to_tod_nm',
  orig: 'flight.dist_from_orig_nm',
} as const;

export class ScenarioEngine {
  private readonly ofp: Ofp;
  private readonly route: RouteGeometry;
  /** Derived from OFP + seed, so not part of the serialized state. */
  private readonly data: FlightData;
  private readonly profile: DisplayProfile;
  private readonly from: string;
  private readonly byId: ReadonlyMap<string, CompiledScenario>;
  /** Start order for one tick: priority desc, then id. */
  private readonly ordered: readonly CompiledScenario[];
  private readonly rngs = new Map<string, Rng>();
  private st: { scenarios: Record<string, ScenarioState>; runs: Run[]; sessionFired: string[] };

  constructor(options: ScenarioEngineOptions) {
    this.ofp = options.ofp;
    this.route = new RouteGeometry(options.ofp);
    this.data = buildFlightData(options.ofp, options.seed);
    this.profile = options.profile ?? DEFAULT_PROFILE;
    this.from = stationCallsign(options.station ?? DEFAULT_STATION, options.ofp);
    const byId = new Map<string, CompiledScenario>();
    for (const s of options.scenarios) {
      if (byId.has(s.id)) throw new Error(`duplicate scenario id ${s.id}`);
      byId.set(s.id, s);
    }
    this.byId = byId;
    this.ordered = [...byId.values()].sort(
      (a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const scenarios: Record<string, ScenarioState> = {};
    for (const s of this.ordered) {
      const rng = createRng(`${String(options.seed)}/${s.id}`);
      this.rngs.set(s.id, rng);
      scenarios[s.id] = { candidate: false, starts: 0, lastStartMs: null, rng: rng.getState() };
    }
    this.st = { scenarios, runs: [], sessionFired: [...(options.sessionFired ?? [])] };
  }

  /** Resumes from {@link getState}; the same compiled scenarios must be passed in. */
  static fromState(state: ScenarioEngineState, options: ScenarioEngineOptions): ScenarioEngine {
    if (state.v !== 1)
      throw new Error(`unsupported ScenarioEngineState version ${String(state.v)}`);
    const e = new ScenarioEngine(options);
    const copy = JSON.parse(JSON.stringify(state)) as ScenarioEngineState;
    for (const [id, s] of Object.entries(copy.scenarios)) {
      if (!e.byId.has(id)) continue; // scenario disabled since: drop its state
      (e.st.scenarios as Record<string, ScenarioState>)[id] = { ...s };
      e.rngs.set(id, rngFromState(s.rng));
    }
    e.st.runs = copy.runs.filter((r) => e.byId.has(r.id)).map((r) => ({ ...r }));
    e.st.sessionFired = [...copy.sessionFired];
    return e;
  }

  getState(): ScenarioEngineState {
    for (const [id, rng] of this.rngs)
      (this.st.scenarios[id] as ScenarioState).rng = rng.getState();
    return JSON.parse(JSON.stringify({ v: 1, ...this.st })) as ScenarioEngineState;
  }

  /** Ids started in this session (persist them to honour `per_session` across flights). */
  get sessionFired(): readonly string[] {
    return [...this.st.sessionFired];
  }

  get running(): readonly string[] {
    return this.st.runs.map((r) => r.id);
  }

  tick(input: EngineTickInput): EngineTickOutput {
    const outbound: OutboundMessage[] = [];
    const events: ScenarioEvent[] = [];
    if (input.telemetryLost) return { outbound, events };

    const ctx = buildContext({
      ofp: this.ofp,
      route: this.route,
      now: input.now,
      phase: input.phase,
      telemetry: input.telemetry,
      oooi: input.oooi,
      data: this.data,
    });
    const look: Lookup = (path) => (path in ctx ? ctx[path as keyof ScenarioContext] : undefined);

    // 1. Running scenarios.
    for (const run of [...this.st.runs]) this.advance(run, input, look, outbound, events);

    // 2. New candidates.
    for (const sc of this.ordered) {
      const s = this.st.scenarios[sc.id] as ScenarioState;
      const active = this.triggered(sc, input, ctx) && sc.conditions.every((c) => c.test(look));
      const fresh = active && !s.candidate;
      s.candidate = active;
      if (!fresh) continue;
      const skip = this.blocker(sc, s, input.now);
      if (skip !== null) {
        events.push({ type: 'SCENARIO_SKIPPED', id: sc.id, t: input.now, reason: skip });
        continue;
      }
      if (!(this.rngs.get(sc.id) as Rng).chance(sc.probability)) {
        events.push({ type: 'SCENARIO_SKIPPED', id: sc.id, t: input.now, reason: 'probability' });
        continue;
      }
      s.starts++;
      s.lastStartMs = input.now;
      if (!this.st.sessionFired.includes(sc.id)) this.st.sessionFired.push(sc.id);
      events.push({ type: 'SCENARIO_STARTED', id: sc.id, t: input.now });
      const run: Run = { id: sc.id, step: 0, untilFlightMs: null, untilPhase: null };
      this.st.runs.push(run);
      this.advance(run, input, look, outbound, events);
    }
    return { outbound, events };
  }

  private triggered(sc: CompiledScenario, input: EngineTickInput, ctx: ScenarioContext): boolean {
    const tr = sc.def.trigger;
    switch (tr.on) {
      case 'phase_enter':
        return input.events.some((e) => e.type === 'PHASE_CHANGE' && e.to === tr.phase);
      case 'phase':
        return input.phase === tr.phase;
      case 'event':
        return input.events.some((e) => e.type === tr.event);
      case 'time': {
        const ref = ctx[TIME_REF_VAR[tr.at.rel]];
        return typeof ref === 'number' && input.now >= ref + tr.at.offset_min * 60_000;
      }
      case 'distance': {
        const d = ctx[DIST_VAR[tr.dist.to]];
        if (typeof d !== 'number') return false;
        const { lte_nm: lte, gte_nm: gte } = tr.dist;
        return (lte === undefined || d <= lte) && (gte === undefined || d >= gte);
      }
    }
  }

  private blocker(
    sc: CompiledScenario,
    s: ScenarioState,
    now: number,
  ): 'cooldown' | 'excluded' | 'running' | null {
    if (this.st.runs.some((r) => r.id === sc.id)) return 'running';
    const cd = sc.def.cooldown ?? 'per_flight';
    if (cd === 'per_flight' && s.starts > 0) return 'cooldown';
    if (cd === 'per_session' && this.st.sessionFired.includes(sc.id)) return 'cooldown';
    if (
      typeof cd === 'object' &&
      s.lastStartMs !== null &&
      now - s.lastStartMs < cd.minutes * 60_000
    ) {
      return 'cooldown';
    }
    // Mutual exclusion, either direction, against anything started in this flight.
    for (const other of this.ordered) {
      if (other.id === sc.id || (this.st.scenarios[other.id] as ScenarioState).starts === 0)
        continue;
      if (sc.def.excludes?.includes(other.id) || other.def.excludes?.includes(sc.id)) {
        return 'excluded';
      }
    }
    return null;
  }

  /** Executes steps of a run until it waits or finishes. */
  private advance(
    run: Run,
    input: EngineTickInput,
    look: Lookup,
    outbound: OutboundMessage[],
    events: ScenarioEvent[],
  ): void {
    const sc = this.byId.get(run.id) as CompiledScenario;
    const rng = this.rngs.get(run.id) as Rng;
    if (run.untilFlightMs !== null) {
      if (input.flightTimeMs < run.untilFlightMs) return;
      run.untilFlightMs = null;
    }
    if (run.untilPhase !== null) {
      if (!phaseReached(input.phase, run.untilPhase)) return;
      run.untilPhase = null;
    }
    while (run.step < sc.steps.length) {
      const step = sc.steps[run.step] as CompiledScenario['steps'][number];
      run.step++;
      if (step.kind === 'wait_minutes') {
        run.untilFlightMs = input.flightTimeMs + step.minutes * 60_000;
        return;
      }
      if (step.kind === 'wait_phase') {
        if (phaseReached(input.phase, step.phase)) continue;
        run.untilPhase = step.phase;
        return;
      }
      try {
        const header = step.header?.render(look, rng);
        const footer = step.footer?.render(look, rng);
        const message = formatMessage(
          {
            body: step.body.render(look, rng),
            ...(header === undefined ? {} : { header }),
            ...(footer === undefined ? {} : { footer }),
          },
          this.profile,
        );
        outbound.push({
          scenarioId: sc.id,
          from: this.from,
          to: this.ofp.callsign,
          kind: 'telex',
          message,
          t: input.now,
        });
      } catch (e) {
        if (!(e instanceof TemplateError || e instanceof FormatError)) throw e;
        this.st.runs = this.st.runs.filter((r) => r !== run);
        events.push({ type: 'SCENARIO_ERROR', id: sc.id, t: input.now, error: e.message });
        return;
      }
    }
    this.st.runs = this.st.runs.filter((r) => r !== run);
    events.push({ type: 'SCENARIO_DONE', id: sc.id, t: input.now });
  }
}

/** `OPS{flight}` → `OPS822`. Uppercase A–Z0–9 only. `[ПРОВЕРИТЬ]` Hoppie callsign length. */
export function stationCallsign(
  template: string,
  ofp: Pick<Ofp, 'flightNumber' | 'airlineIcao' | 'callsign'>,
): string {
  const s = template
    .replaceAll('{flight}', ofp.flightNumber ?? ofp.callsign)
    .replaceAll('{airline}', ofp.airlineIcao ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (s === '') throw new Error(`station template "${template}" gives an empty callsign`);
  return s;
}
