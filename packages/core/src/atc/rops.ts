import { ATC_MAX_AGE_MS, type CenterStation, type ExtState, type FirArea } from '../ext/data.js';
import type { FormattedMessage } from '../format/formatter.js';
import { DEFAULT_PROFILE, type DisplayProfile } from '../format/profile.js';
import { distanceNm, type LatLon } from '../geo/geo.js';
import type { Ofp } from '../ofp/types.js';
import type { FlightPhase } from '../phase/fsm.js';
import { createRng } from '../random/rng.js';
import type { OutboundMessage } from '../scenario/engine.js';
import type { PilotMessage } from '../scenario/pilot.js';
import type { TelemetrySnapshot } from '../telemetry/types.js';
import {
  cruiseSpan,
  DESCENT_BEFORE_TOD_NM,
  DIRECT_TOD_MARGIN_NM,
  descentLevel,
  directDecision,
  directExit,
  stepStatus,
} from './auto.js';
import { type CpdlcHeader, type CpdlcResponse, formatCpdlc, parseCpdlc } from './cpdlc.js';
import {
  type DclContext,
  type DclEvent,
  DclService,
  type DclState,
  parseDclRequest,
} from './dcl.js';
import { atcUnitName, FirMap, ropsStation } from './fir.js';
import { levelText } from './levels.js';
import { type OclContext, type OclEvent, OclService, type OclState, parseRcl } from './oceanic.js';
import { type AtcRequest, decide, parseRequest, type RefusalReason } from './requests.js';
import { routePosition, starEntryIndex } from './route.js';

/**
 * ROPS ATC station (T23, docs/07): a simulated CPDLC ground station for the own pilot only,
 * one per FIR, on Hoppie. The aircraft logs on (`REQUEST LOGON`), the station answers
 * `LOGON ACCEPTED` and `CURRENT ATC UNIT`; at a FIR boundary it hands the aircraft over
 * (`HANDOVER @<next>`), and the aircraft logs on to the next station by itself — the Hoppie
 * form of the CDA/NDA transfer of real CPDLC. Packets and phrases: `cpdlc.ts`.
 *
 * Approved decisions (docs/07 T23, 2026-10-09): callsign `X` + FIR (`fir.ts`); VATSpy FIRs;
 * where a live VATSIM centre covers the FIR (and `standAside` is on), the station steps
 * aside — a notice and LOGOFF to a connected aircraft, `UNABLE` to a logon — until the next
 * FIR or until the controller leaves.
 *
 * The departure clearance (T24, `dcl.ts`) runs on its own station, `X` + origin, on the ground.
 *
 * Deterministic: input = position, phase, the aircraft's messages to our stations and the
 * external data; randomness only from the seed (squawk, DCL timing, reply delays).
 *
 * T25: the connected station answers level, speed and Direct To requests (`requests.ts`)
 * after 20–60 s (seeded); 10 % of the level requests the rules allow are refused "due to
 * traffic" (seeded, never twice in a row; the same request again within 5 min is refused
 * again, later it is cleared). Other CPDLC messages get `MESSAGE NOT SUPPORTED BY THIS ATS
 * UNIT` (a phrase of real Hoppie stations).
 */

export const ROPS_ID = '#rops';

/** How long the old station still listens after a HANDOVER (for the aircraft's LOGOFF). */
export const HANDOVER_LISTEN_MS = 10 * 60_000;

/** Reply delay to a pilot request, s (approved 2026-10-09, T25). */
export const REPLY_DELAY_S = [20, 60] as const;
/** Share of the allowed level requests refused due to traffic (approved 2026-10-09). */
export const TRAFFIC_REFUSAL = 0.1;
/** The same request within this time after a traffic refusal is refused again. */
export const TRAFFIC_HOLD_MS = 5 * 60_000;

/** Minutes after the WILCO to a level clearance before the station asks to confirm it (T47, approved 2026-10-15). */
export const LEVEL_CHECK_MIN = 5;
/** The aircraft is "at" the assigned level within this, ft; beyond `LEVEL_DEPART_FT` it left it. */
export const LEVEL_AT_FT = 200;
export const LEVEL_DEPART_FT = 300;

/** Diversion: descent to this level once the airport is within the descent distance (T48). */
export const DIVERT_DESCENT_FT = 10_000;
/** Descent distance of the diversion: 3 NM per 1000 ft plus this margin, NM (T48). */
export const DIVERT_DESCENT_MARGIN_NM = 20;

export interface RopsOptions {
  readonly enabled: boolean;
  /** Step aside where a live VATSIM centre covers the FIR (default true). */
  readonly standAside?: boolean;
  /** Random Direct To on the station's own (T26; default true). */
  readonly randomDirects?: boolean;
}

