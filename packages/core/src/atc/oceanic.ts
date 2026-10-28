// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { NatTrack } from '../ext/data.js';
import { type FormattedMessage, formatMessage } from '../format/formatter.js';
import type { DisplayProfile } from '../format/profile.js';
import type { LatLon } from '../geo/geo.js';
import type { Ofp, OfpFix } from '../ofp/types.js';
import { createRng } from '../random/rng.js';
import type { TelemetrySnapshot } from '../telemetry/types.js';
import { checkLevel } from './levels.js';
import { routePosition } from './route.js';

/**
 * Oceanic clearance in the North Atlantic (T27, docs/07; sources in docs/06 "Океанический
 * клиренс"). The pilot sends an RCL (request for clearance) — on Hoppie the FlyByWire
 * `OclMessage` CPDLC packet `OCEANIC REQUEST <callsign> ENTRY POINT:<OEP> AT:<hhmm>Z
 * REQ:M.<mach> FL<level> [MAX F<level>]` to the station it is logged on to — and the
 * station answers for the first NAT oceanic area of the route after the OEP:
 *
 * - Shanwick (EGGX) still issues clearances (NAT OPS Bulletin 2023_001 rev 6, 25 Feb 2026):
 *   `RCL RECEIVED`, then the CLX (layout: NAT OPS Bulletin 2020_001 rev 01, §12, the
 *   Shanwick example), then the pilot's acknowledgement (CLA: ROGER/WILCO) and `CLA RECEIVED
 *   CLEARANCE CONFIRMED END OF MESSAGE`; no CLA within 10 min — `CLEARANCE CANCELLED REVERT
 *   TO VOICE PROCEDURES` (2020_001 §7.1).
 * - Gander, Santa Maria, Bodø (oceanic clearance removed, 2023_001 rev 6): `RCL RECEIVED BY
 *   <ANSP>` only.
 * - Reykjavik and New York need no RCL: `RCL NOT REQUIRED BY <BIRD|KZWY>`.
 * Errors and windows before the OEP: 2020_001 §4.5, §10 and 2023_001 rev 6 §2.2.
 *
 * Replies are telexes from the station the RCL went to (approved 2026-10-09): the real CLX
 * is an ACARS (ARINC 623) message with `/` in it, not CPDLC, and FlyByWire takes a telex
 * from that station as the answer. Approved assumptions (docs/07 T27, 2026-10-09): NAT only;
 * the window is checked against our estimate of the time to the OEP (route distance / ground
 * speed), the pilot's ETO only goes into `FM <OEP>/<ETO>`; the route is the OFP's points after
 * the OEP up to the exit point; `NAT <letter>` when they are an active track (natTrak), else
 * `RANDOM ROUTE`; the level the pilot asked for when the track (or the level table of T25)
 * allows it, else the nearest allowed one not above MAX (`ATC/ LEVEL CHANGE`); the Mach as
 * asked; the CLX 2–10 min after the RCL (seeded).
 */

export const OCL_ID = '#ocl';

/** Delay of the CLX after the RCL, s (approved 2026-10-09). */
export const CLX_DELAY_S: readonly [number, number] = [120, 600];
/** No CLA within this time cancels the clearance (2020_001 §7.1, Shanwick). */
export const CLA_TIMEOUT_MS = 10 * 60_000;

/** NAT oceanic control areas (2023_001 rev 6, definitions). */
export type NatOca = 'EGGX' | 'CZQX' | 'BIRD' | 'ENOB' | 'LPPO' | 'KZWY';

interface OcaRule {
  /** Name in `RCL RECEIVED BY …` and in the voice instruction. */
  readonly name: string;
  readonly mode: 'clearance' | 'rcl' | 'not_required';
  /** RCL window before the OEP, minutes: [earliest, latest]; null = no limit. */
  readonly window: readonly [number | null, number];
}

