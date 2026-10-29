// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import {
  type AtcEvent,
  XATC_CALLSIGN,
  type XatcOptions,
  type XatcState,
  XatcStation,
} from './atc/xatc.js';
import { type DatalinkState, LinkChannel, type LinkView } from './datalink/link.js';
import type { ExtDataUpdate, ExtState } from './ext/data.js';
import { linkHeaderLines, withLinkHeader } from './format/formatter.js';
import { DEFAULT_PROFILE, type DisplayProfile } from './format/profile.js';
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
  type AwaitedReply,
  DEFAULT_STATION,
  type OutboundMessage,
  ScenarioEngine,
  type ScenarioEngineOptions,
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
   * ATC station callsigns the transport should poll now (T23 XATC): an ATC station waits for
   * the aircraft's logon, so it is polled before it sent anything. Empty without XATC.
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
  /** Test hook, see `ScenarioEngineOptions.runwayNeeds` (T50). */
  readonly runwayNeeds?: ScenarioEngineOptions['runwayNeeds'];
  /** Generator of person names, see `ScenarioEngineOptions.namesVersion` (T43); default 2. */
  readonly namesVersion?: 1 | 2;
  /** Next leg, see `ScenarioEngineOptions.nextLegVersion` (T53, T55); default 2. */
  readonly nextLegVersion?: 1 | 2 | 3;
  /** The user's hub airport (T53), see `ScenarioEngineOptions.hub`. */
  readonly hub?: string;
  /** Start close to the departure, see `ScenarioEngineOptions.lateStartVersion`; default 1. */
  readonly lateStartVersion?: 1 | 2 | 3;
  /** `flags.*` left by earlier flights (T14); read back with {@link AcarsCore.flags}. */
  readonly flags?: Readonly<Record<string, Value>>;
  /**
   * Minimum clock time between two outgoing telexes, ms (default 0 = none). Aircraft poll
   * Hoppie about once a minute, so messages closer together arrive as a bunch. Messages wait
   * in the outbox; answers to the pilot go first.
   */
  readonly minGapMs?: number;
  /** XATC station (T23); absent = off. */
  readonly xatc?: XatcOptions;
  /**
   * Simulation of the data link (T31, `datalink/link.ts`): each outgoing message waits for the
   * delay of the VHF station or satellite in reach, or for any link at all. `satcom`: the
   * aircraft has SATCOM. Absent = messages leave at once, as before.
   */
  readonly datalink?: {
    readonly satcom: boolean;
    /** The aircraft's 24-bit ICAO address, six hex digits (T32); absent = no AES/GES header. */
    readonly icaoHex?: string;
    /** Put the AES/GES header in front of the message text (T32); default off. */
    readonly headerInText?: boolean;
  };
}

export interface CoreState {
  readonly v: 1;
  readonly phase: PhaseMachineState;
  readonly engine: ScenarioEngineState;
  /** Telexes waiting for the gap (`minGapMs`); absent in states saved before it. */
  readonly outbox?: OutboxState;
  /** XATC station (T23); absent in states saved before it or without XATC. */
  readonly xatc?: XatcState;
  /** The same, in states saved before T58 (the station was called ROPS); `xatc` wins. */
  readonly rops?: XatcState;
  /** Data link (T31); absent in states saved before it or without the link simulation. */
  readonly link?: DatalinkState;
  /** Emergency chains to start on the next tick (T47); absent in states saved before T64 = none. */
  readonly emergencies?: readonly string[];
}

export interface OutboxState {
  readonly queue: readonly OutboundMessage[];
  /** Clock time of the last telex let out. */
  readonly lastAt: number | null;
}

export class AcarsCore {
  private queue: OutboundMessage[] = [];
  private lastAt: number | null = null;
  /** Scenarios to start by hand on the next tick (T47: the emergency chain after MAYDAY/PAN). */
  private emergencies: string[] = [];
  private readonly gapMs: number;
  /** The airline's station callsign: messages to it go to the scenarios. */
  private readonly airline: string;
  /** T32: the AES/GES header is put into the message text. */
  private readonly headerInText: boolean;
  private readonly profile: DisplayProfile;

  private constructor(
    private readonly fsm: PhaseMachine,
    private readonly engine: ScenarioEngine,
    options: CoreOptions,
    private readonly xatc: XatcStation | null,
    private link: LinkChannel | null,
  ) {
    this.headerInText = options.datalink?.headerInText === true;
    this.profile = options.profile ?? DEFAULT_PROFILE;
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
      xatcOf(options, undefined),
      linkOf(options, undefined),
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
      xatcOf(options, state.xatc ?? state.rops),
      linkOf(options, state.link),
    );
    if (state.outbox !== undefined) {
      const copy = JSON.parse(JSON.stringify(state.outbox)) as OutboxState;
      core.queue = [...copy.queue];
      core.lastAt = copy.lastAt;
    }
    core.emergencies = [...(state.emergencies ?? [])];
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

