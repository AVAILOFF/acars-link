import type { DisplayProfile } from './format/profile.js';
import type { Ofp } from './ofp/types.js';
import {
  type FlightPhase,
  type PhaseConfig,
  type PhaseEvent,
  PhaseMachine,
  type PhaseMachineState,
} from './phase/fsm.js';
import type { CompiledScenario } from './scenario/compile.js';
import {
  type OutboundMessage,
  ScenarioEngine,
  type ScenarioEngineState,
  type ScenarioEvent,
} from './scenario/engine.js';
import type { TelemetrySnapshot } from './telemetry/types.js';

/**
 * The core contract of docs/03 "Ядро: контракт": `tick(input) → output`, state inside,
 * serializable. Wires the phase machine to the scenario engine. Inbound pilot messages
 * (`inbound`) arrive with T12.
 */

export interface CoreInput {
  /** From the injected Clock, epoch ms UTC. */
  readonly now: number;
  /** Latest snapshot, or null when none arrived since the last tick. */
  readonly telemetry: TelemetrySnapshot | null;
}

export interface CoreOutput {
  readonly outbound: readonly OutboundMessage[];
  readonly phase: FlightPhase;
  readonly events: readonly (PhaseEvent | ScenarioEvent)[];
}

export interface CoreOptions {
  readonly ofp: Ofp;
  readonly scenarios: readonly CompiledScenario[];
  /** Default `${callsign}/${request_id}` (docs/03 Rng). */
  readonly seed?: number | string;
  readonly profile?: DisplayProfile;
  readonly station?: string;
  readonly sessionFired?: readonly string[];
  readonly phaseConfig?: Partial<PhaseConfig>;
}

export interface CoreState {
  readonly v: 1;
  readonly phase: PhaseMachineState;
  readonly engine: ScenarioEngineState;
}

export class AcarsCore {
  private constructor(
    private readonly fsm: PhaseMachine,
    private readonly engine: ScenarioEngine,
  ) {}

  static create(options: CoreOptions): AcarsCore {
    const fsm = new PhaseMachine({
      ofp: options.ofp,
      ...(options.phaseConfig === undefined ? {} : { config: options.phaseConfig }),
    });
    return new AcarsCore(fsm, new ScenarioEngine(engineOptions(options)));
  }

  static fromState(state: CoreState, options: CoreOptions): AcarsCore {
    if (state.v !== 1) throw new Error(`unsupported CoreState version ${String(state.v)}`);
    return new AcarsCore(
      PhaseMachine.fromState(state.phase, options.phaseConfig),
      ScenarioEngine.fromState(state.engine, engineOptions(options)),
    );
  }

  get phase(): FlightPhase {
    return this.fsm.phase;
  }

  get sessionFired(): readonly string[] {
    return this.engine.sessionFired;
  }

  getState(): CoreState {
    return { v: 1, phase: this.fsm.getState(), engine: this.engine.getState() };
  }

  /** The user starts the flight (PREFLIGHT → BOARDING). */
  startFlight(): void {
    this.fsm.startFlight();
  }

  /**
   * The user closes the flight from ON_BLOCK (docs/04: TURNAROUND or DONE). Runs one tick at
   * `now` so scenarios see the phase change right away. Throws outside ON_BLOCK.
   */
  endFlight(to: 'TURNAROUND' | 'DONE', now: number): CoreOutput {
    return this.run(now, this.fsm.endFlight(to, now));
  }

  tick(input: CoreInput): CoreOutput {
    return this.run(input.now, [
      ...(input.telemetry === null ? [] : this.fsm.push(input.telemetry, input.now)),
      ...this.fsm.tick(input.now),
    ]);
  }

  private run(now: number, phaseEvents: readonly PhaseEvent[]): CoreOutput {
    const out = this.engine.tick({
      now,
      phase: this.fsm.phase,
      events: phaseEvents,
      telemetry: this.fsm.lastSnapshot,
      oooi: this.fsm.oooi,
      flightTimeMs: this.fsm.flightTimeMs,
      telemetryLost: this.fsm.telemetryLost,
    });
    return {
      outbound: out.outbound,
      phase: this.fsm.phase,
      events: [...phaseEvents, ...out.events],
    };
  }
}

function engineOptions(o: CoreOptions) {
  return {
    ofp: o.ofp,
    scenarios: o.scenarios,
    seed: o.seed ?? `${o.ofp.callsign}/${o.ofp.source.requestId}`,
    ...(o.profile === undefined ? {} : { profile: o.profile }),
    ...(o.station === undefined ? {} : { station: o.station }),
    ...(o.sessionFired === undefined ? {} : { sessionFired: o.sessionFired }),
  };
}