export type AtcEvent =
  | DclEvent
  | OclEvent
  /** The station the aircraft should log on to changed (a new FIR). */
  | {
      readonly type: 'ATC_STATION';
      readonly t: number;
      readonly fir: string;
      readonly station: string;
      readonly unit: string;
    }
  | {
      readonly type: 'ATC_LOGON';
      readonly t: number;
      readonly station: string;
      readonly accepted: boolean;
      /** Why a logon was refused. */
      readonly reason: 'live_atc' | 'wrong_station' | null;
      /** The station to log on to instead (T49: a wrong station), else null. */
      readonly expected?: string | null;
    }
  | {
      readonly type: 'ATC_HANDOVER';
      readonly t: number;
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly type: 'ATC_LOGOFF';
      readonly t: number;
      readonly station: string;
      readonly by: 'pilot' | 'atc';
    }
  /** A live VATSIM centre covers the FIR: the station stepped aside. */
  | {
      readonly type: 'ATC_LIVE';
      readonly t: number;
      readonly fir: string;
      readonly callsign: string;
      readonly frequency: string;
    }
  /** A pilot request answered (T25). */
  | {
      readonly type: 'ATC_REQUEST';
      readonly t: number;
      readonly station: string;
      readonly request: string;
      readonly approved: boolean;
      readonly reply: string;
      readonly why: RefusalReason | null;
    }
  /** A clearance the station sent on its own (T26). */
  | {
      readonly type: 'ATC_AUTO';
      readonly t: number;
      readonly station: string;
      readonly kind: 'direct' | 'step' | 'descent' | 'divert' | 'hold';
      readonly text: string;
    }
  /** MAYDAY / PAN received (T47): the airline's emergency chain starts. */
  | {
      readonly type: 'ATC_EMERGENCY';
      readonly t: number;
      readonly station: string;
      readonly kind: 'MAYDAY' | 'PAN';
    }
  /** The station asked the aircraft to confirm its assigned level (T47). */
  | {
      readonly type: 'ATC_LEVEL_CHECK';
      readonly t: number;
      readonly station: string;
      readonly levelFt: number;
      readonly why: 'not_started' | 'departed';
    }
  /** A CPDLC message the station does not handle (answered "not supported"). */
  | {
      readonly type: 'ATC_UNSUPPORTED';
      readonly t: number;
      readonly station: string;
      readonly text: string;
    };

export interface RopsState {
  readonly v: 1;
  /** FIR the aircraft is in. */
  readonly fir: string | null;
  /** Station the aircraft is logged on to. */
  readonly connected: string | null;
  /** HANDOVER sent: the old station listens until `until` for the aircraft's LOGOFF. */
  readonly handover: { readonly from: string; readonly to: string; readonly until: number } | null;
  /** Last uplink `min` per station. */
  readonly min: Readonly<Record<string, number>>;
  /** FIR where the station stepped aside for a live controller. */
  readonly aside: string | null;
  /** The flight is on block: no more listening. */
  readonly ended: boolean;
  /** Phase of the last tick (T24: the DCL station listens on the ground only). */
  readonly phase?: FlightPhase;
  /** Departure clearance (T24); absent in states saved before it. */
  readonly dcl?: DclState;
  /** Pilot requests (T25); absent in states saved before it. */
  readonly req?: RequestState;
  /** Clearances sent on the station's own (T26); absent in states saved before it. */
  readonly auto?: AutoState;
  /** Oceanic clearance (T27); absent in states saved before it. */
  readonly ocl?: OclState;
  /** Clearances that follow the airline's messages (T48); absent in states saved before it. */
  readonly link?: LinkState;
}

/** The airline's diversion and holding, as the station answered them (T48). */
export interface LinkState {
  /** The diversion airport handled and its clearances sent. */
  readonly divert: {
    readonly icao: string;
    readonly dueAt: number;
    readonly directSent: boolean;
    readonly descentSent: boolean;
  } | null;
  /** The holding handled: the fix held at (navlog index). */
  readonly hold: {
    readonly since: number;
    readonly fixIdx: number | null;
    readonly sent: boolean;
  } | null;
  /** Diversions seen so far (seeds the delay of each). */
  readonly n: number;
}

export interface AutoState {
  /** FIRs already decided for a random Direct To (at most one per FIR, T38). */
  readonly directFirs: readonly string[];
  /** A random Direct To waiting for its delay. */
  readonly directDue: { readonly fir: string; readonly at: number } | null;
  /** The last Direct To given (fix and its index in the navlog); until passed, no new one. */
  readonly directTo: { readonly ident: string; readonly idx: number } | null;
  /** Step climb fixes handled (sent or skipped). */
  readonly steps: readonly string[];
  readonly descent: boolean;
  /** Levels the pilot asked for. */
  readonly asked: readonly number[];
  /** Level clearance sent, waiting for the pilot's WILCO (T47). */
  readonly levelAwait?: { readonly min: number; readonly levelFt: number } | null;
  /** Level clearance accepted, watched for (T47). */
  readonly levelWatch?: {
    readonly levelFt: number;
    readonly startFt: number;
    readonly at: number;
    readonly reached: boolean;
  } | null;
  /** Last level cleared (pilot request or step climb). */
  readonly cleared: number | null;
}

/** A reply waiting for its delay (T25). */
export interface PendingReply {
  readonly due: number;
  readonly station: string;
  readonly mrn: number;
  readonly ra: CpdlcResponse;
  readonly text: string;
  readonly request: string;
  readonly approved: boolean;
  readonly why: RefusalReason | null;
  /** A CLIMB/DESCEND clearance to this level: watched after the WILCO (T47). */
  readonly levelFt?: number;
}

