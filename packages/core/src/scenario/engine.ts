import type { CpdlcHeader } from '../atc/cpdlc.js';
import {
  ATC_MAX_AGE_MS,
  applyExtData,
  EMPTY_EXT,
  type ExtDataUpdate,
  type ExtState,
  liveWx,
  type ParkingStand,
  RoutePolyline,
} from '../ext/data.js';
import { FormatError, type FormattedMessage, formatMessage } from '../format/formatter.js';
import { DEFAULT_PROFILE, type DisplayProfile } from '../format/profile.js';
import { distanceNm } from '../geo/geo.js';
import type { Ofp } from '../ofp/types.js';
import { FLIGHT_PHASES, type FlightPhase, type OooiKind, type PhaseEvent } from '../phase/fsm.js';
import { createRng, type Rng, type RngState, rngFromState } from '../random/rng.js';
import type { SimCommand } from '../sim/commands.js';
import { buildVdgsMessage, type VdgsDisplay, VdgsError, type VdgsLine } from '../sim/vdgs.js';
import type { TelemetrySnapshot } from '../telemetry/types.js';
import type { CompiledScenario, CompiledStep } from './compile.js';
import {
  buildContext,
  type FuelTrack,
  RouteGeometry,
  type RunVariable,
  type ScenarioContext,
} from './context.js';
import { type DelayPart, LATE_START_CODE, reasonCode, SLOT_CODE } from './delay-codes.js';
import type { Lookup, Value } from './expr.js';
import { pruneExpiredFlags } from './flags-expiry.js';
import { buildIrregularData, type IrregularData, reassignedGate } from './irregular-data.js';
import { buildFlightData, type FlightData } from './ops-data.js';
import {
  normalizePilotText,
  type ParsedCommand,
  type PilotMessage,
  parseCommand,
} from './pilot.js';
import { TemplateError } from './template.js';
import type { PilotCommand, TimeRef } from './types.js';

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
 *
 * Late start (docs/05 "Поздний старт"): on the first tick the engine checks how much time is
 * left before `sched_out`. If less than `lateStartLeadMin`, the flight counts as delayed by
 * the difference (rounded up to 5 min): `sched_*`/`est_*` time triggers, `ofp.est_*`, the
 * CTOT and the next leg move by the delay, so the pre-departure documents come in their
 * order and spacing instead of all at once. `ofp.sched_*` (STD/STA) stay as published.
 *
 * Two-way (T12, docs/05 "Исполнение" 5): pilot telexes (`inbound`) are handled first on a
 * tick. A message whose first word is an option of a waiting `wait: reply` answers it (the
 * oldest run first); anything else is parsed as a pilot command, which the engine applies
 * (`DELAY` adds to the delay, `DIVERT` records the airport) and which starts the scenarios
 * with `on: command` for it. Every command gets an answer: unknown or impossible ones get the
 * engine's `UNABLE …`, known ones without an enabled scenario a `RCVD …`. A reply times out
 * after its minutes of flight time (as `wait.minutes`) with the default answer. While
 * telemetry is lost, pilot messages wait in the state.
 *
 * External data (T13): `input.data` updates (METAR/TAF, VATSIM, EONET, OSM stands) are kept
 * in the state and feed `wx.*` / `ext.*`. With stands of the destination the arrival gate is
 * drawn from them (`${seed}/#stands`) instead of the placeholder; once a message showed the
 * gate, later stand updates are ignored so it never changes. `REQ WX` for an airport without
 * fresh weather waits up to `dataWaitMs` for the app to fetch it (event `DATA_REQUEST`).
 *
 * `set` (T14): `flags.<name>` is airline memory — read by any scenario as `flags.<name>`, kept
 * in the state and handed over to the next flight (`flags` option / getter); `flight.divert`
 * and `ops.arr_gate` change the diversion and the arrival gate of this flight. Every
 * assignment is an event (`SET`), one that cannot apply (a diversion on the ground) too.
 *
 * Forced start (`input.force`, the user's "run now"): the scenario starts on this tick without
 * its trigger, probability, cooldown and excludes, but only when its conditions hold (they
 * keep its messages meaningful) and it is not running. The outcome is a `FORCED` event.
 * While telemetry is lost the request waits in the state like a pilot message.
 */

export interface OutboundMessage {
  readonly scenarioId: string;
  /** Station callsign (sender). */
  readonly from: string;
  /** Aircraft callsign (recipient). */
  readonly to: string;
  /** `cpdlc`: an ATC uplink of the ROPS station (T23), sent as a Hoppie `cpdlc` packet. */
  readonly kind: 'telex' | 'cpdlc';
  /** Packet header of a `cpdlc` message (`atc/cpdlc.ts`). */
  readonly cpdlc?: CpdlcHeader;
  readonly message: FormattedMessage;
  readonly t: number;
  /** Sent while handling a pilot message (an answer, a command reply): goes first in the outbox. */
  readonly toPilot: boolean;
}

/**
 * How a pilot telex was handled: the answer to a waiting `wait: reply` (`scenarioId`), a
 * command (`command`), a known command that cannot be done (`invalid`, `detail` = why),
 * not understood (`unknown`), or not from the pilot / not a telex / empty (`ignored`).
 */
export type PilotMessageResult = 'reply' | 'command' | 'invalid' | 'unknown' | 'ignored';

export type ScenarioEvent =
  | {
      readonly type: 'PILOT_MESSAGE';
      readonly t: number;
      /** Normalized text (`normalizePilotText`). */
      readonly text: string;
      readonly result: PilotMessageResult;
      readonly scenarioId: string | null;
      readonly command: PilotCommand | null;
      readonly detail: string | null;
    }
  | {
      readonly type: 'REPLY_EXPECTED';
      readonly id: string;
      readonly t: number;
      readonly options: readonly string[];
      /** Flight time until the default answer applies. */
      readonly timeoutMs: number;
    }
  | {
      /** The app should fetch weather for `icao` and pass it in `CoreInput.data` (T13). */
      readonly type: 'DATA_REQUEST';
      readonly kind: 'wx';
      readonly icao: string;
      readonly t: number;
    }
  | {
      readonly type: 'REPLY_TIMEOUT';
      readonly id: string;
      readonly t: number;
      /** The default answer taken. */
      readonly option: string;
    }
  | {
      /** A `set` assignment (T14); `applied: false` when the value was not allowed. */
      readonly type: 'SET';
      readonly id: string;
      readonly t: number;
      readonly name: string;
      readonly value: Value;
      readonly applied: boolean;
    }
  | {
      /** Outcome of a forced start (`input.force`). `detail`: the condition that failed. */
      readonly type: 'FORCED';
      readonly id: string;
      readonly t: number;
      readonly result: 'started' | 'conditions' | 'running' | 'unknown';
      readonly detail: string | null;
    }
  | {
      /** A `wait: until` ended (T39): the condition held, or its time ran out. */
      readonly type: 'WAIT_UNTIL';
      readonly id: string;
      readonly t: number;
      readonly result: 'MET' | 'TIMEOUT';
    }
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
  /** Messages from the aircraft since the last tick, oldest first. */
  readonly inbound?: readonly PilotMessage[];
  /** External data fetched since the last tick (T13). */
  readonly data?: ExtDataUpdate;
  /** Scenario ids the user starts by hand. */
  readonly force?: readonly string[];
}