/** 2023_001 rev 6 §2 and §2.2; 2020_001 §4.5. */
export const NAT_OCA: Readonly<Record<NatOca, OcaRule>> = {
  EGGX: { name: 'SHANWICK', mode: 'clearance', window: [90, 30] },
  CZQX: { name: 'GANDER', mode: 'rcl', window: [90, 60] },
  LPPO: { name: 'SANTA MARIA', mode: 'rcl', window: [null, 40] },
  ENOB: { name: 'BODO', mode: 'rcl', window: [null, 20] },
  BIRD: { name: 'REYKJAVIK', mode: 'not_required', window: [null, 0] },
  KZWY: { name: 'NEW YORK', mode: 'not_required', window: [null, 0] },
};

/**
 * FIR ids (SimBrief `fir` of the navlog, else VATSpy) of the NAT OCAs. ICAO Gander is CZQX
 * (domestic and oceanic), VATSpy has `CZQO`; New York Oceanic is KZWY, VATSpy `KZNY`.
 */
const OCA_OF: Readonly<Record<string, NatOca>> = {
  EGGX: 'EGGX',
  CZQX: 'CZQX',
  CZQO: 'CZQX',
  BIRD: 'BIRD',
  ENOB: 'ENOB',
  LPPO: 'LPPO',
  KZWY: 'KZWY',
  KZNY: 'KZWY',
};

export interface Rcl {
  readonly callsign: string;
  readonly oep: string;
  /** `1348`; null when missing. */
  readonly eto: string | null;
  /** Hundredths: 82 = M.82; null when missing or invalid. */
  readonly mach: number | null;
  readonly levelFt: number | null;
  /** `MAX F380` of the free text; null = the requested level is the highest (rev 6). */
  readonly maxFt: number | null;
}

/** Parses an RCL (FlyByWire layout, any spacing); null = not an RCL. */
export function parseRcl(text: string): Rcl | null {
  const t = text.toUpperCase().replace(/\s+/g, ' ').trim();
  if (!t.startsWith('OCEANIC REQUEST')) return null;
  const callsign = /^OCEANIC REQUEST ([A-Z0-9]+)/.exec(t)?.[1] ?? '';
  const oep = /ENTRY POINT:\s?([A-Z0-9]+)/.exec(t)?.[1] ?? '';
  const eto = /\bAT:\s?(\d{4})Z?\b/.exec(t)?.[1] ?? null;
  const req = /\bREQ:\s?M?\.?(\d{1,2})\s(?:FL|F)?(\d{2,3})\b/.exec(t);
  let mach: number | null = null;
  let levelFt: number | null = null;
  if (req !== null) {
    const m = Number(req[1]);
    mach = m < 10 ? m * 10 : m;
    levelFt = Number(req[2]) * 100;
  }
  const max = /\bMAX\s?(?:FL|F)?\s?(\d{2,3})\b/.exec(t);
  return {
    callsign,
    oep,
    eto: eto !== null && Number(eto.slice(0, 2)) < 24 && Number(eto.slice(2)) < 60 ? eto : null,
    mach,
    levelFt,
    maxFt: max === null ? null : Number(max[1]) * 100,
  };
}

/** A clearance as issued (to compare a reclearance with). */
export interface OceanicClearance {
  readonly oep: string;
  readonly route: string;
  readonly track: string | null;
  readonly levelFt: number;
  readonly mach: number;
}

export interface OclState {
  /** Clearances computed so far (seeds each one's delay and number). */
  readonly n: number;
  /** A CLX waiting for its delay. */
  readonly pending: {
    readonly due: number;
    readonly station: string;
    readonly clearance: OceanicClearance;
    /** The pilot's ETO at the OEP and requested level, the CLX number. */
    readonly eto: string;
    readonly requestedFt: number;
    readonly number: string;
  } | null;
  /** CLX sent, waiting for the CLA. */
  readonly awaiting: {
    readonly station: string;
    readonly until: number;
    readonly clearance: OceanicClearance;
  } | null;
  /** The last confirmed clearance. */
  readonly cleared: OceanicClearance | null;
  /** Reclearances so far (the `RECLEARANCE n` line). */
  readonly reclearances: number;
}

export const EMPTY_OCL: OclState = {
  n: 0,
  pending: null,
  awaiting: null,
  cleared: null,
  reclearances: 0,
};