export interface RequestState {
  /** Requests so far (seeds each one's delay and traffic roll). */
  readonly n: number;
  readonly pending: readonly PendingReply[];
  /** The last level decision was a random traffic refusal. */
  readonly lastTraffic: boolean;
  /** Last traffic refusal: request key and time. */
  readonly traffic: { readonly key: string; readonly t: number } | null;
}

/** What the station needs besides the OFP (T24: squawk/DCL seed, the telex display profile). */
export interface RopsDeps {
  readonly seed: string | number;
  readonly profile?: DisplayProfile;
}

export interface RopsTickInput {
  readonly now: number;
  readonly phase: FlightPhase;
  readonly telemetry: TelemetrySnapshot | null;
  /** The aircraft's messages to ROPS stations (`to` set), oldest first. */
  readonly inbound: readonly PilotMessage[];
  readonly ext: ExtState;
  /** The flight's diversion airport (T48), null/absent = none. */
  readonly divert?: string | null;
  /** Holding the airline announced (T48), null/absent = none. */
  readonly hold?: { readonly since: number; readonly min: number } | null;
}

export interface RopsTickOutput {
  readonly outbound: readonly OutboundMessage[];
  readonly events: readonly AtcEvent[];
}

const ENDED: ReadonlySet<FlightPhase> = new Set(['ON_BLOCK', 'TURNAROUND', 'DONE']);
/** Station callsigns ROPS may own: `X` + 3 letters (FIRs, T23; airports, T24). */
export const ROPS_CALLSIGN = /^X[A-Z]{3}$/;

export const EMPTY_ROPS: RopsState = {
  v: 1,
  fir: null,
  connected: null,
  handover: null,
  min: {},
  aside: null,
  ended: false,
};

export class RopsStation {
  private st: {
    fir: string | null;
    connected: string | null;
    handover: { from: string; to: string; until: number } | null;
    min: Record<string, number>;
    aside: string | null;
    ended: boolean;
    phase: FlightPhase;
    req: {
      n: number;
      pending: PendingReply[];
      lastTraffic: boolean;
      traffic: { key: string; t: number } | null;
    };
    auto: {
      directFirs: string[];
      directDue: { fir: string; at: number } | null;
      directTo: { ident: string; idx: number } | null;
      steps: string[];
      descent: boolean;
      asked: number[];
      cleared: number | null;
      levelAwait: { min: number; levelFt: number } | null;
      levelWatch: { levelFt: number; startFt: number; at: number; reached: boolean } | null;
    };
    link: {
      divert: { icao: string; dueAt: number; directSent: boolean; descentSent: boolean } | null;
      hold: { since: number; fixIdx: number | null; sent: boolean } | null;
      n: number;
    };
  };
  private readonly dcl: DclService;
  private readonly ocl: OclService;
  private map: FirMap | null = null;
  private mapOf: readonly FirArea[] | null = null;
  private readonly standAside: boolean;
  private readonly randomDirects: boolean;
  private readonly seed: string | number;

  constructor(
    private readonly ofp: Ofp,
    options: RopsOptions,
    deps: RopsDeps,
    state: RopsState = EMPTY_ROPS,
  ) {
    this.standAside = options.standAside ?? true;
    this.randomDirects = options.randomDirects ?? true;
    this.seed = deps.seed;
    const copy = JSON.parse(JSON.stringify(state)) as RopsState;
    if (copy.v !== 1) throw new Error(`unsupported RopsState version ${String(copy.v)}`);
    this.st = {
      fir: copy.fir,
      connected: copy.connected,
      handover: copy.handover === null ? null : { ...copy.handover },
      min: { ...copy.min },
      aside: copy.aside,
      ended: copy.ended,
      phase: copy.phase ?? 'PREFLIGHT',
      req: {
        n: copy.req?.n ?? 0,
        pending: [...(copy.req?.pending ?? [])],
        lastTraffic: copy.req?.lastTraffic ?? false,
        traffic: copy.req?.traffic ?? null,
      },
      auto: {
        directFirs: [...(copy.auto?.directFirs ?? [])],
        directDue: copy.auto?.directDue ?? null,
        directTo: copy.auto?.directTo ?? null,
        steps: [...(copy.auto?.steps ?? [])],
        descent: copy.auto?.descent ?? false,
        asked: [...(copy.auto?.asked ?? [])],
        cleared: copy.auto?.cleared ?? null,
        levelAwait: copy.auto?.levelAwait ?? null,
        levelWatch: copy.auto?.levelWatch ?? null,
      },
      link: {
        divert: copy.link?.divert ?? null,
        hold: copy.link?.hold ?? null,
        n: copy.link?.n ?? 0,
      },
    };
    this.dcl = new DclService(ofp, deps.seed, deps.profile ?? DEFAULT_PROFILE, copy.dcl);
    this.ocl = new OclService(ofp, deps.seed, deps.profile ?? DEFAULT_PROFILE, copy.ocl);
  }

  getState(): RopsState {
    return JSON.parse(
      JSON.stringify({ v: 1, ...this.st, dcl: this.dcl.getState(), ocl: this.ocl.getState() }),
    ) as RopsState;
  }