  /** The XATC station (T23): where to log on, where the aircraft is logged on; null = off. */
  get atc(): {
    readonly station: string | null;
    readonly connected: string | null;
    readonly dcl: string | null;
  } | null {
    return this.xatc === null
      ? null
      : { station: this.xatc.station, connected: this.xatc.connected, dcl: this.xatc.dclStation };
  }

  /**
   * Scenarios waiting for the pilot's answer (T57), with the flight time left until the default
   * answer applies (ms, not below 0). For the app only; the state already holds them.
   */
  get pendingReplies(): readonly (AwaitedReply & { readonly leftMs: number })[] {
    const now = this.fsm.flightTimeMs;
    return this.engine.pendingReplies.map((r) => ({
      ...r,
      leftMs: Math.max(0, r.untilFlightMs - now),
    }));
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
      ...(this.xatc === null ? {} : { xatc: this.xatc.getState() }),
      ...(this.link === null ? {} : { link: this.link.getState() }),
      ...(this.emergencies.length === 0 ? {} : { emergencies: [...this.emergencies] }),
    };
  }

  /** The data link now and what waits on it (T31); null without the link simulation. */
  get linkView(): LinkView | null {
    return this.link?.view ?? null;
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
    // Messages to a XATC station go to it, the rest to the airline (T23).
    const toAtc = (m: PilotMessage) =>
      this.xatc !== null && m.to !== undefined && m.to !== this.airline && XATC_CALLSIGN.test(m.to);
    const forceAll = [...this.emergencies, ...(force ?? [])];
    this.emergencies = [];
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
      ...(forceAll.length === 0 ? {} : { force: forceAll }),
    });
    // ATC uplinks are not airline telexes: they skip the outbox gap.
    const atc = this.xatc?.tick({
      now,
      phase: this.fsm.phase,
      telemetry: this.fsm.lastSnapshot,
      inbound: inbound.filter(toAtc),
      ext: this.engine.ext,
      divert: this.engine.divert,
      hold: this.engine.hold,
    }) ?? { outbound: [], events: [] };
    // MAYDAY / PAN to XATC: the airline's chain starts on the next tick (T47).
    for (const e of atc.events) {
      if (e.type !== 'ATC_EMERGENCY') continue;
      const id = e.kind === 'MAYDAY' ? 'emergency_mayday' : 'emergency_pan';
      if (this.engine.has(id) && !this.emergencies.includes(id)) this.emergencies.push(id);
    }
    const outbound = [...atc.outbound, ...this.pace(now, out.outbound)];
    return {
      outbound: this.link === null ? outbound : this.throughLink(now, outbound),
      commands: out.commands,
      phase: this.fsm.phase,
      events: [...phaseEvents, ...out.events, ...atc.events] as CoreEvent[],
      listen: this.xatc?.listen ?? [],
    };
  }

  /** T31: the messages of this tick enter the link; those whose delay is over leave. */
  private throughLink(now: number, fresh: readonly OutboundMessage[]): OutboundMessage[] {
    const tm = this.fsm.lastSnapshot;
    const pos =
      tm === null ? null : { lat: tm.lat, lon: tm.lon, altFt: tm.altFt, onGround: tm.onGround };
    const out = (this.link as LinkChannel).process(now, pos, this.engine.ext.vhf ?? [], fresh);
    if (!this.headerInText) return out;
    // The header goes through the formatter like any text (invariant 9).
    return out.map((m) => {
      const tokens = m.link?.header;
      if (m.kind !== 'telex' || tokens === undefined) return m;
      const lines = linkHeaderLines(tokens, this.profile);
      return { ...m, message: withLinkHeader(m.message, lines, this.profile) };
    });
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

function linkOf(o: CoreOptions, state: DatalinkState | undefined): LinkChannel | null {
  if (o.datalink === undefined) return null;
  const seed = o.seed ?? `${o.ofp.callsign}/${o.ofp.source.requestId}`;
  return new LinkChannel(o.datalink.satcom, seed, state, {
    ...(o.datalink.icaoHex === undefined ? {} : { icaoHex: o.datalink.icaoHex }),
    reg: o.ofp.aircraft.reg,
  });
}

function xatcOf(o: CoreOptions, state: XatcState | undefined): XatcStation | null {
  if (o.xatc?.enabled !== true) return null;
  const seed = o.seed ?? `${o.ofp.callsign}/${o.ofp.source.requestId}`;
  return new XatcStation(
    o.ofp,
    o.xatc,
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
    ...(o.runwayNeeds === undefined ? {} : { runwayNeeds: o.runwayNeeds }),
    ...(o.syntheticConnections === undefined
      ? {}
      : { syntheticConnections: o.syntheticConnections }),
    ...(o.namesVersion === undefined ? {} : { namesVersion: o.namesVersion }),
    ...(o.nextLegVersion === undefined ? {} : { nextLegVersion: o.nextLegVersion }),
    ...(o.hub === undefined ? {} : { hub: o.hub }),
    ...(o.lateStartVersion === undefined ? {} : { lateStartVersion: o.lateStartVersion }),
  };
}