export type OclWhat =
  | 'received'
  | 'not_required'
  | 'rejected'
  | 'clearance'
  | 'confirmed'
  | 'cancelled';

export interface OclEvent {
  readonly type: 'ATC_OCL';
  readonly t: number;
  readonly station: string;
  /** The NAT OCA that answered. */
  readonly oca: NatOca;
  readonly what: OclWhat;
  /** Rejection reason or the cleared route/level/Mach. */
  readonly detail: string | null;
}

export interface OclContext {
  readonly now: number;
  readonly telemetry: TelemetrySnapshot | null;
  readonly natTracks: readonly NatTrack[];
  /** FIR at a point (VATSpy), for fixes without SimBrief's `fir`. */
  readonly firAt: (p: LatLon) => string | null;
  readonly sendTelex: (from: string, message: FormattedMessage, scenarioId: string) => void;
  readonly events: { push(e: OclEvent): unknown };
}

/** The oceanic part of the route after an OEP. */
interface OceanicLeg {
  readonly oep: OfpFix;
  readonly oepIndex: number;
  /** Lat/long points after the OEP and the named exit point (when there is one). */
  readonly points: readonly OfpFix[];
  readonly oca: NatOca;
}

export class OclService {
  private st: {
    n: number;
    pending: OclState['pending'];
    awaiting: OclState['awaiting'];
    cleared: OceanicClearance | null;
    reclearances: number;
  };

  constructor(
    private readonly ofp: Ofp,
    private readonly seed: string | number,
    private readonly profile: DisplayProfile,
    state: OclState = EMPTY_OCL,
  ) {
    const copy = JSON.parse(JSON.stringify(state)) as OclState;
    this.st = { ...copy };
  }

  getState(): OclState {
    return JSON.parse(JSON.stringify(this.st)) as OclState;
  }

  /** A CLX is out and the pilot's acknowledgement is due. */
  get awaitingCla(): boolean {
    return this.st.awaiting !== null;
  }