  /** Departure clearance station while it is open (T24), or null. */
  get dclStation(): string | null {
    return !this.st.ended && this.dcl.active(this.st.phase) ? this.dcl.station : null;
  }

  /** Station the aircraft should log on to now (the FIR's), or null. */
  get station(): string | null {
    return this.st.fir === null || this.st.ended ? null : ropsStation(this.st.fir);
  }

  get connected(): string | null {
    return this.st.connected;
  }

  get fir(): string | null {
    return this.st.fir;
  }

  /** Callsigns to poll now: the FIR's station, the connected one, a handover's old one. */
  get listen(): readonly string[] {
    if (this.st.ended) return [];
    const out = new Set<string>();
    if (this.station !== null) out.add(this.station);
    if (this.st.connected !== null) out.add(this.st.connected);
    if (this.st.handover !== null) out.add(this.st.handover.from);
    const dcl = this.dclStation;
    if (dcl !== null) out.add(dcl);
    return [...out].sort();
  }

  tick(input: RopsTickInput): RopsTickOutput {
    const outbound: OutboundMessage[] = [];
    const events: AtcEvent[] = [];
    const now = input.now;
    const send = (
      from: string,
      ra: CpdlcResponse,
      mrn: number | null,
      text: string,
      scenarioId = ROPS_ID,
    ): number => {
      const min = (this.st.min[from] ?? 0) + 1;
      this.st.min[from] = min;
      const cpdlc: CpdlcHeader = { min, mrn, ra };
      outbound.push({
        scenarioId,
        from,
        to: this.ofp.callsign,
        kind: 'cpdlc',
        cpdlc,
        message: formatCpdlc(text),
        t: now,
        toPilot: true,
      });
      return min;
    };
    const sendTelex = (from: string, message: FormattedMessage, scenarioId: string) => {
      outbound.push({
        scenarioId,
        from,
        to: this.ofp.callsign,
        kind: 'telex',
        message,
        t: now,
        toPilot: true,
      });
    };
    const dcl: DclContext = {
      now,
      phase: input.phase,
      ext: input.ext,
      standAside: this.standAside,
      firStation: this.station,
      sendCpdlc: send,
      sendTelex,
      events,
    };

    // The flight is over: messages to the stations are not answered.
    if (this.st.ended) return { outbound, events };
    // The DCL station listens from the phase of the tick on.
    const before = this.listen;
    this.st.phase = input.phase;

    const map = this.firMap(input.ext);
    const ocl: OclContext = {
      now,
      telemetry: input.telemetry,
      natTracks: input.ext.natTracks ?? [],
      firAt: (p) => map?.locate(p)?.id ?? null,
      sendTelex,
      events,
    };
    if (this.st.handover !== null && now >= this.st.handover.until) this.st.handover = null;

    // 0. Replies to requests whose delay is over (T25).
    this.flushReplies(now, send, events);

    // 1. The aircraft's messages, in order (to the DCL station or the FIR stations).
    for (const m of input.inbound) {
      if (m.to === this.dcl.station && before.includes(m.to)) this.dcl.receive(m, dcl);
      else this.receive(m, input, map, send, events, ocl);
    }
    this.dcl.tick(dcl);
    this.ocl.tick(ocl);

    // 2. Position → FIR; a boundary crossed hands over or steps aside.
    if (map !== null) {
      const pos: LatLon = input.telemetry ?? this.ofp.origin;
      const area = map.locate(pos);
      if (area !== null && area.id !== this.st.fir) {
        this.st.fir = area.id;
        const station = ropsStation(area.id);
        events.push({
          type: 'ATC_STATION',
          t: now,
          fir: area.id,
          station,
          unit: atcUnitName(area),
        });
        const old = this.st.connected;
        if (old !== null && old !== station) {
          const live = this.live(input.ext, area.id, now);
          if (live !== null) {
            this.stepAside(old, area.id, live, send, events, now);
          } else {
            send(old, 'NE', null, `HANDOVER @${station}`);
            this.st.handover = { from: old, to: station, until: now + HANDOVER_LISTEN_MS };
            this.st.connected = null;
            events.push({ type: 'ATC_HANDOVER', t: now, from: old, to: station });
          }
        }
      }
    }

    // 3. A live controller came online in the FIR of a connected aircraft.
    const fir = this.st.fir;
    if (fir !== null) {
      const live = this.live(input.ext, fir, now);
      if (live === null) {
        if (this.st.aside === fir) this.st.aside = null;
      } else if (this.st.aside !== fir) {
        const connected = this.st.connected;
        if (connected !== null) this.stepAside(connected, fir, live, send, events, now);
        else {
          this.st.aside = fir;
          events.push({
            type: 'ATC_LIVE',
            t: now,
            fir,
            callsign: live.callsign,
            frequency: live.frequency,
          });
        }
      }
    }

    // T26: clearances on the station's own.
    this.autoClearances(input, map, send, events);
    this.airlineLink(input, send, events);
    this.watchLevel(input, send, events);

    // 4. On block: the service ends.
    if (ENDED.has(input.phase)) {
      const connected = this.st.connected;
      if (connected !== null) {
        send(connected, 'NE', null, 'LOGOFF');
        events.push({ type: 'ATC_LOGOFF', t: now, station: connected, by: 'atc' });
      }
      this.st.connected = null;
      this.st.handover = null;
      this.st.ended = true;
      this.st.req.pending = [];
    }
    return { outbound, events };
  }

