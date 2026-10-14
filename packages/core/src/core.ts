import {
  type AtcEvent,
  ROPS_CALLSIGN,
  type RopsOptions,
  type RopsState,
  RopsStation,
} from './atc/rops.js';
import type { ExtDataUpdate, ExtState } from './ext/data.js';
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
  DEFAULT_STATION,
  type OutboundMessage,
  ScenarioEngine,
  type ScenarioEngineState,
  type ScenarioEvent,
  stationCallsign,
} from './scenario/engine.js';
import type { Value } from './scenario/expr.js';
import type { PilotMessage } from './scenario/pilot.js';
import type { SimCommand } from './sim/commands.js';
import type { TelemetrySnapshot } from './telemetry/types.js';

/**
 * The core contract of docs/03 "Ядро: контракт": `tick(input) → output`, state inside,
 * serializable. Wires the phase machine to the scenario engine. Pilot telexes (`inbound`) go
 * to the engine (T12).
 */

export interface CoreInput {
  /** From the injected Clock, epoch ms UTC. */
  readonly now: number;
  /** Latest snapshot, or null when none arrived since the last tick. */
  readonly telemetry: TelemetrySnapshot | null;
  /** Messages from the aircraft since the last tick, oldest first (T12). */
  readonly inbound?: readonly PilotMessage[];
  /** External data fetched since the last tick (T13, `ext/data.ts`). */
  readonly data?: ExtDataUpdate;
  /** Scenario ids the user starts by hand ("run now"): see `ScenarioEngine`. */
  readonly force?: readonly string[];
}

/** Everything a tick reports: phase, scenario and ATC (T23) events. */
export type CoreEvent = PhaseEvent | ScenarioEvent | AtcEvent;

export interface CoreOutput {
  readonly outbound: readonly OutboundMessage[];
  /**
   * Commands to the simulator (T21, `sim/commands.ts`), in order; not paced by `minGapMs`.
   * Produced by `vdgs` steps (T22).
   */
  readonly commands: readonly SimCommand[];
  readonly phase: FlightPhase;
  readonly events: readonly CoreEvent[];
  /**
   * ATC station callsigns the transport should poll now (T23 ROPS): an ATC station waits for
   * the aircraft's logon, so it is polled before it sent anything. Empty without ROPS.
   */
  readonly listen: readonly string[];
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
  /** `REQ WX` wait for fetched weather, ms (T13); 0 = no live data source. */
  readonly dataWaitMs?: number;
  /** Test hook, see `ScenarioEngineOptions.syntheticConnections` (T43). */
  readonly syntheticConnections?: boolean;
  /** Generator of person names, see `ScenarioEngineOptions.namesVersion` (T43); default 2. */
  readonly namesVersion?: 1 | 2;
  /** `flags.*` left by earlier flights (T14); read back with {@link AcarsCore.flags}. */
  readonly flags?: Readonly<Record<string, Value>>;
  /**
   * Minimum clock time between two outgoing telexes, ms (default 0 = none). Aircraft poll
   * Hoppie about once a minute, so messages closer together arrive as a bunch. Messages wait
   * in the outbox; answers to the pilot go first.
   */
  readonly minGapMs?: number;
  /** ROPS ATC station (T23); absent = off. */
  readonly rops?: RopsOptions;
}

export interface CoreState {
  readonly v: 1;
  readonly phase: PhaseMachineState;
  readonly engine: ScenarioEngineState;
  /** Telexes waiting for the gap (`minGapMs`); absent in states saved before it. */
  readonly outbox?: OutboxState;
  /** ROPS station (T23); absent in states saved before it or without ROPS. */
  readonly rops?: RopsState;
}

export interface OutboxState {
  readonly queue: readonly OutboundMessage[];
  /** Clock time of the last telex let out. */
  readonly lastAt: number | null;
}

export class AcarsCore {
  private queue: OutboundMessage[] = [];
  private lastAt: number | null = null;
  private readonly gapMs: number;
  /** The airline's station callsign: messages to it go to the scenarios. */
  private readonly airline: string;

  private constructor(
    private readonly fsm: PhaseMachine,
    private readonly engine: ScenarioEngine,
    options: CoreOptions,
    private readonly rops: RopsStation | null,
  ) {
    this.gapMs = options.minGapMs ?? 0;
    if (!(this.gapMs >= 0)) throw new RangeError('minGapMs must be >= 0');
    this.airline = stationCallsign(options.station ?? DEFAULT_STATION, options.ofp);
  }

  static create(options: CoreOptions): AcarsCore {
    const fsm = new PhaseMachine({
      ofp: options.ofp,
      ...(options.phaseConfig === undefined ? {} : { config: options.phaseConfig }),
    });
    return new AcarsCore(
      fsm,
      new ScenarioEngine(engineOptions(options)),
      options,
      ropsOf(options, undefined),
    );
  }

  /** Telexes waiting for the gap between messages. */
  get queued(): number {
    return this.queue.length;
  }

  static fromState(state: CoreState, options: CoreOptions): AcarsCore {
    if (state.v !== 1) throw new Error(`unsupported CoreState version ${String(state.v)}`);
    const core = new AcarsCore(
      PhaseMachine.fromState(state.phase, options.phaseConfig),
      ScenarioEngine.fromState(state.engine, engineOptions(options)),
      options,
      ropsOf(options, state.rops),
    );
    if (state.outbox !== undefined) {
      const copy = JSON.parse(JSON.stringify(state.outbox)) as OutboxState;
      core.queue = [...copy.queue];
      core.lastAt = copy.lastAt;
    }
    return core;
  }

