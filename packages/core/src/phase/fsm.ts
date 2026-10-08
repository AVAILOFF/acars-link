import { distanceNm, type LatLon } from '../geo/geo.js';
import type { TelemetrySnapshot } from '../telemetry/types.js';

/**
 * Flight-phase machine, docs/04-flight-phase-fsm.md.
 *
 * Input: telemetry snapshots (~1 Hz) and the app clock; output: the current phase and
 * events (phase changes, OOOI, ALT_CHANGE, DISCONTINUITY, TELEMETRY_LOST/RESTORED).
 *
 * Time model. Hold timers ("Устойчивость") run on *flight time*: the wall time between
 * consecutive snapshots (`t`) × `simRate`, frozen while `paused`. Event times are snapshot
 * times (UTC ms), so a replay of the same recording yields the same events. Only the
 * telemetry-loss watchdog, {@link PhaseMachine.tick}, uses the app clock.
 *
 * All state is a plain JSON object ({@link PhaseMachine.getState}); a restored machine
 * continues exactly where the old one stopped.
 */

export const FLIGHT_PHASES = [
  'PREFLIGHT',
  'BOARDING',
  'PUSHBACK',
  'TAXI_OUT',
  'TAKEOFF',
  'CLIMB',
  'CRUISE',
  'DESCENT',
  'APPROACH',
  'GO_AROUND',
  'LANDED',
  'TAXI_IN',
  'ON_BLOCK',
  'TURNAROUND',
  'DONE',
] as const;

export type FlightPhase = (typeof FLIGHT_PHASES)[number];

export type OooiKind = 'OUT' | 'OFF' | 'ON' | 'IN';

export type PhaseEvent =
  | {
      readonly type: 'PHASE_CHANGE';
      readonly t: number;
      readonly from: FlightPhase;
      readonly to: FlightPhase;
    }
  /** `t` is the OOOI time itself (brake release + movement, lift-off, touchdown, on block). */
  | { readonly [K in OooiKind]: { readonly type: `OOOI_${K}`; readonly t: number } }[OooiKind]
  /** Step climb/descent in cruise, docs/04: an event, not a phase change. */
  | {
      readonly type: 'ALT_CHANGE';
      readonly t: number;
      readonly fromFt: number;
      readonly toFt: number;
    }
  | { readonly type: 'DISCONTINUITY'; readonly t: number; readonly jumpNm: number }
  | { readonly type: 'TELEMETRY_LOST'; readonly t: number; readonly lastT: number }
  | { readonly type: 'TELEMETRY_RESTORED'; readonly t: number; readonly gapMs: number }
  | { readonly type: 'SIM_PAUSED'; readonly t: number }
  | { readonly type: 'SIM_RESUMED'; readonly t: number };

export interface PhaseConfig {
  /** No snapshot for longer than this → TELEMETRY_LOST. docs/04: 30 s. */
  readonly telemetryLostMs: number;
  /** A position jump above this (plus what the speed explains) → DISCONTINUITY. */
  readonly discontinuityMinNm: number;
  /** Cruise level change that counts as ALT_CHANGE. */
  readonly altChangeFt: number;
  /** The new level must be held this long (flight time). */
  readonly altChangeHoldSec: number;
}

export const DEFAULT_PHASE_CONFIG: PhaseConfig = {
  telemetryLostMs: 30_000,
  discontinuityMinNm: 2,
  altChangeFt: 1000,
  altChangeHoldSec: 30,
};

interface Candidate {
  /** Flight time when the condition became true. */
  readonly sinceSimMs: number;
  /** Snapshot time when the condition became true. */
  readonly sinceT: number;
}