  /**
   * An RCL to `station`. Returns false when it is not one for the NAT (the station then
   * answers as to any message it does not handle).
   */
  receive(rcl: Rcl, station: string, c: OclContext): boolean {
    const o = this.ofp;
    const leg = this.oceanicLeg(rcl.oep, c);
    if (leg === null) {
      // No oceanic part after this OEP: an RCL to a NAT area with a wrong OEP, or no NAT.
      const anyNat = this.firstNatOca(c);
      if (anyNat === null) return false;
      this.reject(c, station, anyNat, 'INVALID OEP\nRESUBMIT YOUR REQUEST', 'oep');
      return true;
    }
    const rule = NAT_OCA[leg.oca];
    const say = (text: string, what: OclWhat, detail: string | null = null) => {
      c.sendTelex(station, formatMessage(text, this.profile), OCL_ID);
      c.events.push({ type: 'ATC_OCL', t: c.now, station, oca: leg.oca, what, detail });
    };
    if (rule.mode === 'not_required') {
      say(`RCL NOT REQUIRED BY ${leg.oca}`, 'not_required');
      return true;
    }
    if (rcl.callsign !== o.callsign.toUpperCase()) {
      this.reject(c, station, leg.oca, 'FLIGHT PLAN NOT HELD', 'callsign');
      return true;
    }
    if (rcl.eto === null) {
      this.reject(c, station, leg.oca, 'INVALID OEP\nRESUBMIT YOUR REQUEST', 'eto');
      return true;
    }
    if (rcl.mach === null || rcl.mach < 61 || rcl.mach > 92) {
      this.reject(c, station, leg.oca, 'INVALID MACH NO\nRESUBMIT YOUR REQUEST', 'mach');
      return true;
    }
    if (rcl.levelFt === null || rcl.levelFt % 1000 !== 0 || rcl.levelFt < 5000) {
      this.reject(c, station, leg.oca, 'INVALID LEVEL\nRESUBMIT YOUR REQUEST', 'level');
      return true;
    }
    const minutes = this.minutesTo(leg.oep, c.telemetry);
    const [early, late] = rule.window;
    if (early !== null && minutes > early) {
      this.reject(c, station, leg.oca, 'RCL SENT TOO EARLY', `${Math.round(minutes)} min`);
      return true;
    }
    if (minutes < late) {
      this.reject(
        c,
        station,
        leg.oca,
        'RCL RECEIVED TOO LATE REVERT TO VOICE PROCEDURES',
        `${Math.round(minutes)} min`,
      );
      return true;
    }
    if (rule.mode === 'rcl') {
      say(`RCL RECEIVED BY ${rule.name}`, 'received');
      return true;
    }

    // Shanwick: the clearance.
    if (this.st.pending !== null || this.st.awaiting !== null) {
      this.reject(
        c,
        station,
        leg.oca,
        'REQUEST BEING PROCESSED AWAIT TRANSACTION COMPLETION',
        'busy',
      );
      return true;
    }
    const track = this.track(leg, minutes, c);
    const level = this.level(rcl, leg, track);
    if (level === null) {
      say(
        'RCL/CLA RECEIVED NEGOTIATION REQUIRED CONTACT SHANWICK BY VOICE',
        'rejected',
        'no level',
      );
      return true;
    }
    say('RCL RECEIVED\nIF NO CLEARANCE WITHIN 15 MINUTES CONTACT SHANWICK BY VOICE', 'received');
    const clearance: OceanicClearance = {
      oep: leg.oep.ident,
      route: leg.points.map(pointText).join(' '),
      track: track?.ident ?? null,
      levelFt: level,
      mach: rcl.mach,
    };
    this.st.n += 1;
    const rng = createRng(`${this.seed}/#ocl/${this.st.n}`);
    const due = c.now + rng.int(CLX_DELAY_S[0], CLX_DELAY_S[1]) * 1000;
    const number = String(rng.int(1, 999)).padStart(3, '0');
    this.st.pending = {
      due,
      station,
      clearance,
      eto: rcl.eto,
      requestedFt: rcl.levelFt,
      number,
    };
    return true;
  }

  /** The pilot's ROGER/WILCO to the CLX (the CLA). */
  acknowledge(c: OclContext): void {
    const a = this.st.awaiting;
    if (a === null) return;
    c.sendTelex(
      a.station,
      formatMessage('CLA RECEIVED\nCLEARANCE CONFIRMED\nEND OF MESSAGE', this.profile),
      OCL_ID,
    );
    if (this.st.cleared !== null) this.st.reclearances += 1;
    this.st.cleared = a.clearance;
    this.st.awaiting = null;
    c.events.push({
      type: 'ATC_OCL',
      t: c.now,
      station: a.station,
      oca: 'EGGX',
      what: 'confirmed',
      detail: null,
    });
  }

  tick(c: OclContext): void {
    const a = this.st.awaiting;
    if (a !== null && c.now >= a.until) {
      this.st.awaiting = null;
      c.sendTelex(
        a.station,
        formatMessage('CLEARANCE CANCELLED REVERT TO VOICE PROCEDURES', this.profile),
        OCL_ID,
      );
      c.events.push({
        type: 'ATC_OCL',
        t: c.now,
        station: a.station,
        oca: 'EGGX',
        what: 'cancelled',
        detail: null,
      });
    }
    const p = this.st.pending;
    if (p === null || c.now < p.due) return;
    this.st.pending = null;
    c.sendTelex(p.station, formatMessage(this.clx(p, c.now), this.profile), OCL_ID);
    this.st.awaiting = {
      station: p.station,
      until: c.now + CLA_TIMEOUT_MS,
      clearance: p.clearance,
    };
    const k = p.clearance;
    c.events.push({
      type: 'ATC_OCL',
      t: c.now,
      station: p.station,
      oca: 'EGGX',
      what: 'clearance',
      detail: `${k.track === null ? 'RANDOM' : `NAT ${k.track}`} F${k.levelFt / 100} M0${k.mach}`,
    });
  }