  private receive(
    m: PilotMessage,
    input: RopsTickInput,
    map: FirMap | null,
    send: (from: string, ra: CpdlcResponse, mrn: number | null, text: string) => number,
    events: AtcEvent[],
    ocl: OclContext,
  ): void {
    const to = m.to ?? '';
    if (m.from.toUpperCase() !== this.ofp.callsign.toUpperCase()) return;
    if (m.type.toLowerCase() !== 'cpdlc') {
      // T49: a telex to a FIR station (the PDC request meant for the airport's, mostly) is not
      // taken; tell the pilot instead of dropping it silently.
      if (m.type.toLowerCase() === 'telex' && this.listen.includes(to)) {
        const pdc = parseDclRequest(m.text) !== null;
        events.push({
          type: 'ATC_MISROUTED',
          t: input.now,
          station: to,
          role: 'fir',
          packet: 'telex',
          what: pdc ? 'pdc_request' : 'other',
          target: pdc ? this.dclStation : null,
        });
      }
      return;
    }
    const p = parseCpdlc(m.text);
    // Only stations we run now answer (the transport polls no others).
    if (p === null || !this.listen.includes(to)) return;
    const now = input.now;

    if (p.text === 'REQUEST LOGON') {
      const station = this.station;
      if (station === null || to !== station) {
        send(to, 'NE', p.min, station === null ? 'UNABLE' : `UNABLE@_@LOGON TO @${station}@`);
        events.push({
          type: 'ATC_LOGON',
          t: now,
          station: to,
          accepted: false,
          reason: 'wrong_station',
          expected: station,
        });
        return;
      }
      const fir = this.st.fir as string;
      const live = this.live(input.ext, fir, now);
      if (live !== null) {
        send(to, 'NE', p.min, `UNABLE@_@${liveText(live)}`);
        events.push({
          type: 'ATC_LOGON',
          t: now,
          station: to,
          accepted: false,
          reason: 'live_atc',
        });
        return;
      }
      const area = map?.get(fir) ?? null;
      send(to, 'NE', p.min, 'LOGON ACCEPTED');
      send(to, 'NE', null, `CURRENT ATC UNIT@_@${to}@_@${area === null ? to : atcUnitName(area)}`);
      this.st.connected = to;
      if (this.st.handover?.to === to) this.st.handover = null;
      events.push({ type: 'ATC_LOGON', t: now, station: to, accepted: true, reason: null });
      return;
    }
    if (p.text === 'LOGOFF') {
      if (this.st.connected === to) this.st.connected = null;
      if (this.st.handover?.from === to) this.st.handover = null;
      events.push({ type: 'ATC_LOGOFF', t: now, station: to, by: 'pilot' });
      return;
    }
    // T27: the pilot's acknowledgement of an oceanic clearance (CLA), and an RCL. FlyByWire
    // shows our telex CLX as a free-text uplink that expects ROGER (its `mrn` is not one of
    // ours); no other uplink of the station expects a ROGER.
    if (this.ocl.awaitingCla && /^ROGER\b/.test(p.text)) {
      this.ocl.acknowledge(ocl);
      return;
    }
    const rcl = parseRcl(p.text);
    if (rcl !== null && this.ocl.receive(rcl, to, ocl)) return;
    // T47: the WILCO to a level clearance of ours starts the watch on the level.
    const wait = this.st.auto.levelAwait;
    if (wait !== null && p.mrn === wait.min) {
      this.st.auto.levelAwait = null;
      const alt = input.telemetry?.altFt ?? null;
      if (/^WILCO\b/.test(p.text) && alt !== null) {
        this.st.auto.levelWatch = { levelFt: wait.levelFt, startFt: alt, at: now, reached: false };
      }
    }
    // T47: MAYDAY / PAN (DM56 / DM55) is answered at once and starts the airline's chain.
    const emergency = p.mrn === null ? /^(MAYDAY|PAN)\b/.exec(p.text) : null;
    if (emergency !== null) {
      const kind = emergency[1] as 'MAYDAY' | 'PAN';
      send(to, 'NE', p.min, `ROGER ${kind}`);
      events.push({ type: 'ATC_EMERGENCY', t: now, station: to, kind });
      return;
    }
    // Answers to our messages need nothing (no open dialogues in T23). Fenix A320 answers
    // `STDBY` for STANDBY (test flight 2026-10-10, docs/07 T38).
    if (p.mrn !== null && /^(WILCO|UNABLE|ROGER|STANDBY|STDBY|AFFIRM|NEGATIVE)\b/.test(p.text))
      return;
    // T25: requests to the station the aircraft is logged on to.
    const req = to === this.st.connected ? parseRequest(p.text) : null;
    if (req !== null) {
      this.request(req, p.text, p.min, to, input, map);
      return;
    }
    // A packet with `mrn` is a reply to a message of ours, whatever its wording: never "not
    // supported" (a request carries no `mrn`).
    if (p.mrn !== null) return;
    send(to, 'NE', p.min, 'MESSAGE NOT SUPPORTED BY THIS ATS UNIT');
    events.push({ type: 'ATC_UNSUPPORTED', t: now, station: to, text: p.text });
  }