export interface PhaseMachineState {
  readonly v: 1;
  /** Planned cruise level (OFP initial altitude). */
  readonly cruiseAltFt: number;
  readonly destination: LatLon;
  readonly phase: FlightPhase;
  /** The user started the flight (PREFLIGHT → BOARDING allowed). */
  readonly started: boolean;
  /** Flight time: Σ Δt × simRate, paused excluded. */
  readonly flightTimeMs: number;
  readonly last: TelemetrySnapshot | null;
  /** App-clock time of the last snapshot. */
  readonly lastRxMs: number | null;
  readonly telemetryLost: boolean;
  readonly candidates: Readonly<Record<string, Candidate>>;
  readonly oooi: Readonly<Record<OooiKind, number | null>>;
  /** Last ground → air / air → ground edge, snapshot time. */
  readonly liftoffT: number | null;
  readonly touchdownT: number | null;
  /** Lowest AGL in the current APPROACH (go-around detection). */
  readonly approachMinAglFt: number | null;
  /** Current cruise level for ALT_CHANGE. */
  readonly cruiseLevelFt: number | null;
  readonly history: readonly { readonly phase: FlightPhase; readonly t: number }[];
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type State = Mutable<PhaseMachineState> & {
  candidates: Record<string, Candidate>;
  oooi: Record<OooiKind, number | null>;
  history: { phase: FlightPhase; t: number }[];
};

interface Ctx {
  readonly s: TelemetrySnapshot;
  readonly st: State;
}

interface Transition {
  readonly from: FlightPhase;
  readonly to: FlightPhase;
  readonly holdSec: number;
  readonly when: (c: Ctx) => boolean;
}

const anyEngine = (s: TelemetrySnapshot) => s.engRunning.some(Boolean);
const distToDest = (c: Ctx) => distanceNm(c.s, c.st.destination);

/**
 * docs/04 table, in priority order per phase. Rows marked "+" are additions to the draft
 * table (see the T04 report): without them the machine gets stuck.
 */
const TRANSITIONS: readonly Transition[] = [
  {
    from: 'PREFLIGHT',
    to: 'BOARDING',
    holdSec: 0,
    when: ({ s, st }) => st.started && s.onGround && !anyEngine(s),
  },
  {
    from: 'BOARDING',
    to: 'PUSHBACK',
    holdSec: 5,
    when: ({ s }) => s.beacon && (!s.parkingBrake || s.gsKt > 1),
  },
  { from: 'PUSHBACK', to: 'TAXI_OUT', holdSec: 10, when: ({ s }) => anyEngine(s) && s.gsKt > 5 },
  { from: 'TAXI_OUT', to: 'TAKEOFF', holdSec: 3, when: ({ s }) => s.onGround && s.gsKt > 40 },
  { from: 'TAKEOFF', to: 'CLIMB', holdSec: 5, when: ({ s }) => !s.onGround && s.aglFt > 500 },
  // + rejected takeoff
  { from: 'TAKEOFF', to: 'TAXI_OUT', holdSec: 10, when: ({ s }) => s.onGround && s.gsKt < 20 },
  {
    from: 'CLIMB',
    to: 'CRUISE',
    holdSec: 60,
    when: ({ s, st }) => s.altFt >= st.cruiseAltFt - 1000 && Math.abs(s.vsFpm) < 500,
  },
  // + descent without reaching the planned level (short hop, diversion, after a go-around)
  { from: 'CLIMB', to: 'DESCENT', holdSec: 60, when: ({ s }) => s.vsFpm < -800 },
  {
    from: 'CRUISE',
    to: 'DESCENT',
    holdSec: 60,
    when: ({ s, st }) => s.vsFpm < -800 && s.altFt < st.cruiseAltFt - 2000,
  },
  {
    from: 'DESCENT',
    to: 'APPROACH',
    holdSec: 10,
    when: (c) => c.s.aglFt < 5000 || distToDest(c) < 30,
  },
  { from: 'APPROACH', to: 'LANDED', holdSec: 2, when: ({ s }) => s.onGround && s.gsKt > 30 },
  {
    from: 'APPROACH',
    to: 'GO_AROUND',
    holdSec: 5,
    when: ({ s, st }) =>
      !s.onGround &&
      s.vsFpm > 500 &&
      st.approachMinAglFt !== null &&
      st.approachMinAglFt < 1000 &&
      s.aglFt > st.approachMinAglFt + 100,
  },
  // + after the missed approach: climbing away (diversion) or level/descending (new approach)
  { from: 'GO_AROUND', to: 'CLIMB', holdSec: 10, when: ({ s }) => s.aglFt > 5000 && s.vsFpm > 0 },
  { from: 'GO_AROUND', to: 'APPROACH', holdSec: 10, when: ({ s }) => s.vsFpm < 300 },
  { from: 'LANDED', to: 'TAXI_IN', holdSec: 5, when: ({ s }) => s.gsKt < 30 },
  {
    from: 'TAXI_IN',
    to: 'ON_BLOCK',
    holdSec: 10,
    when: ({ s }) => s.gsKt < 1 && s.parkingBrake && !anyEngine(s),
  },
];

const OUT_PHASES: ReadonlySet<FlightPhase> = new Set(['BOARDING', 'PUSHBACK', 'TAXI_OUT']);
const OUT_HOLD_SEC = 3;
const OUT_KEY = 'OOOI_OUT';
const ALT_KEY = 'ALT_CHANGE';
const key = (t: Transition) => `${t.from}>${t.to}`;
const round100 = (ft: number) => Math.round(ft / 100) * 100;

export interface PhaseMachineOptions {
  /** An `Ofp` fits; only the planned cruise level and the destination are used. */
  readonly ofp: { readonly initialAltitudeFt: number; readonly destination: LatLon };
  readonly config?: Partial<PhaseConfig>;
}

export class PhaseMachine {
  private readonly st: State;
  private readonly cfg: PhaseConfig;

