import { distanceNm, interpolate, type LatLon } from '../geo/geo.js';
import type { Ofp } from '../ofp/types.js';

/**
 * External data (T13, docs/06 "Внешние данные") as the core sees it. The core never fetches:
 * the app's adapters (`@acars/data-sources`) fetch, cache and pass the results in as
 * `CoreInput.data` — an input like telemetry, recorded in the flight recording, so a replay
 * gives the same messages (invariant 4). Everything here is plain JSON.
 *
 * Missing data is normal (no network, API down, airport without METAR): scenarios read
 * `wx.*` / `ext.*` as null and use their fallback variants (graceful degradation).
 */

/** Latest METAR/TAF of an airport. */
export interface WxReport {
  readonly metar: string | null;
  readonly taf: string | null;
  /** METAR observation time, epoch ms UTC. */
  readonly obsTime: number | null;
}

export type AtcFacility = 'DEL' | 'GND' | 'TWR' | 'APP' | 'ATIS';

/** An online VATSIM station serving an airport (callsign, frequency — no personal data). */
export interface AtcStation {
  readonly callsign: string;
  readonly facility: AtcFacility;
  /** MHz, `119.900`. */
  readonly frequency: string;
  /** ATIS letter (facility ATIS only). */
  readonly atisCode: string | null;
}

/** Natural event (NASA EONET), position = latest geometry. */
export interface NaturalEvent {
  readonly id: string;
  /** Upper-case ASCII, safe for a telex. */
  readonly title: string;
  /** EONET category id: `severeStorms`, `wildfires`, `volcanoes`, … */
  readonly category: string;
  readonly lat: number;
  readonly lon: number;
  /** Date of the latest geometry, epoch ms UTC. */
  readonly date: number;
}

/**
 * Status of a space launch (TheSpaceDevs Launch Library 2.3.0 `status.id`, T28): `go` — the
 * T-0 is confirmed (1, Go for Launch); the rest have happened — `in_flight` (6), `success`
 * (3), `deployed` (9, payload deployed), `failure` (4), `partial_failure` (7). Launches with
 * other statuses (TBD, TBC, Hold) are not passed in (approved 2026-10-09).
 */
export type LaunchStatus =
  | 'go'
  | 'in_flight'
  | 'success'
  | 'deployed'
  | 'failure'
  | 'partial_failure';

export const LAUNCH_STATUSES: readonly LaunchStatus[] = [
  'go',
  'in_flight',
  'success',
  'deployed',
  'failure',
  'partial_failure',
];

/** A space launch (T28), position = the pad. Texts are upper-case ASCII, safe for a telex. */
export interface SpaceLaunch {
  /** LL2 launch UUID. */
  readonly id: string;
  /** Rocket, `FALCON 9 BLOCK 5`. */
  readonly rocket: string;
  /** Mission, `SDA TRANCHE 1 TRANSPORT LAYER A`; null when unknown. */
  readonly mission: string | null;
  /** Pad and site, `SLC-4E VANDENBERG SFB, CA, USA`. */
  readonly pad: string;
  readonly lat: number;
  readonly lon: number;
  /** T-0 (NET), epoch ms UTC. */
  readonly net: number;
  /** Launch window, epoch ms UTC; null when not given. */
  readonly windowStart: number | null;
  readonly windowEnd: number | null;
  readonly status: LaunchStatus;
}

/** A parking position or gate of an airport (OSM `aeroway=parking_position|gate`). */
export interface ParkingStand {
  /** `A12`, `V105` — upper-case A–Z0–9. */
  readonly ref: string;
  readonly kind: 'gate' | 'stand';
}

/**
 * A FIR as the ROPS station sees it (T23; VATSpy `Boundaries.geojson` + the name from
 * `VATSpy.dat`, docs/06 "Границы FIR"). Only FIRs near the route are passed in.
 */