  /** Decides a request now; the reply waits for its seeded delay (T25). */
  private request(
    req: AtcRequest,
    text: string,
    mrn: number,
    station: string,
    input: RopsTickInput,
    map: FirMap | null,
  ): void {
    const tm = input.telemetry;
    const decision = decide(req, {
      ofp: this.ofp,
      altFt: tm?.altFt ?? null,
      route: tm === null ? null : routePosition(this.ofp, tm),
      fir: this.st.fir,
      firAt: (p) => map?.locate(p)?.id ?? null,
    });
    const r = this.st.req;
    const rng = createRng(`${this.seed}/#req/${r.n}`);
    r.n += 1;
    const due = input.now + rng.int(REPLY_DELAY_S[0], REPLY_DELAY_S[1]) * 1000;
    let reply: Pick<PendingReply, 'approved' | 'text' | 'ra' | 'why'> = decision;
    if (req.kind === 'level') {
      let traffic = false;
      if (decision.approved) {
        const key = `level:${req.levelFt}`;
        const held = r.traffic?.key === key ? r.traffic : null;
        if (held !== null) {
          // The same request again: the traffic is still there for 5 min.
          traffic = input.now - held.t < TRAFFIC_HOLD_MS;
          if (!traffic) r.traffic = null;
        } else if (!r.lastTraffic && rng.chance(TRAFFIC_REFUSAL)) {
          traffic = true;
          r.traffic = { key, t: input.now };
        }
        if (traffic) {
          reply = { approved: false, text: 'UNABLE@_@DUE TO TRAFFIC', ra: 'N', why: 'traffic' };
        }
      }
      r.lastTraffic = traffic;
      // T26: a step climb the pilot asked for is not sent again; a cleared level counts.
      const a = this.st.auto;
      if (!a.asked.includes(req.levelFt)) a.asked.push(req.levelFt);
      if (reply.approved) a.cleared = req.levelFt;
    }
    r.pending.push({
      due,
      station,
      mrn,
      request: text,
      approved: reply.approved,
      text: reply.text,
      ra: reply.ra,
      why: reply.why,
      ...(req.kind === 'level' && /^(CLIMB|DESCEND) TO /.test(reply.text)
        ? { levelFt: req.levelFt }
        : {}),
    });
  }

  /** A CLIMB/DESCEND clearance went out as `min`: its WILCO starts the watch (T47). */
  private awaitLevel(min: number, levelFt: number): void {
    this.st.auto.levelAwait = { min, levelFt };
    this.st.auto.levelWatch = null;
  }

  /**
   * Random Direct To, step climbs and the descent clearance (T26, `auto.ts`): only to a
   * logged-on aircraft with telemetry, not while a live controller has the FIR.
   */
  private autoClearances(
    input: RopsTickInput,
    map: FirMap | null,
    send: (from: string, ra: CpdlcResponse, mrn: number | null, text: string) => number,
    events: AtcEvent[],
  ): void {
    const station = this.st.connected;
    const tm = input.telemetry;
    const phase = input.phase;
    if (station === null || tm === null || (phase !== 'CRUISE' && phase !== 'DESCENT')) return;
    const a = this.st.auto;
    // T48: a diversion or a holding replaces the clearances of the old route.
    if ((input.divert ?? null) !== null || (input.hold ?? null) !== null) {
      a.directDue = null;
      return;
    }
    const route = routePosition(this.ofp, tm);
    const now = input.now;
    const uplink = (kind: 'direct' | 'step' | 'descent', text: string, levelFt?: number) => {
      const min = send(station, 'WU', null, text);
      events.push({ type: 'ATC_AUTO', t: now, station, kind, text });
      if (levelFt !== undefined) this.awaitLevel(min, levelFt);
    };
    const span = cruiseSpan(this.ofp);

    // Descent: 20 NM before TOD, once, unless a lower level is already cleared.
    if (!a.descent && span !== null && span.tod - route.alongNm <= DESCENT_BEFORE_TOD_NM) {
      a.descent = true;
      const level = descentLevel(this.ofp, route);
      const below = a.cleared !== null && a.cleared < tm.altFt - 500;
      if (level !== null && !below && level.levelFt < tm.altFt - 1000) {
        uplink('descent', `DESCEND TO @${level.text}@`, level.levelFt);
        a.cleared = level.levelFt;
      }
      a.directDue = null;
      return;
    }
    if (phase !== 'CRUISE') return;

    // Step climbs of the OFP.
    for (const step of this.ofp.stepClimbs) {
      if (a.steps.includes(step.ident)) continue;
      const status = stepStatus(this.ofp, step, route, tm.gsKt, this.st.fir);
      if (status === 'wait') continue;
      a.steps.push(step.ident);
      const done =
        a.asked.includes(step.levelFt) ||
        (a.cleared !== null && a.cleared >= step.levelFt) ||
        tm.altFt >= step.levelFt - 200;
      if (status === 'due' && !done) {
        uplink('step', `CLIMB TO @${levelText(step.levelFt, true)}@`, step.levelFt);
        a.cleared = step.levelFt;
      }
    }

    // Random Direct To (T38): decided once per FIR at the first contact in cruise.
    if (!this.randomDirects) return;
    const fir = this.st.fir;
    if (fir === null || span === null) return;
    const given = a.directTo;
    const blocked = given !== null && route.next <= given.idx;
    if (a.directDue === null && !a.directFirs.includes(fir)) {
      if (span.tod - route.alongNm <= DIRECT_TOD_MARGIN_NM) return;
      a.directFirs.push(fir);
      const d = directDecision(this.seed, fir);
      if (d.issue) a.directDue = { fir, at: now + d.delayMs };
      return;
    }
    const due = a.directDue;
    if (due === null || now < due.at) return;
    a.directDue = null;
    // The aircraft left the FIR or is near TOD meanwhile, or is still on the last Direct To.
    if (due.fir !== fir || blocked || span.tod - route.alongNm <= DIRECT_TOD_MARGIN_NM) return;
    const exit = directExit(
      this.ofp,
      tm,
      route,
      fir,
      (p) => map?.locate(p)?.id ?? null,
      given?.idx ?? -1,
    );
    if (exit !== null) {
      a.directTo = { ident: exit.fix.ident, idx: exit.idx };
      uplink('direct', `PROCEED DIRECT TO @${exit.fix.ident}@`);
    }
  }