  get phase(): FlightPhase {
    return this.fsm.phase;
  }

  get sessionFired(): readonly string[] {
    return this.engine.sessionFired;
  }

  /** Late-start delay in ms (docs/05), null before the first tick. */
  get delayMs(): number | null {
    return this.engine.delayMs;
  }

  /** `flags.*` (T14) to hand to the next flight. */
  get flags(): Readonly<Record<string, Value>> {
    return this.engine.flags;
  }

  /** The ROPS station (T23): where to log on, where the aircraft is logged on; null = off. */
  get atc(): {
    readonly station: string | null;
    readonly connected: string | null;
    readonly dcl: string | null;
  } | null {
    return this.rops === null
      ? null
      : { station: this.rops.station, connected: this.rops.connected, dcl: this.rops.dclStation };
  }

  /** External data the core holds (T13). */
  get ext(): ExtState {
    return this.engine.ext;
  }

  getState(): CoreState {
    return {
      v: 1,
      phase: this.fsm.getState(),
      engine: this.engine.getState(),
      outbox: JSON.parse(JSON.stringify({ queue: this.queue, lastAt: this.lastAt })) as OutboxState,
      ...(this.rops === null ? {} : { rops: this.rops.getState() }),
    };
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
    return this.run(
      input.now,
      [
        ...(input.telemetry === null ? [] : this.fsm.push(input.telemetry, input.now)),
        ...this.fsm.tick(input.now),
      ],
      input.inbound ?? [],
      input.data,
      input.force,
    );
  }

  private run(
    now: number,
    phaseEvents: readonly PhaseEvent[],
    inbound: readonly PilotMessage[] = [],
    data?: ExtDataUpdate,
    force?: readonly string[],
  ): CoreOutput {
    // Messages to a ROPS station go to it, the rest to the airline (T23).
    const toAtc = (m: PilotMessage) =>
      this.rops !== null && m.to !== undefined && m.to !== this.airline && ROPS_CALLSIGN.test(m.to);
    const out = this.engine.tick({
      now,
      phase: this.fsm.phase,
      events: phaseEvents,
      telemetry: this.fsm.lastSnapshot,
      oooi: this.fsm.oooi,
      flightTimeMs: this.fsm.flightTimeMs,
      telemetryLost: this.fsm.telemetryLost,
      inbound: inbound.filter((m) => !toAtc(m)),
      ...(data === undefined ? {} : { data }),
      ...(force === undefined || force.length === 0 ? {} : { force }),
    });
    // ATC uplinks are not airline telexes: they skip the outbox gap.
    const atc = this.rops?.tick({
      now,
      phase: this.fsm.phase,
      telemetry: this.fsm.lastSnapshot,
      inbound: inbound.filter(toAtc),
      ext: this.engine.ext,
    }) ?? { outbound: [], events: [] };
    return {
      outbound: [...atc.outbound, ...this.pace(now, out.outbound)],
      commands: out.commands,
      phase: this.fsm.phase,
      events: [...phaseEvents, ...out.events, ...atc.events] as CoreEvent[],
      listen: this.rops?.listen ?? [],
    };
  }

  /**
   * The outbox: with `minGapMs`, at most one telex per gap of clock time leaves; answers to the
   * pilot queue before the others (in their own order). A telex leaves stamped with that time.
   */
  private pace(now: number, fresh: readonly OutboundMessage[]): readonly OutboundMessage[] {
    if (this.gapMs === 0 && this.queue.length === 0) return fresh;
    for (const m of fresh) {
      if (!m.toPilot) this.queue.push(m);
      else {
        const i = this.queue.findIndex((q) => !q.toPilot);
        this.queue.splice(i < 0 ? this.queue.length : i, 0, m);
      }
    }
    const out: OutboundMessage[] = [];
    while (this.queue.length > 0 && (this.lastAt === null || now - this.lastAt >= this.gapMs)) {
      const m = this.queue.shift() as OutboundMessage;
      out.push({ ...m, t: now });
      this.lastAt = now;
      if (this.gapMs > 0) break;
    }
    return out;
  }
}

function ropsOf(o: CoreOptions, state: RopsState | undefined): RopsStation | null {
  if (o.rops?.enabled !== true) return null;
  const seed = o.seed ?? `${o.ofp.callsign}/${o.ofp.source.requestId}`;
  return new RopsStation(
    o.ofp,
    o.rops,
    { seed, ...(o.profile === undefined ? {} : { profile: o.profile }) },
    state,
  );
}

function engineOptions(o: CoreOptions) {
  return {
    ofp: o.ofp,
    scenarios: o.scenarios,
    seed: o.seed ?? `${o.ofp.callsign}/${o.ofp.source.requestId}`,
    ...(o.profile === undefined ? {} : { profile: o.profile }),
    ...(o.station === undefined ? {} : { station: o.station }),
    ...(o.sessionFired === undefined ? {} : { sessionFired: o.sessionFired }),
    ...(o.dataWaitMs === undefined ? {} : { dataWaitMs: o.dataWaitMs }),
    ...(o.flags === undefined ? {} : { flags: o.flags }),
    ...(o.syntheticConnections === undefined
      ? {}
      : { syntheticConnections: o.syntheticConnections }),
    ...(o.namesVersion === undefined ? {} : { namesVersion: o.namesVersion }),
  };
}