export interface EngineTickOutput {
  readonly outbound: readonly OutboundMessage[];
  /** Commands to the simulator from `vdgs` steps (T22), in order. */
  readonly commands: readonly SimCommand[];
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
  /** Minutes before `sched_out` a flight must start not to count as delayed. Default 35. */
  readonly lateStartLeadMin?: number;
  /**
   * Generator of `{name:…}` (T43, `names.ts`): 1 = surnames by the origin's ICAO prefix (as
   * recorded before T43), 2 = by the airline's country (default).
   */
  readonly namesVersion?: 1 | 2;
  /**
   * How long `REQ WX` waits for weather the app fetches on `DATA_REQUEST`, ms of clock time.
   * 0 (default) = answer at once with what the core has (no live data source).
   */
  readonly dataWaitMs?: number;
  /**
   * Test hook (T43): offer the synthetic onward flight of `irr.connect_*` as if a source had
   * confirmed it. Off by default: without a confirmed flight `irr.connect_flight` is null and
   * `short_connection` does not start (no invented flights).
   */
  readonly syntheticConnections?: boolean;
  /** `flags.*` left by earlier flights (T14). */
  readonly flags?: Readonly<Record<string, Value>>;
}

interface ScenarioState {
  candidate: boolean;
  starts: number;
  lastStartMs: number | null;
  rng: RngState;
}

interface Run {
  readonly id: string;
  /** Index into the compiled steps (a flat program, see `CompiledStep`). */
  step: number;
  /** Flight time to resume at (`wait.minutes`). */
  untilFlightMs: number | null;
  untilPhase: FlightPhase | null;
  /** Waiting for a pilot answer (`wait: reply`). */
  reply: { options: string[]; default: string; untilFlightMs: number } | null;
  /** Waiting for a condition (`wait: until`, T39): the step and the flight time to give up at. */
  until: { step: number; deadlineMs: number } | null;
  /** `reply.*` and `cmd.*` of this run. */
  vars: Partial<Record<RunVariable, Value>>;
}

interface Sent {
  readonly t: number;
  readonly message: FormattedMessage;
}

export interface ScenarioEngineState {
  readonly v: 1;
  readonly scenarios: Readonly<Record<string, Readonly<ScenarioState>>>;
  readonly runs: readonly Readonly<Run>[];
  readonly sessionFired: readonly string[];
  /** Late-start delay plus pilot `DELAY`s, ms; null until the first tick. */
  readonly delayMs: number | null;
  /** Last message of each scenario in this flight (`resend`, `flight.sent`). */
  readonly sent: Readonly<Record<string, Sent>>;
  /** Diversion airport from the pilot's `DIVERT`. */
  readonly divert: string | null;
  /** Holding announced by a scenario (`flight.hold`, T48); absent in older states. */
  readonly hold?: { readonly since: number; readonly min: number } | null;
  /** Pilot messages that arrived while telemetry was lost; handled when it is back. */
  readonly inbox: readonly PilotMessage[];
  /** External data (T13). */
  readonly ext: ExtState;
  /** `REQ WX` waiting for weather (until clock time `until`). */
  readonly pendingWx: readonly PendingWx[];
  /** `flags.*` (T14): from earlier flights, changed by `set`. */
  readonly flags: Readonly<Record<string, Value>>;
  /** Arrival gate set by a scenario (`set: { ops.arr_gate }`), T14. */
  readonly gate: string | null;
  /** Forced starts that arrived while telemetry was lost. */
  readonly forced: readonly string[];
  /** Fuel seen before OUT (T43, `fuel_slip`); absent in older states. */
  readonly fuel?: FuelTrack | null;
  /** Part of the delay a `set: flight.delay_min` added (the slot), ms; absent in older states. */
  readonly delayRaisedMs?: number;
  /** What the delay is made of, with IATA delay codes (T43); absent in older states. */
  readonly delayParts?: readonly DelayPart[];
}

interface PendingWx {
  readonly message: PilotMessage;
  readonly icao: string;
  readonly until: number;
}

/** Scenario id of the engine's own answers (unknown command, nobody to handle it). */
export const OPS_REPLY_ID = '#ops';