  /**
   * The airline's diversion and holding reach the aircraft through the station (T48): a
   * diversion → `PROCEED DIRECT TO <airport>` (UM74) 20–60 s later (seeded) and a descent to
   * 10000 ft when the airport is within 3 NM per 1000 ft + 20 NM; a holding → `HOLD AT <fix>
   * AS PUBLISHED MAINTAIN <level>` (UM92) with `EXPECT FURTHER CLEARANCE AT <time>` (UM93), at
   * the first fix ahead from the STAR's entry on, and `PROCEED DIRECT TO <next fix>` when the
   * airline ends it. Only to a logged-on aircraft with telemetry; without a logon (or with a
   * live controller) the airline's message is all.
   */
  private airlineLink(
    input: RopsTickInput,
    send: (from: string, ra: CpdlcResponse, mrn: number | null, text: string) => number,
    events: AtcEvent[],
  ): void {
    const now = input.now;
    const l = this.st.link;
    const divert = input.divert ?? null;
    const hold = input.hold ?? null;
    const station = this.st.connected;
    const tm = input.telemetry;
    const uplink = (kind: 'divert' | 'hold', text: string) => {
      send(station as string, 'WU', null, text);
      events.push({ type: 'ATC_AUTO', t: now, station: station as string, kind, text });
    };

    // Diversion.
    if (divert === null) l.divert = null;
    else if (l.divert?.icao !== divert) {
      const rng = createRng(`${this.seed}/#divert/${l.n}`);
      l.n += 1;
      l.divert = {
        icao: divert,
        dueAt: now + rng.int(REPLY_DELAY_S[0], REPLY_DELAY_S[1]) * 1000,
        directSent: false,
        descentSent: false,
      };
    }
    const dv = l.divert;
    if (dv !== null && station !== null && tm !== null && !tm.onGround) {
      if (!dv.directSent && now >= dv.dueAt) {
        dv.directSent = true;
        uplink('divert', `PROCEED DIRECT TO @${dv.icao}@`);
      }
      if (dv.directSent && !dv.descentSent) {
        const apt = [this.ofp.origin, this.ofp.destination, ...this.ofp.alternates].find(
          (a) => a.icao === dv.icao,
        );
        // An airport the OFP does not know has no position: no descent is computed for it.
        if (apt === undefined || tm.altFt <= DIVERT_DESCENT_FT + 1000) dv.descentSent = true;
        else {
          const need = ((tm.altFt - DIVERT_DESCENT_FT) / 1000) * 3 + DIVERT_DESCENT_MARGIN_NM;
          if (distanceNm(tm, apt) <= need) {
            dv.descentSent = true;
            uplink('divert', `DESCEND TO @${levelText(DIVERT_DESCENT_FT, false)}@`);
            this.st.auto.cleared = DIVERT_DESCENT_FT;
          }
        }
      }
    }

    // Holding.
    const navlog = this.ofp.navlog;
    if (hold === null) {
      const h = l.hold;
      l.hold = null;
      if (h?.sent && station !== null && h.fixIdx !== null) {
        const next = navlog.findIndex((f, i) => i > (h.fixIdx as number) && f.type !== 'ltlg');
        const fix = next < 0 ? undefined : navlog[next];
        if (fix !== undefined) uplink('hold', `PROCEED DIRECT TO @${fix.ident}@`);
      }
    } else if (l.hold === null && station !== null && tm !== null && !tm.onGround) {
      const route = routePosition(this.ofp, tm);
      const star = starEntryIndex(navlog);
      const idx = navlog.findIndex(
        (f, i) => i >= Math.max(route.next, star ?? 0) && f.type !== 'ltlg' && f.type !== 'apt',
      );
      l.hold = { since: hold.since, fixIdx: idx < 0 ? null : idx, sent: false };
      const fix = idx < 0 ? undefined : navlog[idx];
      if (fix !== undefined) {
        l.hold.sent = true;
        const level = Math.round(tm.altFt / 1000) * 1000;
        const efc = new Date(now + hold.min * 60_000);
        const hhmm = `${String(efc.getUTCHours()).padStart(2, '0')}${String(efc.getUTCMinutes()).padStart(2, '0')}`;
        uplink(
          'hold',
          `HOLD AT @${fix.ident}@ AS PUBLISHED MAINTAIN @${levelText(level, level >= 18_000)}@`,
        );
        uplink('hold', `EXPECT FURTHER CLEARANCE AT @${hhmm}@`);
      }
    }
  }