  constructor(options: PhaseMachineOptions) {
    this.cfg = { ...DEFAULT_PHASE_CONFIG, ...options.config };
    const { destination } = options.ofp;
    this.st = {
      v: 1,
      cruiseAltFt: options.ofp.initialAltitudeFt,
      destination: { lat: destination.lat, lon: destination.lon },
      phase: 'PREFLIGHT',
      started: false,
      flightTimeMs: 0,
      last: null,
      lastRxMs: null,
      telemetryLost: false,
      candidates: {},
      oooi: { OUT: null, OFF: null, ON: null, IN: null },
      liftoffT: null,
      touchdownT: null,
      approachMinAglFt: null,
      cruiseLevelFt: null,
      history: [],
    };
  }

  /** Resumes a machine from {@link getState} (e.g. after an app restart). */
  static fromState(state: PhaseMachineState, config?: Partial<PhaseConfig>): PhaseMachine {
    if (state.v !== 1) throw new Error(`unsupported PhaseMachineState version ${String(state.v)}`);
    if (!FLIGHT_PHASES.includes(state.phase)) throw new Error(`unknown phase ${state.phase}`);
    const m = new PhaseMachine({
      ofp: { initialAltitudeFt: state.cruiseAltFt, destination: state.destination },
      ...(config === undefined ? {} : { config }),
    });
    Object.assign(m.st, clone(state));
    return m;
  }

  get phase(): FlightPhase {
    return this.st.phase;
  }

  get telemetryLost(): boolean {
    return this.st.telemetryLost;
  }

  get lastSnapshot(): TelemetrySnapshot | null {
    return this.st.last;
  }

  get flightTimeMs(): number {
    return this.st.flightTimeMs;
  }

  get oooi(): Readonly<Record<OooiKind, number | null>> {
    return { ...this.st.oooi };
  }

  /** JSON-serializable copy of the whole state. */
  getState(): PhaseMachineState {
    return clone(this.st);
  }

  /** The user starts the flight: PREFLIGHT → BOARDING on the next suitable snapshot. */
  startFlight(): void {
    this.st.started = true;
  }

  /** Closes the flight from ON_BLOCK (user decision: turnaround to a next leg or done). */
  endFlight(to: 'TURNAROUND' | 'DONE', now: number): PhaseEvent[] {
    if (this.st.phase !== 'ON_BLOCK') {
      throw new Error(`endFlight is only allowed from ON_BLOCK, current phase ${this.st.phase}`);
    }
    const events: PhaseEvent[] = [];
    this.enter(to, now, events);
    return events;
  }

  /** Watchdog, call periodically with the app clock: no snapshot for too long → TELEMETRY_LOST. */
  tick(now: number): PhaseEvent[] {
    const { st } = this;
    if (st.telemetryLost || st.lastRxMs === null || st.last === null) return [];
    if (now - st.lastRxMs <= this.cfg.telemetryLostMs) return [];
    st.telemetryLost = true;
    return [{ type: 'TELEMETRY_LOST', t: now, lastT: st.last.t }];
  }