export interface FirArea {
  /** `EDGG`. */
  readonly id: string;
  /** VATSpy name, e.g. `Langen`, `Shanwick Oceanic`. */
  readonly name: string;
  readonly oceanic: boolean;
  /**
   * Some airport has this FIR (VATSpy `[Airports]`). False for overlay areas (military, FIS
   * only) that must not win over a FIR; absent in recordings made before the field.
   */
  readonly airports?: boolean;
  /** GeoJSON MultiPolygon coordinates: polygons → rings (outer first) → `[lon, lat]`. */
  readonly polygons: readonly (readonly (readonly (readonly [number, number])[])[])[];
}

/** An online VATSIM centre (CTR) or FSS and the FIRs it covers (T23; no personal data). */
export interface CenterStation {
  readonly callsign: string;
  /** MHz, `136.125`. */
  readonly frequency: string;
  /** FIR ids (`EDGG`); a UIR station lists all its FIRs. */
  readonly firs: readonly string[];
}

/** FIR and country of an airport of the flight (T24; VATSpy `[Airports]`, `[Countries]`). */
export interface AirportInfo {
  readonly fir: string | null;
  readonly country: string | null;
}

/** A frequency of an airport (T24; OurAirports `airport-frequencies.csv`, public domain). */
export interface AirportFrequency {
  /** OurAirports type: `DEL`, `CLD`, `GND`, `TWR`, `APP`, `DEP`, `ATIS` … */
  readonly type: string;
  /** MHz as given, e.g. `121.8`. */
  readonly mhz: string;
}

/**
 * One data update, passed with a tick. Each field replaces what the core knew of it:
 * `wx` per airport (null = fetched, no report), `atc` per airport of the flight, `events`
 * the whole list, `stands` the destination's list.
 */
export interface ExtDataUpdate {
  /** When the data was fetched, epoch ms UTC (app clock). */
  readonly t: number;
  readonly wx?: Readonly<Record<string, WxReport | null>>;
  readonly atc?: Readonly<Record<string, readonly AtcStation[]>>;
  readonly events?: readonly NaturalEvent[];
  readonly stands?: { readonly icao: string; readonly list: readonly ParkingStand[] };
  /** FIRs along the route (T23); replaces the list. */
  readonly firs?: readonly FirArea[];
  /** Online VATSIM centres (T23); replaces the list. */
  readonly centers?: readonly CenterStation[];
  /** FIR and country of the origin and destination (T24). */
  readonly airports?: Readonly<Record<string, AirportInfo>>;
  /** Frequencies of the departure airport (T24). */
  readonly freqs?: { readonly icao: string; readonly list: readonly AirportFrequency[] };
  /** Space launches in the time window of the flight (T28); replaces the list. */
  readonly launches?: readonly SpaceLaunch[];
}

/** A natural event placed against the planned route (once, when it arrives). */
export interface RoutedEvent extends NaturalEvent {
  /** Route distance from the origin to the route point nearest the event, NM. */
  readonly alongNm: number;
  /** Distance from that route point to the event, NM. */
  readonly offNm: number;
}

/** A space launch placed against the planned route (once, when it arrives; T28). */
export interface RoutedLaunch extends SpaceLaunch {
  /** Route distance from the origin to the route point nearest the pad, NM. */
  readonly alongNm: number;
  /** Distance from that route point to the pad, NM. */
  readonly offNm: number;
}

export interface ExtState {
  readonly wx: Readonly<Record<string, (WxReport & { readonly t: number }) | null>>;
  readonly atc: Readonly<Record<string, readonly AtcStation[]>> | null;
  readonly atcT: number | null;
  readonly events: readonly RoutedEvent[];
  readonly stands: readonly ParkingStand[] | null;
  /** The arrival gate went out in a message: stand updates no longer change it. */
  readonly gateLocked: boolean;
  /** FIRs along the route (T23); absent in states saved before T23. */
  readonly firs?: readonly FirArea[] | null;
  readonly centers?: readonly CenterStation[] | null;
  readonly centersT?: number | null;
  /** T24; absent in states saved before T24. */
  readonly airports?: Readonly<Record<string, AirportInfo>> | null;
  readonly freqs?: { readonly icao: string; readonly list: readonly AirportFrequency[] } | null;
  /** T28; absent in states saved before T28. */
  readonly launches?: readonly RoutedLaunch[];
}