  /**
   * Level watch (T47): five minutes after the WILCO the aircraft has not begun to change level,
   * or it left the assigned level after reaching it → `CONFIRM ASSIGNED ALTITUDE` (UM135), once
   * per clearance. The watch ends with the logon (handover, logoff).
   */
  private watchLevel(
    input: RopsTickInput,
    send: (from: string, ra: CpdlcResponse, mrn: number | null, text: string) => number,
    events: AtcEvent[],
  ): void {
    const a = this.st.auto;
    const w = a.levelWatch;
    if (w === null) return;
    const station = this.st.connected;
    if (station === null) {
      a.levelWatch = null;
      return;
    }
    const tm = input.telemetry;
    if (tm === null) return;
    const off = Math.abs(tm.altFt - w.levelFt);
    if (off <= LEVEL_AT_FT) w.reached = true;
    let why: 'not_started' | 'departed' | null = null;
    if (w.reached) {
      if (off > LEVEL_DEPART_FT) why = 'departed';
    } else if (
      input.now - w.at >= LEVEL_CHECK_MIN * 60_000 &&
      Math.abs(tm.altFt - w.startFt) < LEVEL_DEPART_FT
    ) {
      why = 'not_started';
    }
    if (why === null) return;
    a.levelWatch = null;
    send(station, 'Y', null, 'CONFIRM ASSIGNED ALTITUDE');
    events.push({
      type: 'ATC_LEVEL_CHECK',
      t: input.now,
      station,
      levelFt: w.levelFt,
      why,
    });
  }

  /** Sends the replies whose delay is over, oldest first. */
  private flushReplies(
    now: number,
    send: (from: string, ra: CpdlcResponse, mrn: number | null, text: string) => number,
    events: AtcEvent[],
  ): void {
    const r = this.st.req;
    const due = r.pending.filter((x) => x.due <= now).sort((a, b) => a.due - b.due);
    if (due.length === 0) return;
    r.pending = r.pending.filter((x) => x.due > now);
    for (const x of due) {
      const min = send(x.station, x.ra, x.mrn, x.text);
      if (x.levelFt !== undefined && x.approved) this.awaitLevel(min, x.levelFt);
      events.push({
        type: 'ATC_REQUEST',
        t: now,
        station: x.station,
        request: x.request,
        approved: x.approved,
        reply: x.text,
        why: x.why,
      });
    }
  }

  /** Notice + LOGOFF from `station`; the FIR's live controller serves the aircraft. */
  private stepAside(
    station: string,
    fir: string,
    live: CenterStation,
    send: (from: string, ra: CpdlcResponse, mrn: number | null, text: string) => void,
    events: AtcEvent[],
    now: number,
  ): void {
    send(station, 'NE', null, liveText(live));
    send(station, 'NE', null, 'LOGOFF');
    this.st.connected = null;
    this.st.aside = fir;
    events.push({
      type: 'ATC_LIVE',
      t: now,
      fir,
      callsign: live.callsign,
      frequency: live.frequency,
    });
    events.push({ type: 'ATC_LOGOFF', t: now, station, by: 'atc' });
  }

  /** A live centre covering `fir` in fresh VATSIM data, if stepping aside is on. */
  private live(ext: ExtState, fir: string, now: number): CenterStation | null {
    if (!this.standAside) return null;
    const t = ext.centersT ?? null;
    if (ext.centers == null || t === null || now - t > ATC_MAX_AGE_MS) return null;
    const list = ext.centers.filter((c) => c.firs.includes(fir));
    // The station named after the FIR first, then by callsign (stable).
    list.sort(
      (a, b) =>
        Number(b.callsign.startsWith(`${fir}_`)) - Number(a.callsign.startsWith(`${fir}_`)) ||
        (a.callsign < b.callsign ? -1 : a.callsign > b.callsign ? 1 : 0),
    );
    return list[0] ?? null;
  }

  private firMap(ext: ExtState): FirMap | null {
    const firs = ext.firs ?? null;
    if (firs === null || firs.length === 0) return null;
    if (firs !== this.mapOf) {
      this.map = new FirMap(firs);
      this.mapOf = firs;
    }
    return this.map;
  }
}

function liveText(c: CenterStation): string {
  return `VATSIM ATC ONLINE@_@CONTACT ${c.callsign} @${c.frequency}@`;
}
