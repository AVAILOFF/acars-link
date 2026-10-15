import {
  type AirportFrequency,
  ATC_MAX_AGE_MS,
  type AtcStation,
  type ExtState,
} from '../ext/data.js';
import { type FormattedMessage, formatMessage } from '../format/formatter.js';
import type { DisplayProfile } from '../format/profile.js';
import type { Ofp } from '../ofp/types.js';
import type { FlightPhase } from '../phase/fsm.js';
import { createRng } from '../random/rng.js';
import { normalizePilotText, type PilotMessage } from '../scenario/pilot.js';
import { type CpdlcResponse, parseCpdlc } from './cpdlc.js';
import { ropsStation } from './fir.js';
import { assignSquawk, type Squawk } from './squawk/squawk.js';

/**
 * Departure clearance by data link (T24, docs/07): the pilot sends the Hoppie request telex
 * `REQUEST PREDEP CLEARANCE <callsign> <type> TO <dest> AT <origin> [STAND <x>] ATIS <letter>`
 * (FlyByWire `DclMessage.ts`, TopSky "RCD") to the station `X` + origin (`RCTP` → `XCTP`).
 *
 * - Europe, Asia and the rest: ARINC 623 DCL over Hoppie CPDLC (`cpdlc` packets). FSM "RCD
 *   RECEIVED" at once, the clearance (CLD) after 60–180 s, the pilot's WILCO → FSM "CDA
 *   RECEIVED / CLEARANCE CONFIRMED". Message layout: AIP Singapore eSUP 2018/013 and Malaysia
 *   SUP 02/25 samples, real decoded DCLs (EDDF, EFHK, EGLL, WSSS, VHHH 2022–2025), on the wire
 *   as Hoppie stations send them (TopSky: `@` around the values).
 * - USA: PDC through the airline host — a telex with no pilot answer, laid out like a real
 *   Delta PDC (KMSP 2025-12-29), clearance lines by the fields of FAA JO 7110.113F.
 * Squawk: `squawk/squawk.ts`. Approved assumptions (docs/07 T24, 2026-10-09): CLD after 60–180 s
 * (seeded; the AIPs say "within 5 minutes"); a request is taken any time on the ground before
 * take-off; no cancellation when the pilot does not answer; PDC number 001–999 from the seed;
 * no ADT/start-up lines; no initial altitude (the SID's is not in the OFP).
 * Data the OFP lacks: NEXT FREQ / DPFRQ from live VATSIM, else OurAirports, else left out.
 */

export const DCL_ID = '#dcl';

/** Delay of the clearance after the request, ms (approved 2026-10-09). */
export const DCL_DELAY_MS: readonly [number, number] = [60_000, 180_000];

const GROUND: ReadonlySet<FlightPhase> = new Set(['PREFLIGHT', 'BOARDING', 'PUSHBACK', 'TAXI_OUT']);

export type DclRejectReason = 'bad_request' | 'no_sid' | 'live_atc';

export type DclEvent =
  | {
      readonly type: 'ATC_DCL';
      readonly t: number;
      readonly station: string;
      readonly what: 'request' | 'confirmed' | 'unable';
    }
  | {
      readonly type: 'ATC_DCL_CLEARANCE';
      readonly t: number;
      readonly station: string;
      readonly format: 'arinc623' | 'us_pdc';
      readonly squawk: string;
      readonly squawkSource: Squawk['source'];
    }
  /**
   * A message reached a station that does not take it (T49): the aircraft's FMS sent it to the
   * wrong ROPS station. Nothing goes to the network; the app tells the pilot where to send it.
   */
  | {
      readonly type: 'ATC_MISROUTED';
      readonly t: number;
      /** The station the message was sent to. */
      readonly station: string;
      /** Its role: the FIR station takes CPDLC only, the airport station takes the PDC only. */
      readonly role: 'fir' | 'dcl';
      readonly packet: 'telex' | 'cpdlc';
      readonly what: 'pdc_request' | 'logon' | 'other';
      /** The station to send it to (PDC request: the airport's; logon: the FIR's), or null. */
      readonly target: string | null;
    }
  | {
      readonly type: 'ATC_DCL_REJECTED';
      readonly t: number;
      readonly station: string;
      readonly reason: DclRejectReason;
      readonly detail: string | null;
    };