export const EMPTY_EXT: ExtState = {
  wx: {},
  atc: null,
  atcT: null,
  events: [],
  stands: null,
  gateLocked: false,
};

/** A METAR older than this is no longer "live" (the station probably stopped reporting). */
export const WX_MAX_AGE_MS = 3 * 3_600_000;
/** VATSIM data older than this is not shown. */
export const ATC_MAX_AGE_MS = 20 * 60_000;
/** Events farther than this from the route are ignored. */
export const EVENT_CORRIDOR_NM = 150;
/** Launch pads farther than this from the route are ignored (docs/07 T28). */
export const LAUNCH_CORRIDOR_NM = 300;

const ICAO = /^[A-Z0-9]{3,4}$/;
const REF = /^[A-Z0-9]{1,6}$/;
const FIR = /^[A-Z]{4}$/;

export class ExtDataError extends Error {
  override readonly name = 'ExtDataError';
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const strOrNull = (x: unknown) => x === null || typeof x === 'string';

/** Shape check of an update (it comes from the app or a recording file). Throws ExtDataError. */
export function checkExtDataUpdate(x: unknown): ExtDataUpdate {
  const bad = (why: string): never => {
    throw new ExtDataError(`data update: ${why}`);
  };
  if (!isObj(x) || !isNum(x['t'])) return bad('t');
  const { wx, atc, events, stands, firs, centers, airports, freqs, launches } = x;
  if (wx !== undefined) {
    if (!isObj(wx)) bad('wx');
    for (const [icao, r] of Object.entries(wx as object)) {
      if (!ICAO.test(icao)) bad(`wx key ${icao}`);
      if (r === null) continue;
      if (!isObj(r) || !strOrNull(r['metar']) || !strOrNull(r['taf'])) bad(`wx.${icao}`);
      const o = (r as Record<string, unknown>)['obsTime'];
      if (!(o === null || isNum(o))) bad(`wx.${icao}.obsTime`);
    }
  }
  if (atc !== undefined) {
    if (!isObj(atc)) bad('atc');
    for (const [icao, list] of Object.entries(atc as object)) {
      if (!ICAO.test(icao) || !Array.isArray(list)) bad(`atc.${icao}`);
      for (const s of list as unknown[]) {
        if (
          !isObj(s) ||
          typeof s['callsign'] !== 'string' ||
          typeof s['frequency'] !== 'string' ||
          !['DEL', 'GND', 'TWR', 'APP', 'ATIS'].includes(s['facility'] as string) ||
          !strOrNull(s['atisCode'])
        )
          bad(`atc.${icao} station`);
      }
    }
  }
  if (events !== undefined) {
    if (!Array.isArray(events)) bad('events');
    for (const e of events as unknown[]) {
      if (
        !isObj(e) ||
        typeof e['id'] !== 'string' ||
        typeof e['title'] !== 'string' ||
        typeof e['category'] !== 'string' ||
        !isNum(e['lat']) ||
        !isNum(e['lon']) ||
        !isNum(e['date'])
      )
        bad('events item');
    }
  }
  if (stands !== undefined) {
    if (!isObj(stands) || typeof stands['icao'] !== 'string' || !Array.isArray(stands['list']))
      bad('stands');
    for (const s of (stands as { list: unknown[] }).list) {
      if (
        !isObj(s) ||
        !REF.test(String(s['ref'])) ||
        (s['kind'] !== 'gate' && s['kind'] !== 'stand')
      )
        bad('stands item');
    }
  }
  if (firs !== undefined) {
    if (!Array.isArray(firs)) bad('firs');
    for (const f of firs as unknown[]) {
      if (
        !isObj(f) ||
        !FIR.test(String(f['id'])) ||
        typeof f['name'] !== 'string' ||
        typeof f['oceanic'] !== 'boolean' ||
        !(f['airports'] === undefined || typeof f['airports'] === 'boolean') ||
        !isPolygons(f['polygons'])
      )
        bad('firs item');
    }
  }
  if (centers !== undefined) {
    if (!Array.isArray(centers)) bad('centers');
    for (const c of centers as unknown[]) {
      if (
        !isObj(c) ||
        typeof c['callsign'] !== 'string' ||
        typeof c['frequency'] !== 'string' ||
        !Array.isArray(c['firs']) ||
        !(c['firs'] as unknown[]).every((f) => FIR.test(String(f)))
      )
        bad('centers item');
    }
  }
  if (airports !== undefined) {
    if (!isObj(airports)) bad('airports');
    for (const [icao, a] of Object.entries(airports as object)) {
      if (!ICAO.test(icao) || !isObj(a)) bad(`airports.${icao}`);
      const r = a as Record<string, unknown>;
      if (!(r['fir'] === null || FIR.test(String(r['fir']))) || !strOrNull(r['country'])) {
        bad(`airports.${icao}`);
      }
    }
  }
  if (freqs !== undefined) {
    if (!isObj(freqs) || typeof freqs['icao'] !== 'string' || !Array.isArray(freqs['list']))
      bad('freqs');
    for (const f of (freqs as { list: unknown[] }).list) {
      if (!isObj(f) || typeof f['type'] !== 'string' || typeof f['mhz'] !== 'string') {
        bad('freqs item');
      }
    }
  }
  if (launches !== undefined) {
    if (!Array.isArray(launches)) bad('launches');
    const numOrNull = (v: unknown) => v === null || isNum(v);
    for (const l of launches as unknown[]) {
      if (
        !isObj(l) ||
        typeof l['id'] !== 'string' ||
        typeof l['rocket'] !== 'string' ||
        !strOrNull(l['mission']) ||
        typeof l['pad'] !== 'string' ||
        !isNum(l['lat']) ||
        !isNum(l['lon']) ||
        Math.abs(l['lat'] as number) > 90 ||
        Math.abs(l['lon'] as number) > 180 ||
        !isNum(l['net']) ||
        !numOrNull(l['windowStart']) ||
        !numOrNull(l['windowEnd']) ||
        !LAUNCH_STATUSES.includes(l['status'] as LaunchStatus)
      )
        bad('launches item');
    }
  }
  return x as unknown as ExtDataUpdate;
}

const isPolygons = (x: unknown): boolean =>
  Array.isArray(x) &&
  x.every(
    (rings: unknown) =>
      Array.isArray(rings) &&
      rings.length > 0 &&
      rings.every(
        (ring: unknown) =>
          Array.isArray(ring) &&
          ring.length >= 4 &&
          ring.every(
            (pt: unknown) =>
              Array.isArray(pt) &&
              pt.length === 2 &&
              isNum(pt[0]) &&
              isNum(pt[1]) &&
              Math.abs(pt[0]) <= 180 &&
              Math.abs(pt[1]) <= 90,
          ),
      ),
  );

/** Applies an update. Stands are only for the destination and only until the gate went out. */
export function applyExtData(
  state: ExtState,
  u: ExtDataUpdate,
  ofp: Ofp,
  route: RoutePolyline,
): ExtState {
  let next = state;
  if (u.wx !== undefined) {
    const wx = { ...next.wx };
    for (const [icao, r] of Object.entries(u.wx)) wx[icao] = r === null ? null : { ...r, t: u.t };
    next = { ...next, wx };
  }
  if (u.atc !== undefined) next = { ...next, atc: { ...u.atc }, atcT: u.t };
  if (u.events !== undefined) {
    const events = u.events
      .map((e) => ({ ...e, ...route.locate(e) }))
      .filter((e) => e.offNm <= EVENT_CORRIDOR_NM)
      .sort((a, b) => a.alongNm - b.alongNm || (a.id < b.id ? -1 : 1));
    next = { ...next, events };
  }
  if (u.launches !== undefined) {
    const launches = u.launches
      .map((l) => ({ ...l, ...route.locate(l) }))
      .filter((l) => l.offNm <= LAUNCH_CORRIDOR_NM)
      .sort((a, b) => a.alongNm - b.alongNm || (a.id < b.id ? -1 : 1));
    next = { ...next, launches };
  }
  if (u.firs !== undefined) next = { ...next, firs: [...u.firs] };
  if (u.centers !== undefined) next = { ...next, centers: [...u.centers], centersT: u.t };
  if (u.airports !== undefined) next = { ...next, airports: { ...u.airports } };
  if (u.freqs !== undefined)
    next = { ...next, freqs: { icao: u.freqs.icao, list: [...u.freqs.list] } };
  if (
    u.stands !== undefined &&
    u.stands.icao === ofp.destination.icao &&
    !next.gateLocked &&
    u.stands.list.length > 0
  ) {
    next = { ...next, stands: [...u.stands.list] };
  }
  return next;
}

/** Live report of an airport, or null (none, or older than {@link WX_MAX_AGE_MS}). */
export function liveWx(state: ExtState, icao: string | null, now: number): WxReport | null {
  if (icao === null) return null;
  const r = state.wx[icao];
  if (r === undefined || r === null) return null;
  const obs = r.obsTime ?? r.t;
  if (now - obs > WX_MAX_AGE_MS) return null;
  return r;
}

/** True when the core has an answer for the airport (a report or a "no report"). */
export function wxKnown(state: ExtState, icao: string): boolean {
  return icao in state.wx;
}

/**
 * The planned route as a polyline (origin, navlog fixes, destination) with cumulative
 * distances; legs are sampled every ≤ 10 NM to place events against the route.
 */
export class RoutePolyline {
  private readonly pts: readonly (LatLon & { readonly along: number })[];