  private reject(c: OclContext, station: string, oca: NatOca, why: string, detail: string): void {
    c.sendTelex(station, formatMessage(`RCL REJECTED\n${why}`, this.profile), OCL_ID);
    c.events.push({ type: 'ATC_OCL', t: c.now, station, oca, what: 'rejected', detail });
  }

  /** The CLX text (2020_001 §12, Shanwick example). */
  private clx(p: NonNullable<OclState['pending']>, at: number): string {
    const o = this.ofp;
    const k = p.clearance;
    const prev = this.st.cleared;
    const changes: string[] = [];
    if (prev !== null) {
      if (prev.oep !== k.oep) changes.push('ENTRY POINT CHANGE');
      if (prev.route !== k.route || prev.track !== k.track) changes.push('ROUTE CHANGE');
      if (prev.levelFt !== k.levelFt) changes.push('LEVEL CHANGE');
      if (prev.mach !== k.mach) changes.push('MACH CHANGE');
    } else if (k.levelFt !== p.requestedFt) {
      changes.push('LEVEL CHANGE');
    }
    const atc = [
      ...changes,
      ...(prev !== null ? [`RECLEARANCE ${Math.min(this.st.reclearances + 1, 9)}`] : []),
    ];
    return [
      `CLX ${stamp(at)} EGGX CLRNCE ${p.number}`,
      `${o.callsign.toUpperCase()} CLRD TO ${o.destination.icao} VIA ${k.oep}`,
      k.track === null ? 'RANDOM ROUTE' : `NAT ${k.track}`,
      k.route,
      `FM ${k.oep}/${p.eto} MNTN F${String(k.levelFt / 100).padStart(3, '0')} M0${k.mach}`,
      ...(atc.length > 0 ? [`ATC/ ${atc.join(' ')}`] : []),
      'END OF MESSAGE',
    ].join('\n');
  }

  /** The OEP on the route ahead and the oceanic points after it; null = none. */
  private oceanicLeg(oep: string, c: OclContext): OceanicLeg | null {
    const nav = this.ofp.navlog;
    const flown = c.telemetry === null ? 0 : routePosition(this.ofp, c.telemetry).alongNm;
    const i = nav.findIndex((f) => f.ident === oep && f.cumDistNm >= flown - 1);
    if (i < 0) return null;
    const points: OfpFix[] = [];
    let j = i + 1;
    while (j < nav.length && isLatLong(nav[j] as OfpFix)) points.push(nav[j++] as OfpFix);
    if (points.length === 0) return null;
    const exit = nav[j];
    if (exit !== undefined && !isLatLong(exit) && exit.type !== 'apt') points.push(exit);
    const first = points[0] as OfpFix;
    const oca = OCA_OF[(first.fir ?? c.firAt(first) ?? '').toUpperCase()];
    if (oca === undefined) return null;
    return { oep: nav[i] as OfpFix, oepIndex: i, points, oca };
  }

  /** The first NAT OCA of the route ahead (for an RCL with a wrong OEP). */
  private firstNatOca(c: OclContext): NatOca | null {
    for (const f of this.ofp.navlog) {
      const oca = OCA_OF[(f.fir ?? c.firAt(f) ?? '').toUpperCase()];
      if (oca !== undefined && isLatLong(f)) return oca;
    }
    return null;
  }

  /** Our estimate of the minutes to a fix: ground speed, else the OFP's average speed. */
  private minutesTo(fix: OfpFix, tm: TelemetrySnapshot | null): number {
    const o = this.ofp;
    const along = tm === null ? 0 : routePosition(o, tm).alongNm;
    const nm = Math.max(0, fix.cumDistNm - along);
    const last = o.navlog.at(-1)?.cumDistNm ?? 0;
    const avg = o.times.estTimeEnrouteSec > 0 ? last / (o.times.estTimeEnrouteSec / 3600) : 450;
    const gs = tm !== null && tm.gsKt >= 60 ? tm.gsKt : avg;
    return (nm / gs) * 60;
  }