export interface DclState {
  /** Valid requests so far (seeds the delay of each). */
  readonly requests: number;
  /** ATIS letter of the request waiting for its clearance. */
  readonly pending: { readonly dueAt: number; readonly atis: string | null } | null;
  readonly squawk: Squawk | null;
  /** CLD sent and waiting for WILCO: its `min`. */
  readonly awaiting: number | null;
  readonly done: boolean;
}

export const EMPTY_DCL: DclState = {
  requests: 0,
  pending: null,
  squawk: null,
  awaiting: null,
  done: false,
};

/** What the DCL service needs from the station: senders and the context of the tick. */
export interface DclContext {
  readonly now: number;
  readonly phase: FlightPhase;
  readonly ext: ExtState;
  readonly standAside: boolean;
  /** The FIR station the aircraft should log on to now (T49 hints), null before the FIR is known. */
  readonly firStation: string | null;
  readonly sendCpdlc: (
    from: string,
    ra: CpdlcResponse,
    mrn: number | null,
    text: string,
    scenarioId: string,
  ) => number;
  readonly sendTelex: (from: string, message: FormattedMessage, scenarioId: string) => void;
  /** Events of the tick; the DCL service only pushes its own ({@link DclEvent}). */
  readonly events: { push(e: DclEvent): unknown };
}

const PHONETIC: Readonly<Record<string, string>> = {
  ALFA: 'A',
  ALPHA: 'A',
  BRAVO: 'B',
  CHARLIE: 'C',
  DELTA: 'D',
  ECHO: 'E',
  FOXTROT: 'F',
  GOLF: 'G',
  HOTEL: 'H',
  INDIA: 'I',
  JULIETT: 'J',
  JULIET: 'J',
  KILO: 'K',
  LIMA: 'L',
  MIKE: 'M',
  NOVEMBER: 'N',
  OSCAR: 'O',
  PAPA: 'P',
  QUEBEC: 'Q',
  ROMEO: 'R',
  SIERRA: 'S',
  TANGO: 'T',
  UNIFORM: 'U',
  VICTOR: 'V',
  WHISKEY: 'W',
  XRAY: 'X',
  YANKEE: 'Y',
  ZULU: 'Z',
};

export interface DclRequest {
  readonly callsign: string;
  readonly destination: string;
  readonly origin: string;
  readonly atis: string | null;
}

/** Parses the request telex (any case and separators); null = not a request. */
export function parseDclRequest(text: string): DclRequest | null {
  const t = normalizePilotText(text);
  const m =
    /^REQUEST PREDEP CLEARANCE ([A-Z0-9]+) [A-Z0-9]+ TO ([A-Z]{4}) AT ([A-Z]{4})(?: STAND [A-Z0-9]+)?(?: ATIS ([A-Z]+))?/.exec(
      t,
    );
  if (m === null) return null;
  const word = m[4] ?? null;
  const atis = word === null ? null : word.length === 1 ? word : (PHONETIC[word] ?? null);
  return { callsign: m[1] as string, destination: m[2] as string, origin: m[3] as string, atis };
}

export class DclService {
  readonly station: string;
  private st: {
    requests: number;
    pending: { dueAt: number; atis: string | null } | null;
    squawk: Squawk | null;
    awaiting: number | null;
    done: boolean;
  };