export const DEFAULT_STATION = 'OPS{flight}';
export const DEFAULT_LATE_START_LEAD_MIN = 35;
const DELAY_STEP_MS = 5 * 60_000;
/** Fuel readings within this of each other are one level (docs/04 `fuelStable`). */
const FUEL_TOLERANCE_KG = 100;
/** Weather fetched longer ago than this is refreshed for `REQ WX` (when the app fetches). */
const WX_FRESH_MS = 15 * 60_000;
/** Limits of the airline memory (T14). */
const MAX_FLAGS = 64;
const MAX_FLAG_TEXT = 80;

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
  /** The OFP the templates see: `est_*` moved by the late-start delay. */
  private ctxOfp: Ofp;
  private readonly route: RouteGeometry;
  private readonly polyline: RoutePolyline;
  private readonly dataWaitMs: number;
  private readonly syntheticConnections: boolean;
  private readonly seed: number | string;
  private readonly leadMs: number;
  /** Derived from OFP + seed (+ delay), so not part of the serialized state. */
  private data: FlightData;
  /** Irregular-scenario data (T14), from the published OFP and the seed. */
  private readonly irr: IrregularData;
  private newGate: string | null = null;
  private readonly profile: DisplayProfile;
  private readonly from: string;
  private readonly byId: ReadonlyMap<string, CompiledScenario>;
  /** Start order for one tick: priority desc, then id. */
  private readonly ordered: readonly CompiledScenario[];
  private readonly rngs = new Map<string, Rng>();
  private readonly namesVersion: 1 | 2;
  private st: {
    scenarios: Record<string, ScenarioState>;
    runs: Run[];
    sessionFired: string[];
    delayMs: number | null;
    sent: Record<string, Sent>;
    divert: string | null;
    hold: { since: number; min: number } | null;
    inbox: PilotMessage[];
    ext: ExtState;
    pendingWx: PendingWx[];
    flags: Record<string, Value>;
    gate: string | null;
    forced: string[];
    fuel: FuelTrack | null;
    delayRaisedMs: number;
    delayParts: DelayPart[];
  };
  /** Context of the current tick; rebuilt when a command or a send changes it. */
  private ctx: ScenarioContext | null = null;
  /** Inside `receive`: messages are answers to the pilot. */
  private answering = false;
  private tickInput: EngineTickInput | null = null;
  /** Commands of the tick in progress (`vdgs` steps). */
  private commands: SimCommand[] = [];

  constructor(options: ScenarioEngineOptions) {
    this.ofp = options.ofp;
    this.ctxOfp = options.ofp;
    this.route = new RouteGeometry(options.ofp);
    this.polyline = new RoutePolyline(options.ofp);
    this.dataWaitMs = options.dataWaitMs ?? 0;
    this.syntheticConnections = options.syntheticConnections ?? false;
    if (!(this.dataWaitMs >= 0)) throw new RangeError('dataWaitMs must be ≥ 0');
    this.seed = options.seed;
    this.namesVersion = options.namesVersion ?? 2;
    this.leadMs = (options.lateStartLeadMin ?? DEFAULT_LATE_START_LEAD_MIN) * 60_000;
    if (!(this.leadMs >= 0)) throw new RangeError('lateStartLeadMin must be ≥ 0');
    this.data = buildFlightData(options.ofp, options.seed);
    this.irr = buildIrregularData(options.ofp, options.seed, this.data.ops.transferPax);
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
    this.st = {
      scenarios,
      runs: [],
      sessionFired: [...(options.sessionFired ?? [])],
      delayMs: null,
      sent: {},
      divert: null,
      hold: null,
      inbox: [],
      ext: EMPTY_EXT,
      pendingWx: [],
      flags: pruneExpiredFlags(options.flags ?? {}, options.ofp.times.schedOutMs),
      gate: null,
      forced: [],
      fuel: null,
      delayRaisedMs: 0,
      delayParts: [],
    };
    this.rebuildData();
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
    // Fields added with T12 are absent in older states: defaults.
    e.st.runs = copy.runs
      .filter((r) => e.byId.has(r.id))
      .map((r) => ({ ...r, reply: r.reply ?? null, until: r.until ?? null, vars: r.vars ?? {} }));
    e.st.sessionFired = [...copy.sessionFired];
    e.st.sent = { ...(copy.sent ?? {}) };
    e.st.divert = copy.divert ?? null;
    e.st.hold = copy.hold ?? null;
    e.st.inbox = [...(copy.inbox ?? [])];
    // Fields added with T13.
    e.st.ext = copy.ext ?? EMPTY_EXT;
    e.st.pendingWx = [...(copy.pendingWx ?? [])];
    // Fields added with T14.
    e.st.flags = { ...(copy.flags ?? options.flags ?? {}) };
    e.st.gate = copy.gate ?? null;
    e.st.forced = [...(copy.forced ?? [])];
    // Fields added with T43.
    e.st.fuel = copy.fuel ?? null;
    e.st.delayRaisedMs = copy.delayRaisedMs ?? 0;
    e.st.delayParts = [...(copy.delayParts ?? [])];
    // States saved before the late-start rule have no `delayMs`: no delay, as before.
    e.setDelay(copy.delayMs === undefined ? 0 : copy.delayMs);
    return e;
  }

  getState(): ScenarioEngineState {
    for (const [id, rng] of this.rngs)
      (this.st.scenarios[id] as ScenarioState).rng = rng.getState();
    return JSON.parse(JSON.stringify({ v: 1, ...this.st })) as ScenarioEngineState;
  }

  /** Whether a scenario with this id is loaded (enabled). */
  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Diversion airport (a scenario's or the pilot's), null = none (T48: the ROPS station reads it). */
  get divert(): string | null {
    return this.st.divert;
  }

  /** Holding the airline announced (`flight.hold`, T48), null = none. */
  get hold(): { readonly since: number; readonly min: number } | null {
    return this.st.hold === null ? null : { ...this.st.hold };
  }

  /** Ids started in this session (persist them to honour `per_session` across flights). */
  get sessionFired(): readonly string[] {
    return [...this.st.sessionFired];
  }

  get running(): readonly string[] {
    return this.st.runs.map((r) => r.id);
  }

  /** Late-start delay in ms (0 = on time), null before the first tick. */
  get delayMs(): number | null {
    return this.st.delayMs;
  }

  private setDelay(delayMs: number | null): void {
    this.st.delayMs = delayMs;
    if (delayMs !== null && delayMs !== 0) this.ctxOfp = delayedOfp(this.ofp, delayMs, false);
    this.rebuildData();
  }

  /** Ops data from the (delayed) OFP and seed; the gate from the OSM stands when known. */
  private rebuildData(): void {
    const delay = this.st.delayMs ?? 0;
    const at = (ms: number) => (ms === 0 ? this.ofp : delayedOfp(this.ofp, ms, true));
    const built = buildFlightData(at(delay), this.seed);
    const raised = this.st.delayRaisedMs;
    const data =
      raised === 0
        ? built
        : {
            ...built,
            ops: { ...built.ops, ctot: buildFlightData(at(delay - raised), this.seed).ops.ctot },
          };
    const stands = this.st.ext.stands;
    // No stands, no gate (T43): nothing is invented.
    const picked = stands === null ? null : pickStandInfo(stands, this.seed);
    const planned = picked?.ref ?? null;
    this.newGate = reassignedGate(this.st.gate ?? planned, stands, this.seed);
    const ref = this.st.gate ?? planned;
    const kind =
      ref === null
        ? null
        : ((stands ?? []).find((x) => x.ref === ref)?.kind ?? picked?.kind ?? 'gate');
    this.data = { ...data, ops: { ...data.ops, arrGate: ref, gateKind: kind } };
  }

  /**
   * Fuel on board before OUT (T43): `first` is the first reading, `anchor` the current level
   * (moved when the fuel changes by more than {@link FUEL_TOLERANCE_KG}), `since` when the
   * level was reached, `changed` that a refuelling was seen at all. Stable = a change seen and
   * then unchanged for a minute (no change: the slip waits for its deadline).
   */
  private trackFuel(input: EngineTickInput): void {
    const tm = input.telemetry;
    if (tm === null || input.telemetryLost || !tm.onGround || input.oooi.OUT !== null) return;
    const f = this.st.fuel;
    if (f === null) {
      this.st.fuel = { first: tm.fuelKg, anchor: tm.fuelKg, since: input.now, changed: false };
    } else if (Math.abs(tm.fuelKg - f.anchor) > FUEL_TOLERANCE_KG) {
      this.st.fuel = { first: f.first, anchor: tm.fuelKg, since: input.now, changed: true };
    }
  }

  /** `flags.*` now (T14): hand them to the next flight. */
  get flags(): Readonly<Record<string, Value>> {
    return JSON.parse(JSON.stringify(this.st.flags)) as Record<string, Value>;
  }

  /** External data kept in the state (T13). */
  get ext(): ExtState {
    return this.st.ext;
  }

  tick(input: EngineTickInput): EngineTickOutput {
    const outbound: OutboundMessage[] = [];
    const events: ScenarioEvent[] = [];
    const commands: SimCommand[] = [];
    this.commands = commands;
    if (this.st.delayMs === null) {
      const late = input.now + this.leadMs - this.ofp.times.schedOutMs;
      this.setDelay(late > 0 ? Math.ceil(late / DELAY_STEP_MS) * DELAY_STEP_MS : 0);
      const ms = this.st.delayMs ?? 0;
      if (ms > 0) this.st.delayParts.push({ code: LATE_START_CODE, ms });
    }
    if (input.data !== undefined) {
      const before = this.st.ext.stands;
      this.st.ext = applyExtData(this.st.ext, input.data, this.ofp, this.polyline);
      if (this.st.ext.stands !== before) this.rebuildData();
    }
    this.trackFuel(input);
    const inbox = [...this.st.inbox, ...(input.inbound ?? [])];
    const forced = [...this.st.forced, ...(input.force ?? [])];
    if (input.telemetryLost) {
      this.st.inbox = inbox;
      this.st.forced = forced;
      return { outbound, commands, events };
    }
    this.st.inbox = [];
    this.st.forced = [];
    this.tickInput = input;
    this.refresh();
    try {
      // 0. `REQ WX` whose weather arrived (or that waited long enough), then new pilot
      // messages: answers to waiting scenarios, then commands.
      const due = this.st.pendingWx.filter(
        (p) => this.wxFresh(p.icao, input.now) || input.now >= p.until,
      );
      this.st.pendingWx = this.st.pendingWx.filter((p) => !due.includes(p));
      this.answering = true;
      try {
        for (const p of due) this.receive(p.message, input, outbound, events, false);
        for (const m of inbox) this.receive(m, input, outbound, events);
      } finally {
        this.answering = false;
      }

      // 1. Running scenarios.
      for (const run of [...this.st.runs]) this.advance(run, input, outbound, events);

      // 2. New candidates (`on: command` scenarios start in step 0 only).
      for (const sc of this.ordered) {
        const s = this.st.scenarios[sc.id] as ScenarioState;
        const active =
          this.triggered(sc, input, this.context) && sc.conditions.every((c) => c.test(this.look));
        const fresh = active && !s.candidate;
        s.candidate = active;
        if (fresh) this.start(sc, {}, input, outbound, events);
      }

      // 3. Forced by the user.
      for (const id of forced) this.forceStart(id, input, outbound, events);
    } finally {
      this.ctx = null;
      this.tickInput = null;
    }
    return { outbound, commands, events };
  }

  private get context(): ScenarioContext {
    return this.ctx as ScenarioContext;
  }

  private readonly look: Lookup = (path) => {
    if (path.startsWith('flags.')) return this.st.flags[path.slice(6)] ?? null;
    const ctx = this.context;
    return path in ctx ? ctx[path as keyof ScenarioContext] : undefined;
  };

  /** The shared lookup with a run's `reply.*` / `cmd.*` on top. */
  private lookFor(vars: Run['vars']): Lookup {
    return (path) => (path in vars ? vars[path as RunVariable] : this.look(path));
  }

  /** Rebuilds the tick's context (after a delay, a diversion, a first message of a scenario). */
  private refresh(): void {
    const input = this.tickInput as EngineTickInput;
    this.ctx = buildContext({
      ofp: this.ctxOfp,
      delayMs: this.st.delayMs ?? 0,
      delayParts: this.st.delayParts,
      namesVersion: this.namesVersion,
      route: this.route,
      now: input.now,
      phase: input.phase,
      telemetry: input.telemetry,
      oooi: input.oooi,
      data: this.data,
      divert: this.st.divert,
      sent: Object.keys(this.st.sent),
      ext: this.st.ext,
      polyline: this.polyline,
      seed: this.seed,
      fuel: this.st.fuel,
      irr: { ...this.irr, newGate: this.newGate, connectKnown: this.syntheticConnections },
    });
  }

  /** A start by hand: conditions only (see the class comment). */
  private forceStart(
    id: string,
    input: EngineTickInput,
    outbound: OutboundMessage[],
    events: ScenarioEvent[],
  ): void {
    const note = (
      result: 'started' | 'conditions' | 'running' | 'unknown',
      detail = null as string | null,
    ) => events.push({ type: 'FORCED', id, t: input.now, result, detail });
    const sc = this.byId.get(id);
    if (sc === undefined) return void note('unknown');
    if (this.st.runs.some((r) => r.id === id)) return void note('running');
    const failed = sc.conditions.findIndex((c) => !c.test(this.look));
    if (failed >= 0) return void note('conditions', sc.def.conditions?.[failed] ?? null);
    note('started');
    this.start(sc, {}, input, outbound, events, true);
  }

  /**
   * Cooldown, excludes, probability (all skipped when `forced`); then starts the run. True when
   * it started.
   */
  private start(
    sc: CompiledScenario,
    vars: Run['vars'],
    input: EngineTickInput,
    outbound: OutboundMessage[],
    events: ScenarioEvent[],
    forced = false,
  ): boolean {
    const s = this.st.scenarios[sc.id] as ScenarioState;
    const skip = forced ? null : this.blocker(sc, s, input.now);
    if (skip !== null) {
      events.push({ type: 'SCENARIO_SKIPPED', id: sc.id, t: input.now, reason: skip });
      return false;
    }
    if (!forced && !(this.rngs.get(sc.id) as Rng).chance(sc.probability)) {
      events.push({ type: 'SCENARIO_SKIPPED', id: sc.id, t: input.now, reason: 'probability' });
      return false;
    }
    s.starts++;
    s.lastStartMs = input.now;
    if (!this.st.sessionFired.includes(sc.id)) this.st.sessionFired.push(sc.id);
    events.push({ type: 'SCENARIO_STARTED', id: sc.id, t: input.now });
    const run: Run = {
      id: sc.id,
      step: 0,
      untilFlightMs: null,
      untilPhase: null,
      reply: null,
      until: null,
      vars: { ...vars },
    };
    this.st.runs.push(run);
    this.advance(run, input, outbound, events);
    return true;
  }

  /** docs/05 "Исполнение" 5: a waiting `wait: reply` first, then the pilot commands. */
  private receive(
    m: PilotMessage,
    input: EngineTickInput,
    outbound: OutboundMessage[],
    events: ScenarioEvent[],
    mayWait = true,
  ): void {
    const text = normalizePilotText(m.text);
    const note = (
      result: PilotMessageResult,
      extra: { scenarioId?: string; command?: PilotCommand; detail?: string } = {},
    ) =>
      events.push({
        type: 'PILOT_MESSAGE',
        t: input.now,
        text,
        result,
        scenarioId: extra.scenarioId ?? null,
        command: extra.command ?? null,
        detail: extra.detail ?? null,
      });
    if (m.type.toLowerCase() !== 'telex') {
      note('ignored', { detail: `type ${m.type}` });
      return;
    }
    if (normalizePilotText(m.from).replaceAll(' ', '') !== this.ofp.callsign.toUpperCase()) {
      note('ignored', { detail: `from ${m.from}` });
      return;
    }
    if (text === '') {
      note('ignored', { detail: 'empty' });
      return;
    }

    const [word, ...rest] = text.split(' ');
    const run = this.st.runs.find((r) => r.reply?.options.includes(word as string) === true);
    if (run !== undefined) {
      run.reply = null;
      run.vars = {
        ...run.vars,
        'reply.option': word as string,
        'reply.text': text,
        'reply.arg': rest.length === 0 ? null : rest.join(' '),
        'reply.timeout': false,
      };
      note('reply', { scenarioId: run.id });
      this.advance(run, input, outbound, events);
      return;
    }

    const cmd = parseCommand(text);
    if (cmd === null) {
      note('unknown');
      this.opsReply(`UNABLE ${clip(text)}\nSEND HELP FOR LIST`, input.now, outbound, events);
      return;
    }
    if (cmd.ok && cmd.command === 'REQ_WX' && mayWait && this.dataWaitMs > 0) {
      const icao = cmd.args.icao ?? this.ofp.destination.icao;
      if (!this.wxFresh(icao, input.now)) {
        this.st.pendingWx.push({ message: m, icao, until: input.now + this.dataWaitMs });
        events.push({ type: 'DATA_REQUEST', kind: 'wx', icao, t: input.now });
        return;
      }
    }
    const words = cmd.command.replaceAll('_', ' ');
    const done = cmd.ok ? this.applyCommand(cmd, text, input) : { hint: `FORMAT ${cmd.hint}` };
    if ('hint' in done) {
      note('invalid', { command: cmd.command, detail: done.hint });
      this.opsReply(
        `UNABLE ${words}\n${done.hint}\nSEND HELP FOR LIST`,
        input.now,
        outbound,
        events,
      );
      return;
    }
    note('command', { command: cmd.command });
    let started = false;
    for (const sc of this.ordered) {
      const tr = sc.def.trigger;
      if (tr.on !== 'command' || tr.command !== cmd.command) continue;
      if (!sc.conditions.every((c) => c.test(this.lookFor(done.vars)))) continue;
      if (this.start(sc, done.vars, input, outbound, events)) started = true;
    }
    // Every command gets an answer, even with its scenarios switched off.
    if (!started) this.opsReply(`RCVD ${clip(text)}`, input.now, outbound, events);
  }

  /**
   * The engine's part of a command (deterministic, before its scenarios run): `DELAY` moves
   * the schedule like a late start, `DIVERT` records the airport. `cmd.*` for the scenarios,
   * or why it cannot be done.
   */
  private applyCommand(
    cmd: Extract<ParsedCommand, { ok: true }>,
    text: string,
    input: EngineTickInput,
  ): { vars: Run['vars'] } | { hint: string } {
    const { args } = cmd;
    let icao = args.icao;
    let wx: { metar: string | null; taf: string | null; live: boolean; obs: number | null } = {
      metar: null,
      taf: null,
      live: false,
      obs: null,
    };
    let extra: Partial<Record<RunVariable, Value>> = {};
    switch (cmd.command) {
      case 'REQ_ATIS':
      case 'REQ_WX': {
        icao ??= this.ofp.destination.icao;
        const o = this.ofp;
        const known = [o.origin, o.destination, ...o.alternates].find((a) => a.icao === icao);
        // Live weather first (T13), else the METAR SimBrief put into the OFP.
        const live = liveWx(this.st.ext, icao, input.now);
        wx =
          live?.metar != null
            ? { metar: live.metar, taf: live.taf, live: true, obs: live.obsTime }
            : { metar: known?.metar ?? null, taf: live?.taf ?? null, live: false, obs: null };
        if (cmd.command === 'REQ_ATIS') {
          // The VATSIM ATIS station's text (T44); stale feed data is not an ATIS.
          const fresh = this.st.ext.atcT !== null && input.now - this.st.ext.atcT <= ATC_MAX_AGE_MS;
          const station = fresh
            ? this.st.ext.atc?.[icao]?.find((s) => s.facility === 'ATIS' && s.atisText != null)
            : undefined;
          extra = {
            'cmd.atis': station?.atisText ?? null,
            'cmd.atis_code': station?.atisCode ?? null,
          };
        }
        break;
      }
      case 'MEDICAL':
        if (input.oooi.OFF === null || input.oooi.ON !== null) return { hint: 'NOT AIRBORNE' };
        break;
      case 'RDY':
        if (input.oooi.OUT !== null) return { hint: 'OFF BLOCK ALREADY' };
        break;
      case 'REQ_GATE_CHANGE': {
        if (input.oooi.IN !== null) return { hint: 'ALREADY ON BLOCK' };
        // The gate asked for when it is one of the known stands (and not the current one), else
        // the alternative of the gate reassignment; none when no other stand is known.
        const known = this.st.ext.stands?.some((s) => s.ref === args.gate) === true;
        const wanted = args.gate !== null && known && args.gate !== this.data.ops.arrGate;
        extra = { 'cmd.gate': args.gate, 'cmd.new_gate': wanted ? args.gate : this.newGate };
        break;
      }
      case 'DELAY':
        if (input.oooi.OUT !== null) return { hint: 'OFF BLOCK ALREADY' };
        this.setDelay((this.st.delayMs ?? 0) + (args.minutes as number) * 60_000);
        this.st.delayParts.push({
          code: reasonCode(args.reason as string | null),
          ms: (args.minutes as number) * 60_000,
        });
        break;
      case 'DIVERT':
        if (input.oooi.OFF === null || input.oooi.ON !== null) return { hint: 'NOT AIRBORNE' };
        if (icao === this.ofp.destination.icao) return { hint: `${icao} IS DESTINATION` };
        this.st.divert = icao;
        extra = this.divertDistance(icao, input);
        break;
      default:
        break;
    }
    if (cmd.command === 'DELAY' || cmd.command === 'DIVERT') this.refresh();
    return {
      vars: {
        'cmd.name': cmd.command,
        'cmd.text': text,
        'cmd.icao': icao,
        'cmd.minutes': args.minutes,
        'cmd.reason': args.reason,
        'cmd.metar': wx.metar,
        'cmd.taf': wx.taf,
        'cmd.wx_live': cmd.command === 'REQ_WX' ? wx.live : null,
        'cmd.wx_obs': wx.obs,
        ...extra,
      },
    };
  }

  /**
   * Distance and ETA to a diversion airport (T44): only for the airports of the OFP (their
   * position is known); null for others. The ETA needs a ground speed of 60 kt or more.
   */
  private divertDistance(
    icao: string | null,
    input: EngineTickInput,
  ): Partial<Record<RunVariable, Value>> {
    const tm = input.telemetry;
    const o = this.ofp;
    const apt = [o.origin, ...o.alternates].find((a) => a.icao === icao);
    if (apt === undefined || tm === null) return { 'cmd.divert_nm': null, 'cmd.divert_eta': null };
    const nm = distanceNm(tm, apt);
    return {
      'cmd.divert_nm': Math.round(nm),
      'cmd.divert_eta': tm.gsKt >= 60 ? input.now + Math.round((nm / tm.gsKt) * 3_600_000) : null,
    };
  }

  /** A telex of the engine itself (scenario id {@link OPS_REPLY_ID}). */
  private opsReply(
    body: string,
    now: number,
    outbound: OutboundMessage[],
    events: ScenarioEvent[],
  ): void {
    try {
      this.emit(OPS_REPLY_ID, formatMessage({ body }, this.profile), now, outbound);
    } catch (e) {
      if (!(e instanceof FormatError)) throw e;
      events.push({ type: 'SCENARIO_ERROR', id: OPS_REPLY_ID, t: now, error: e.message });
    }
  }

  private emit(id: string, message: FormattedMessage, now: number, out: OutboundMessage[]): void {
    out.push({
      scenarioId: id,
      from: this.from,
      to: this.ofp.callsign,
      kind: 'telex',
      message,
      t: now,
      toPilot: this.answering || id === OPS_REPLY_ID,
    });
    if (id === OPS_REPLY_ID) return;
    const first = !(id in this.st.sent);
    this.st.sent[id] = { t: now, message };
    if (first) this.refresh();
  }

  /** Runs a `set` step (T14). */
  private assign(
    id: string,
    step: Extract<CompiledScenario['steps'][number], { kind: 'set' }>,
    look: Lookup,
    rng: Rng,
    input: EngineTickInput,
    events: ScenarioEvent[],
  ): void {
    let refresh = false;
    for (const a of step.assigns) {
      let value: Value =
        a.value.k === 'lit'
          ? a.value.v
          : a.value.k === 'var'
            ? (look(a.value.path) ?? null)
            : a.value.t.render(look, rng);
      if (typeof value === 'string') value = value.slice(0, MAX_FLAG_TEXT);
      let applied = true;
      if (a.target === 'flight.divert') {
        const icao = typeof value === 'string' ? value.trim().toUpperCase() : null;
        applied =
          (icao === null && value === null) ||
          (icao !== null &&
            /^[A-Z]{4}$/.test(icao) &&
            icao !== this.ofp.destination.icao &&
            input.oooi.OFF !== null &&
            input.oooi.ON === null);
        if (applied) {
          this.st.divert = icao;
          value = icao;
          refresh = true;
        }
      } else if (a.target === 'flight.hold') {
        // Holding in the air (T48): minutes 1..120 starts it, null ends it.
        const min = typeof value === 'number' ? value : Number(value);
        const airborne = input.oooi.OFF !== null && input.oooi.ON === null;
        if (value === null) {
          this.st.hold = null;
        } else {
          applied = airborne && Number.isFinite(min) && min >= 1 && min <= 120;
          if (applied) this.st.hold = { since: input.now, min: Math.round(min) };
        }
      } else if (a.target === 'flight.delay_min') {
        const min = typeof value === 'number' ? value : Number(value);
        applied = input.oooi.OUT === null && Number.isFinite(min) && min >= 0 && min <= 600;
        if (applied) {
          const before = this.st.delayMs ?? 0;
          const after = Math.max(before, Math.round(min) * 60_000);
          // The CTOT the slot announced must not move with the delay the slot itself caused.
          this.st.delayRaisedMs += after - before;
          // Only the slot raises the delay this way: ATFM (T43).
          if (after > before) this.st.delayParts.push({ code: SLOT_CODE, ms: after - before });
          this.setDelay(after);
          refresh = true;
        }
      } else if (a.target === 'ops.arr_gate') {
        const gate = typeof value === 'string' ? value.trim().toUpperCase() : '';
        applied = /^[A-Z0-9]{1,6}$/.test(gate);
        if (applied) {
          this.st.gate = gate;
          this.st.ext = { ...this.st.ext, gateLocked: true };
          this.rebuildData();
          value = gate;
          refresh = true;
        }
      } else {
        const name = a.target.slice(6);
        if (value === null) delete this.st.flags[name];
        else if (name in this.st.flags || Object.keys(this.st.flags).length < MAX_FLAGS)
          this.st.flags[name] = value;
        else applied = false;
      }
      events.push({ type: 'SET', id, t: input.now, name: a.target, value, applied });
    }
    if (refresh) this.refresh();
  }

  /** The core has weather for `icao` fetched within {@link WX_FRESH_MS} (a report or none). */
  private wxFresh(icao: string, now: number): boolean {
    const r = this.st.ext.wx[icao];
    if (r === undefined) return false;
    // A "no report" answer has no time of its own: asking again would give the same.
    return r === null || now - r.t <= WX_FRESH_MS;
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
      case 'command':
        return false; // started by `receive`
      case 'time': {
        const ref = ctx[TIME_REF_VAR[tr.at.rel]];
        // `ofp.est_*` in the context already include the delay, `ofp.sched_*` do not.
        const shift = tr.at.rel.startsWith('sched_') ? (this.st.delayMs ?? 0) : 0;
        return typeof ref === 'number' && input.now >= ref + shift + tr.at.offset_min * 60_000;
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
    const cd = sc.def.cooldown ?? (sc.def.trigger.on === 'command' ? 'none' : 'per_flight');
    if (cd === 'per_flight' && s.starts > 0) return 'cooldown';
    if (cd === 'per_session' && this.st.sessionFired.includes(sc.id)) return 'cooldown';
    if (
      typeof cd === 'object' &&
      s.lastStartMs !== null &&
      now - s.lastStartMs < cd.minutes * 60_000
    ) {
      return 'cooldown';
    }
    // Group limit (T39): members started in this flight, the scenario itself included.
    const group = sc.def.group;
    if (group !== undefined && sc.groupMax !== null) {
      let started = 0;
      for (const other of this.ordered) {
        if (other.def.group === group) {
          started += (this.st.scenarios[other.id] as ScenarioState).starts;
        }
      }
      if (started >= sc.groupMax) return 'excluded';
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

  /** `wait: until` is over: the outcome goes to the next `branch` as `reply.option`. */
  private finishUntil(
    run: Run,
    id: string,
    met: boolean,
    input: EngineTickInput,
    events: ScenarioEvent[],
  ): void {
    const result = met ? 'MET' : 'TIMEOUT';
    run.vars = {
      ...run.vars,
      'reply.option': result,
      'reply.text': null,
      'reply.arg': null,
      'reply.timeout': !met,
    };
    events.push({ type: 'WAIT_UNTIL', id, t: input.now, result });
  }

  /** Executes steps of a run until it waits or finishes. */
  private advance(
    run: Run,
    input: EngineTickInput,
    outbound: OutboundMessage[],
    events: ScenarioEvent[],
  ): void {
    const sc = this.byId.get(run.id) as CompiledScenario;
    const rng = this.rngs.get(run.id) as Rng;
    const fail = (error: string) => {
      this.st.runs = this.st.runs.filter((r) => r !== run);
      events.push({ type: 'SCENARIO_ERROR', id: sc.id, t: input.now, error });
    };
    if (run.reply !== null) {
      if (input.flightTimeMs < run.reply.untilFlightMs) return;
      const option = run.reply.default;
      run.reply = null;
      run.vars = {
        ...run.vars,
        'reply.option': option,
        'reply.text': null,
        'reply.arg': null,
        'reply.timeout': true,
      };
      events.push({ type: 'REPLY_TIMEOUT', id: sc.id, t: input.now, option });
    }
    if (run.until !== null) {
      const w = sc.steps[run.until.step] as Extract<CompiledStep, { kind: 'wait_until' }>;
      const met = w.cond.test(this.lookFor(run.vars));
      if (!met && input.flightTimeMs < run.until.deadlineMs) return;
      run.until = null;
      this.finishUntil(run, sc.id, met, input, events);
    }
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
      if (step.kind === 'wait_reply') {
        const timeoutMs = step.timeoutMin * 60_000;
        run.reply = {
          options: [...step.options],
          default: step.default,
          untilFlightMs: input.flightTimeMs + timeoutMs,
        };
        events.push({
          type: 'REPLY_EXPECTED',
          id: sc.id,
          t: input.now,
          options: step.options,
          timeoutMs,
        });
        return;
      }
      if (step.kind === 'wait_until') {
        const met = step.cond.test(this.lookFor(run.vars));
        if (!met) {
          run.until = {
            step: run.step - 1,
            deadlineMs: input.flightTimeMs + step.timeoutMin * 60_000,
          };
          return;
        }
        this.finishUntil(run, sc.id, true, input, events);
        continue;
      }
      if (step.kind === 'branch') {
        const option = run.vars['reply.option'];
        run.step = (typeof option === 'string' ? step.arms[option] : undefined) ?? step.end;
        continue;
      }
      if (step.kind === 'jump') {
        run.step = step.to;
        continue;
      }
      if (step.kind === 'set') {
        try {
          this.assign(sc.id, step, this.lookFor(run.vars), rng, input, events);
        } catch (e) {
          if (!(e instanceof TemplateError)) throw e;
          fail(e.message);
          return;
        }
        continue;
      }
      if (step.kind === 'smoke') {
        this.commands.push({
          command: 'smoke',
          scenarioId: sc.id,
          t: input.now,
          action: step.action,
          airport: this.ofp.destination.icao,
          runway: this.ofp.destination.planRwy ?? null,
        });
        continue;
      }
      if (step.kind === 'vdgs') {
        try {
          const look = this.lookFor(run.vars);
          const given: Partial<Record<VdgsDisplay, VdgsLine[]>> = {};
          for (const [d, lines] of Object.entries(step.displays)) {
            given[d as VdgsDisplay] = (lines ?? []).map((l) => ({
              text: l.t.render(look, rng),
              red: l.red,
            }));
          }
          const airport = this.st.divert ?? this.ofp.destination.icao;
          this.commands.push({
            command: 'vdgs',
            scenarioId: sc.id,
            t: input.now,
            vdgs: buildVdgsMessage(airport, step.durationSec, given),
          });
          const readsGate = Object.values(step.displays).some((ls) =>
            (ls ?? []).some((l) => GATE_VARS.some((v) => l.t.vars.includes(v))),
          );
          if (!this.st.ext.gateLocked && readsGate && this.data.ops.arrGate !== null) {
            this.st.ext = { ...this.st.ext, gateLocked: true };
          }
        } catch (e) {
          if (!(e instanceof TemplateError || e instanceof VdgsError)) throw e;
          fail(e.message);
          return;
        }
        continue;
      }
      if (step.kind === 'resend') {
        let last: Sent | undefined;
        for (const id of step.of) {
          const s = this.st.sent[id];
          if (s !== undefined && (last === undefined || s.t > last.t)) last = s;
        }
        if (last === undefined) {
          fail(`nothing to resend (${step.of.join(', ')})`);
          return;
        }
        this.emit(sc.id, last.message, input.now, outbound);
        continue;
      }
      try {
        const look = this.lookFor(run.vars);
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
        this.emit(sc.id, message, input.now, outbound);
        if (
          !this.st.ext.gateLocked &&
          this.data.ops.arrGate !== null &&
          GATE_VARS.some((v) => sendReads(step, v))
        ) {
          this.st.ext = { ...this.st.ext, gateLocked: true };
        }
      } catch (e) {
        if (!(e instanceof TemplateError || e instanceof FormatError)) throw e;
        fail(e.message);
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

/** Pilot text echoed in an engine answer: at most 40 characters, whole words. */
function clip(text: string): string {
  if (text.length <= 40) return text;
  const cut = text.slice(0, 41);
  const space = cut.lastIndexOf(' ');
  return space > 0 ? cut.slice(0, space) : cut.slice(0, 40);
}

/** OFP with the estimated (and, for ops data, also the scheduled) times moved by `ms`. */
function delayedOfp(ofp: Ofp, ms: number, sched: boolean): Ofp {
  const t = ofp.times;
  const add = (x: number | null) => (x === null ? null : x + ms);
  return {
    ...ofp,
    times: {
      ...t,
      estOutMs: t.estOutMs + ms,
      estOffMs: add(t.estOffMs),
      estOnMs: add(t.estOnMs),
      estInMs: t.estInMs + ms,
      ...(sched
        ? {
            schedOutMs: t.schedOutMs + ms,
            schedOffMs: add(t.schedOffMs),
            schedOnMs: add(t.schedOnMs),
            schedInMs: t.schedInMs + ms,
          }
        : {}),
    },
  };
}

/** Variables that read the arrival gate: once one went out, the gate is fixed (`gateLocked`). */
const GATE_VARS = ['ops.arr_gate', 'ops.gate_place', 'ops.gate_line', 'ops.gate_expected'] as const;

function sendReads(step: CompiledScenario['steps'][number], variable: string): boolean {
  if (step.kind !== 'send') return false;
  return [step.header, step.body, step.footer].some((t) => t?.vars.includes(variable) === true);
}

/**
 * Arrival gate from the OSM data (T13): gates when the airport maps at least 3, else parking
 * positions; refs in natural order (`A2` < `A10`); one draw of `${seed}/#stands`.
 */
export function pickStand(stands: readonly ParkingStand[], seed: number | string): string {
  return (pickStandInfo(stands, seed) as { ref: string }).ref;
}

/** {@link pickStand} with the kind of the picked stand (`stand` = a parking position). */
export function pickStandInfo(
  stands: readonly ParkingStand[],
  seed: number | string,
): { readonly ref: string; readonly kind: ParkingStand['kind'] } | null {
  const gates = stands.filter((s) => s.kind === 'gate');
  const pool = (gates.length >= 3 ? gates : stands).map((s) => s.ref);
  const refs = [...new Set(pool)].sort(naturalCompare);
  if (refs.length === 0) return null;
  const ref = createRng(`${String(seed)}/#stands`).pick(refs);
  const found = (gates.length >= 3 ? gates : stands).find((s) => s.ref === ref);
  return { ref, kind: found?.kind ?? 'stand' };
}

/** Digit runs compare as numbers, the rest by char code (locale-free, deterministic). */
function naturalCompare(a: string, b: string): number {
  const ta = a.match(/\d+|\D+/g) ?? [];
  const tb = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    const x = ta[i] as string;
    const y = tb[i] as string;
    if (x === y) continue;
    const nx = /^\d/.test(x);
    const ny = /^\d/.test(y);
    if (nx && ny) return Number(x) - Number(y) || (x < y ? -1 : 1);
    return x < y ? -1 : 1;
  }
  return ta.length - tb.length;
}