  /**
   * The active NAT track the oceanic points follow (OEP, the lat/long points, the exit), valid
   * when the aircraft crosses 30W (the track message's validity; else at the OEP).
   */
  private track(leg: OceanicLeg, minutesToOep: number, c: OclContext): NatTrack | null {
    const ours = [leg.oep, ...leg.points];
    const at30 = leg.points.find((p) => Math.abs(p.lon + 30) < 0.01);
    const minutes = at30 === undefined ? minutesToOep : this.minutesTo(at30, c.telemetry);
    const t = c.now + minutes * 60_000;
    for (const k of c.natTracks) {
      if (t < k.validFrom || t > k.validTo || k.route.length !== ours.length) continue;
      const same = k.route.every((p, i) => {
        const f = ours[i] as OfpFix;
        const pos = trackPoint(p);
        return pos === null
          ? f.ident === p
          : Math.abs(f.lat - pos.lat) < 0.01 && Math.abs(f.lon - pos.lon) < 0.01;
      });
      if (same) return k;
    }
    return null;
  }

  /**
   * The cleared level: the request when allowed (the track's levels, else our level table
   * on the first oceanic leg), else the nearest allowed one not above MAX (a tie: the lower).
   * Null = no level at or below MAX.
   */
  private level(rcl: Rcl, leg: OceanicLeg, track: NatTrack | null): number | null {
    const req = rcl.levelFt as number;
    const max = rcl.maxFt ?? req;
    const first = leg.points[0] as OfpFix;
    const allowed = (l: number) =>
      track !== null
        ? track.levelsFt.includes(l)
        : first.trackMag === null || checkLevel(l, leg.oca, first.trackMag, null).ok;
    if (req <= max && allowed(req)) return req;
    let best: number | null = null;
    for (let l = 10_000; l <= max; l += 1000) {
      if (!allowed(l)) continue;
      if (best === null || Math.abs(l - req) < Math.abs(best - req)) best = l;
    }
    return best;
  }
}

/** A NAT lat/long waypoint of the navlog: SimBrief `ltlg` on a whole or half degree. */
function isLatLong(f: OfpFix): boolean {
  return (
    f.type === 'ltlg' &&
    Math.abs(f.lat * 2 - Math.round(f.lat * 2)) < 1e-6 &&
    Math.abs(f.lon - Math.round(f.lon)) < 1e-6
  );
}

/**
 * A point as written in the clearance: a named fix as is, lat/long as in an ICAO flight plan
 * (Doc 4444 App. 2, item 15): whole degrees `57N020W`, else degrees and minutes `5530N02000W`.
 */
export function pointText(f: Pick<OfpFix, 'ident' | 'type' | 'lat' | 'lon'>): string {
  if (!isLatLong(f as OfpFix)) return f.ident;
  const ns = f.lat >= 0 ? 'N' : 'S';
  const ew = f.lon >= 0 ? 'E' : 'W';
  const lat = Math.abs(f.lat);
  const lon = Math.abs(f.lon);
  const whole = Number.isInteger(lat) && Number.isInteger(lon);
  const dm = (v: number, w: number) => {
    const d = Math.floor(v + 1e-9);
    const m = Math.round((v - d) * 60);
    return `${String(d).padStart(w, '0')}${String(m).padStart(2, '0')}`;
  };
  return whole
    ? `${String(lat).padStart(2, '0')}${ns}${String(lon).padStart(3, '0')}${ew}`
    : `${dm(lat, 2)}${ns}${dm(lon, 3)}${ew}`;
}

/** A track message lat/long point (`63/20`, `6330/20`; NAT longitudes are west); else null. */
export function trackPoint(p: string): LatLon | null {
  const m = /^(\d{2})(\d{2})?\/(\d{2,3})$/.exec(p);
  if (m === null) return null;
  return { lat: Number(m[1]) + Number(m[2] ?? 0) / 60, lon: -Number(m[3]) };
}

/** `HHMM YYMMDD` UTC (2020_001 §12: `CLX 0610 190921 EGGX …`). */
function stamp(now: number): string {
  const iso = new Date(now).toISOString();
  return `${iso.slice(11, 13)}${iso.slice(14, 16)} ${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}`;
}