  constructor(
    private readonly ofp: Ofp,
    private readonly seed: string | number,
    private readonly profile: DisplayProfile,
    state: DclState = EMPTY_DCL,
  ) {
    this.station = ropsStation(ofp.origin.icao);
    const copy = JSON.parse(JSON.stringify(state)) as DclState;
    this.st = {
      requests: copy.requests,
      pending: copy.pending === null ? null : { ...copy.pending },
      squawk: copy.squawk,
      awaiting: copy.awaiting,
      done: copy.done,
    };
  }

  getState(): DclState {
    return JSON.parse(JSON.stringify(this.st)) as DclState;
  }

  /** Listened to on the ground before take-off, until the exchange is over. */
  active(phase: FlightPhase): boolean {
    return !this.st.done && GROUND.has(phase);
  }

  receive(m: PilotMessage, c: DclContext): void {
    if (m.from.toUpperCase() !== this.ofp.callsign.toUpperCase()) return;
    const type = m.type.toLowerCase();
    if (type === 'cpdlc') {
      const p = parseCpdlc(m.text);
      if (p === null) return;
      if (this.st.awaiting === null || p.mrn !== this.st.awaiting) {
        // An opening message (a logon, a request) is meant for the FIR station (T49); a stray
        // answer with an `mrn` is not.
        if (p.mrn === null) {
          const logon = p.text === 'REQUEST LOGON';
          c.events.push({
            type: 'ATC_MISROUTED',
            t: c.now,
            station: this.station,
            role: 'dcl',
            packet: 'cpdlc',
            what: logon ? 'logon' : 'other',
            target: logon ? c.firStation : null,
          });
        }
        return;
      }
      if (p.text.startsWith('WILCO')) {
        c.sendCpdlc(
          this.station,
          'NE',
          null,
          `FSM ${stamp(c.now)} ${this.ofp.origin.icao} @${this.ofp.callsign}@ CDA RECEIVED @CLEARANCE CONFIRMED`,
          DCL_ID,
        );
        c.events.push({ type: 'ATC_DCL', t: c.now, station: this.station, what: 'confirmed' });
      } else if (p.text.startsWith('UNABLE')) {
        c.events.push({ type: 'ATC_DCL', t: c.now, station: this.station, what: 'unable' });
      } else {
        return;
      }
      this.st.awaiting = null;
      this.st.done = true;
      return;
    }
    if (type !== 'telex') return;
    const req = parseDclRequest(m.text);
    if (req === null) {
      c.events.push({
        type: 'ATC_MISROUTED',
        t: c.now,
        station: this.station,
        role: 'dcl',
        packet: 'telex',
        what: 'other',
        target: null,
      });
      return;
    }
    c.events.push({ type: 'ATC_DCL', t: c.now, station: this.station, what: 'request' });
    const o = this.ofp;
    if (
      req.callsign !== o.callsign.toUpperCase() ||
      req.destination !== o.destination.icao ||
      req.origin !== o.origin.icao
    ) {
      this.reject(c, 'bad_request', null);
      return;
    }
    const live = this.live(c);
    if (live !== null) {
      this.reject(c, 'live_atc', `${live.callsign} ${live.frequency}`);
      return;
    }
    if (o.sid === null || o.origin.planRwy === null) {
      this.reject(c, 'no_sid', null);
      return;
    }
    this.st.requests++;
    const rng = createRng(`${this.seed}/#dcl/${this.st.requests}`);
    const [min, max] = DCL_DELAY_MS;
    this.st.pending = { dueAt: c.now + rng.int(min / 1000, max / 1000) * 1000, atis: req.atis };
    this.st.awaiting = null;
    if (!this.us(c.ext)) {
      c.sendCpdlc(
        this.station,
        'NE',
        null,
        `FSM ${stamp(c.now)} ${o.origin.icao} @${o.callsign}@ RCD RECEIVED @REQUEST BEING PROCESSED @STANDBY`,
        DCL_ID,
      );
    }
  }