  constructor(ofp: Ofp) {
    const fixes: (LatLon & { along: number })[] = [
      { lat: ofp.origin.lat, lon: ofp.origin.lon, along: 0 },
    ];
    for (const f of ofp.navlog) fixes.push({ lat: f.lat, lon: f.lon, along: f.cumDistNm });
    const last = fixes.at(-1) as LatLon & { along: number };
    fixes.push({
      lat: ofp.destination.lat,
      lon: ofp.destination.lon,
      along: last.along + distanceNm(last, ofp.destination),
    });
    const pts: (LatLon & { along: number })[] = [];
    for (let i = 0; i < fixes.length; i++) {
      const a = fixes[i] as LatLon & { along: number };
      pts.push(a);
      const b = fixes[i + 1];
      if (b === undefined) break;
      const leg = distanceNm(a, b);
      const n = Math.floor(leg / 10);
      for (let k = 1; k < n; k++) {
        const p = interpolate(a, b, k / n);
        pts.push({ ...p, along: a.along + ((b.along - a.along) * k) / n });
      }
    }
    this.pts = pts;
  }

  /** Nearest sampled route point to `p`: its route distance and the offset. */
  locate(p: LatLon): { alongNm: number; offNm: number } {
    let best = { alongNm: 0, offNm: Number.POSITIVE_INFINITY };
    for (const q of this.pts) {
      const d = distanceNm(p, q);
      if (d < best.offNm) best = { alongNm: q.along, offNm: d };
    }
    return { alongNm: Math.round(best.alongNm), offNm: Math.round(best.offNm) };
  }
}

/** `Q1013` / `A2992` group of a METAR (the last one, after any remarks-free part), or null. */
export function metarQnh(metar: string): string | null {
  const body = metar.split(/\sRMK\s/)[0] as string;
  const m = /(?:^|\s)([QA])(\d{4})(?=\s|=|$)/.exec(body);
  return m === null ? null : `${m[1]}${m[2]}`;
}

/** Stations of an airport in display order (ATIS, DEL, GND, TWR, APP), then by callsign. */
export function sortStations(list: readonly AtcStation[]): AtcStation[] {
  const order: readonly AtcFacility[] = ['ATIS', 'DEL', 'GND', 'TWR', 'APP'];
  return [...list].sort(
    (a, b) =>
      order.indexOf(a.facility) - order.indexOf(b.facility) ||
      (a.callsign < b.callsign ? -1 : a.callsign > b.callsign ? 1 : 0),
  );
}