  /** Feeds one snapshot; `now` is the app clock at receipt. Out-of-order samples are ignored. */
  push(s: TelemetrySnapshot, now: number): PhaseEvent[] {
    const { st, cfg } = this;
    const prev = st.last;
    if (prev !== null && s.t <= prev.t) return [];
    const events: PhaseEvent[] = [];
    const dtWall = prev === null ? 0 : s.t - prev.t;
    const gap = dtWall > cfg.telemetryLostMs;

    if (prev !== null && gap && !st.telemetryLost) {
      // Replay or a stalled event loop: the watchdog never ran, report the loss after the fact.
      events.push({ type: 'TELEMETRY_LOST', t: prev.t + cfg.telemetryLostMs, lastT: prev.t });
      st.telemetryLost = true;
    }
    if (st.telemetryLost && prev !== null) {
      events.push({ type: 'TELEMETRY_RESTORED', t: s.t, gapMs: s.t - prev.t });
      st.telemetryLost = false;
      st.candidates = {};
    }
    if (prev !== null && prev.paused !== s.paused) {
      events.push({ type: s.paused ? 'SIM_PAUSED' : 'SIM_RESUMED', t: s.t });
    }

    const rate = s.simRate > 0 ? s.simRate : 1;
    const dtFlight = s.paused || gap ? 0 : dtWall * rate;

    if (prev?.onGround && !s.onGround) st.liftoffT = s.t;
    if (prev !== null && !prev.onGround && s.onGround) st.touchdownT = s.t;

    st.last = s;
    st.lastRxMs = now;
    st.flightTimeMs += dtFlight;

    if (prev !== null) {
      const jumpNm = distanceNm(prev, s);
      const explainedSec = s.paused ? 0 : (dtWall * rate) / 1000;
      const allowedNm =
        cfg.discontinuityMinNm + (1.5 * Math.max(prev.gsKt, s.gsKt) * explainedSec) / 3600;
      if (jumpNm > allowedNm) {
        events.push({ type: 'DISCONTINUITY', t: s.t, jumpNm: Math.round(jumpNm * 10) / 10 });
        st.candidates = {};
        st.approachMinAglFt = st.phase === 'APPROACH' && !s.onGround ? s.aglFt : null;
        return events;
      }
    }
    if (s.paused) return events;

    if (st.phase === 'APPROACH' && !s.onGround) {
      st.approachMinAglFt =
        st.approachMinAglFt === null ? s.aglFt : Math.min(st.approachMinAglFt, s.aglFt);
    }

    this.watchOut(s, events);
    this.watchAltChange(s, events);

    const c: Ctx = { s, st };
    for (const tr of TRANSITIONS) {
      if (tr.from !== st.phase) continue;
      const since = this.hold(key(tr), tr.when(c), tr.holdSec, s.t);
      if (since === null) continue;
      this.enter(tr.to, s.t, events, since);
      break;
    }
    return events;
  }

  /**
   * Hold timer for one condition. Returns the candidate (when the condition started to
   * hold) once it has held for `holdSec` of flight time, otherwise null.
   */
  private hold(id: string, ok: boolean, holdSec: number, t: number): Candidate | null {
    const { st } = this;
    if (!ok) {
      delete st.candidates[id];
      return null;
    }
    let c = st.candidates[id];
    if (c === undefined) {
      c = { sinceSimMs: st.flightTimeMs, sinceT: t };
      st.candidates[id] = c;
    }
    return st.flightTimeMs - c.sinceSimMs >= holdSec * 1000 ? c : null;
  }

  private watchOut(s: TelemetrySnapshot, events: PhaseEvent[]): void {
    const { st } = this;
    if (st.oooi.OUT !== null || !OUT_PHASES.has(st.phase)) return;
    const c = this.hold(OUT_KEY, !s.parkingBrake && s.gsKt >= 1, OUT_HOLD_SEC, s.t);
    if (c === null) return;
    delete st.candidates[OUT_KEY];
    this.recordOooi('OUT', c.sinceT, events);
  }

  private watchAltChange(s: TelemetrySnapshot, events: PhaseEvent[]): void {
    const { st, cfg } = this;
    if (st.phase !== 'CRUISE' || st.cruiseLevelFt === null) return;
    const level = st.cruiseLevelFt;
    const ok = Math.abs(s.vsFpm) < 300 && Math.abs(s.altFt - level) >= cfg.altChangeFt;
    if (this.hold(ALT_KEY, ok, cfg.altChangeHoldSec, s.t) === null) return;
    delete st.candidates[ALT_KEY];
    st.cruiseLevelFt = round100(s.altFt);
    events.push({ type: 'ALT_CHANGE', t: s.t, fromFt: level, toFt: st.cruiseLevelFt });
  }

  private recordOooi(kind: OooiKind, t: number, events: PhaseEvent[]): void {
    if (this.st.oooi[kind] !== null) return;
    this.st.oooi[kind] = t;
    events.push({ type: `OOOI_${kind}`, t });
  }

  private enter(to: FlightPhase, t: number, events: PhaseEvent[], since?: Candidate): void {
    const { st } = this;
    const from = st.phase;
    st.phase = to;
    // Transition timers start over in the new phase; the OUT watcher spans phases.
    const out = st.candidates[OUT_KEY];
    st.candidates = out === undefined ? {} : { [OUT_KEY]: out };
    st.history.push({ phase: to, t });
    events.push({ type: 'PHASE_CHANGE', t, from, to });

    if (from === 'TAKEOFF' && to === 'CLIMB') this.recordOooi('OFF', st.liftoffT ?? t, events);
    if (to === 'LANDED') this.recordOooi('ON', st.touchdownT ?? t, events);
    if (to === 'ON_BLOCK') this.recordOooi('IN', since?.sinceT ?? t, events);
    if (to === 'APPROACH') st.approachMinAglFt = null;
    if (to === 'CRUISE' && st.last !== null) st.cruiseLevelFt = round100(st.last.altFt);
  }
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}