  tick(c: DclContext): void {
    const p = this.st.pending;
    if (p === null || c.now < p.dueAt) return;
    this.st.pending = null;
    const squawk = this.squawk(c.ext);
    if (this.us(c.ext)) {
      c.sendTelex(this.station, formatMessage(this.usPdc(c, squawk.code), this.profile), DCL_ID);
      // A PDC has no pilot answer (TopSky 1.4): the exchange is over.
      this.st.done = true;
      c.events.push({
        type: 'ATC_DCL_CLEARANCE',
        t: c.now,
        station: this.station,
        format: 'us_pdc',
        squawk: squawk.code,
        squawkSource: squawk.source,
      });
      return;
    }
    const o = this.ofp;
    const freq = nextFreq(c, o.origin.icao);
    const text = [
      `CLD ${stamp(c.now)} ${o.origin.icao} PDC ${this.pdcNumber()}`,
      `@${o.callsign}@ CLRD TO @${o.destination.icao}@ OFF @${o.origin.planRwy}@ VIA @${o.sid}@`,
      `SQUAWK @${squawk.code}@`,
      ...(freq === null ? [] : [`NEXT FREQ @${freq}@`]),
      ...(p.atis === null ? [] : [`ATIS @${p.atis}@`]),
    ].join(' ');
    this.st.awaiting = c.sendCpdlc(this.station, 'WU', null, text, DCL_ID);
    c.events.push({
      type: 'ATC_DCL_CLEARANCE',
      t: c.now,
      station: this.station,
      format: 'arinc623',
      squawk: squawk.code,
      squawkSource: squawk.source,
    });
  }

  private reject(c: DclContext, reason: DclRejectReason, detail: string | null): void {
    const o = this.ofp;
    if (this.us(c.ext)) {
      c.sendTelex(this.station, formatMessage('UNABLE REVERT TO VOICE', this.profile), DCL_ID);
    } else {
      c.sendCpdlc(
        this.station,
        'NE',
        null,
        `FSM ${stamp(c.now)} ${o.origin.icao} @${o.callsign}@ RCD REJECTED @REVERT TO VOICE PROCEDURES`,
        DCL_ID,
      );
    }
    c.events.push({ type: 'ATC_DCL_REJECTED', t: c.now, station: this.station, reason, detail });
  }

  /** The US PDC (approved layout, docs/07 T24). */
  private usPdc(c: DclContext, squawk: string): string {
    const o = this.ofp;
    const fl = String(Math.round(o.initialAltitudeFt / 100));
    const route = o.route
      .trim()
      .split(/\s+/)
      .filter((w) => w !== '');
    const after = route[route.indexOf(o.sid ?? '') + 1];
    // The transition is the fix after the SID in the route (`ZMBRO7 ODI` → ODI TRSN).
    const trans =
      route.includes(o.sid ?? '') && after !== undefined && /^[A-Z]{2,5}$/.test(after)
        ? ` ${after} TRSN`
        : '';
    const dep = depFreq(c, o.origin.icao);
    const sked = new Date(o.times.schedOutMs).toISOString().slice(11, 16).replace(':', '');
    return [
      `PDC ${o.flightNumber ?? o.callsign} ${o.origin.iata ?? o.origin.icao} ${o.destination.iata ?? o.destination.icao}`,
      '**** PREDEPARTURE  CLEARANCE ****',
      `${o.callsign} DEPARTING ${o.origin.icao}  TRANSPONDER ${squawk}`,
      `SKED DEP TIME ${sked}   EQUIP  ${o.aircraft.icao}`,
      `FILED FLT LEVEL ${fl}`,
      '-CLEARED AS FILED-',
      `${o.origin.icao} ${route.join(' ')} ${o.destination.icao}`,
      `CLEARED ${o.sid} DEPARTURE${trans}`,
      'CLB VIA SID',
      `EXP ${fl} 10 MIN AFT DP${dep === null ? '' : `,DPFRQ ${dep}`}`,
      `XPCT RWY ${o.origin.planRwy}`,
    ].join('\n');
  }

  private us(ext: ExtState): boolean {
    const country = ext.airports?.[this.ofp.origin.icao]?.country ?? null;
    return country === null ? /^K[A-Z]{3}$/.test(this.ofp.origin.icao) : country === 'USA';
  }

  private squawk(ext: ExtState): Squawk {
    if (this.st.squawk !== null) return this.st.squawk;
    const o = this.ofp;
    const info = ext.airports ?? {};
    const sq = assignSquawk(
      {
        origin: o.origin.icao,
        destination: o.destination.icao,
        originFir: info[o.origin.icao]?.fir ?? null,
        destinationFir: info[o.destination.icao]?.fir ?? null,
        routeFirs: (ext.firs ?? []).map((f) => f.id),
        originCountry: info[o.origin.icao]?.country ?? null,
        destinationCountry: info[o.destination.icao]?.country ?? null,
      },
      createRng(`${this.seed}/#squawk`),
    );
    this.st.squawk = sq;
    return sq;
  }

  private pdcNumber(): string {
    return String(createRng(`${this.seed}/#pdc`).int(1, 999)).padStart(3, '0');
  }

  /** A live VATSIM clearance, ground or tower controller at the origin (fresh data). */
  private live(c: DclContext): AtcStation | null {
    if (!c.standAside) return null;
    const t = c.ext.atcT;
    if (c.ext.atc === null || t === null || c.now - t > ATC_MAX_AGE_MS) return null;
    const list = c.ext.atc[this.ofp.origin.icao] ?? [];
    for (const f of ['DEL', 'GND', 'TWR'] as const) {
      const s = list.find((x) => x.facility === f);
      if (s !== undefined) return s;
    }
    return null;
  }
}

/** `HHMM YYMMDD` UTC, the time/date group of FSM and CLD. */
function stamp(now: number): string {
  const iso = new Date(now).toISOString();
  return `${iso.slice(11, 13)}${iso.slice(14, 16)} ${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}`;
}

function freshAtc(c: DclContext, icao: string): readonly AtcStation[] {
  const t = c.ext.atcT;
  if (c.ext.atc === null || t === null || c.now - t > ATC_MAX_AGE_MS) return [];
  return c.ext.atc[icao] ?? [];
}

function ourAirports(
  c: DclContext,
  icao: string,
  types: readonly string[],
): AirportFrequency | null {
  const f = c.ext.freqs;
  if (f == null || f.icao !== icao) return null;
  for (const type of types) {
    const hit = f.list.find((x) => x.type === type);
    if (hit !== undefined) return hit;
  }
  return null;
}

/** NEXT FREQ of a DCL: live delivery or ground, else OurAirports, as `121.800`. */
function nextFreq(c: DclContext, icao: string): string | null {
  const live = freshAtc(c, icao);
  for (const f of ['DEL', 'GND'] as const) {
    const s = live.find((x) => x.facility === f);
    if (s !== undefined) return mhz(s.frequency, 3);
  }
  const oa = ourAirports(c, icao, ['DEL', 'CLD', 'GND']);
  return oa === null ? null : mhz(oa.mhz, 3);
}

/** DPFRQ of a US PDC: live approach/departure, else OurAirports DEP/APP, as `124.7`. */
function depFreq(c: DclContext, icao: string): string | null {
  const s = freshAtc(c, icao).find((x) => x.facility === 'APP');
  if (s !== undefined) return mhz(s.frequency, 1);
  const oa = ourAirports(c, icao, ['DEP', 'APP']);
  return oa === null ? null : mhz(oa.mhz, 1);
}

/** MHz with at least `min` decimals and no trailing zeros beyond them. */
function mhz(value: string, min: number): string | null {
  const v = Number(value);
  if (!(v >= 118 && v < 137)) return null;
  const s = v.toFixed(3);
  let end = s.length;
  while (end > s.indexOf('.') + 1 + min && s[end - 1] === '0') end--;
  return s.slice(0, end);
}
