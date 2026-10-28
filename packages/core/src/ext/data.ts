// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { VhfStation } from '../datalink/link.js';
import { distanceNm, interpolate, type LatLon } from '../geo/geo.js';
import type { Ofp } from '../ofp/types.js';
import type { ConnexData } from './connex.js';
import type { RouteStatsData } from './routes.js';
import {
  type AshSigmet,
  type AuroraForecast,
  type Earthquake,
  type F1Race,
  type Holidays,
  insidePolygon,
  isNhlFinal,
  NHL_STATES,
  type NhlGame,
  type NhlState,
  type SpaceWeather,
} from './special.js';

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
  /**
   * The ATIS text of a VATSIM ATIS station (T44), upper-case telex-safe, null = none; absent
   * in older states and recordings.
   */
  readonly atisText?: string | null;
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

/**
 * A North Atlantic organised track (T27): the current NAT track message as natTrak
 * (`nattrak.vatsim.net/api/tracks`) parses it from the NAT NOTAMs.
 */
export interface NatTrack {
  /** Track letter, `A`. */
  readonly ident: string;
  /**
   * Points as in the track message: named fixes (`RATSU`) and lat/long `63/20` (63N 020W)
   * or `6330/20` (63°30'N 020W).
   */
  readonly route: readonly string[];
  /** Validity, epoch ms UTC. */
  readonly validFrom: number;
  readonly validTo: number;
  /** Flight levels of the track, feet. */
  readonly levelsFt: readonly number[];
}

/** A parking position or gate of an airport (OSM `aeroway=parking_position|gate`). */
export interface ParkingStand {
  /** `A12`, `V105` — upper-case A–Z0–9. */
  readonly ref: string;
  readonly kind: 'gate' | 'stand';
}

/**
 * A FIR as the XATC station sees it (T23; VATSpy `Boundaries.geojson` + the name from
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

/** Where an airport the pilot named is (T51; OurAirports `airports.csv`). */
export interface AirportPlace {
  readonly lat: number;
  readonly lon: number;
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
/**
 * An airport a diverting aircraft may be sent to besides those of the OFP (T50): a large or
 * medium airport with scheduled service near the route, with the longest open hard-surface runway
 * (OurAirports `airports.csv` + `runways.csv`).
 */
export interface DivertAirport {
  readonly icao: string;
  readonly lat: number;
  readonly lon: number;
  /** Length of the longest open hard-surface runway, m. */
  readonly rwyM: number;
  /** Its width, m; null when the file has none. */
  readonly widthM: number | null;
  /** `large_airport` (else `medium_airport`). */
  readonly large: boolean;
}

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
  /** Conditional VHF stations (airports) near the route (T31); replaces the list. */
  readonly vhf?: readonly VhfStation[];
  /** Airports to divert to besides the OFP's (T50); replaces the list. */
  readonly divertApts?: readonly DivertAirport[];
  /** Airports the pilot named in a reply (T51), null = the file has none; merged per code. */
  readonly places?: Readonly<Record<string, AirportPlace | null>>;
  /** Space launches in the time window of the flight (T28); replaces the list. */
  readonly launches?: readonly SpaceLaunch[];
  /** Active NAT tracks (T27); replaces the list. */
  readonly natTracks?: readonly NatTrack[];
  /** NOAA space weather scales (T29). */
  readonly spaceWx?: SpaceWeather;
  /** OVATION aurora cells along the route (T29). */
  readonly aurora?: AuroraForecast;
  /** Volcanic ash SIGMETs (T29); replaces the list. */
  readonly ash?: readonly AshSigmet[];
  /** Earthquakes of the last day (USGS, T29); replaces the list. */
  readonly quakes?: readonly Earthquake[];
  /** Public holidays of the destination country (T29). */
  readonly holidays?: Holidays;
  /** The latest F1 race result (T29); null = none in the season yet. */
  readonly f1?: F1Race | null;
  /** NHL games of the current days (T29); merged per game id. */
  readonly nhl?: readonly NhlGame[];
  /** Departures of the airline from the destination (AeroDataBox, T30); replaces the list. */
  readonly connex?: ConnexData;
  /** Route statistics of the destination (AeroDataBox, T55); replaces the list. */
  readonly routes?: RouteStatsData;
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

/** An ash SIGMET placed against the route (T29): the route points within 300 NM of the cloud. */
export interface RoutedAsh extends AshSigmet {
  /** Route distance of each such point and its distance to the cloud (0 inside), NM. */
  readonly near: readonly (readonly [alongNm: number, offNm: number])[];
}

/** An aurora cell placed against the route (T29). */
export interface RoutedAurora {
  readonly lat: number;
  readonly lon: number;
  readonly prob: number;
  readonly alongNm: number;
}

/** An NHL game as seen in this flight's updates (T29). */
export interface SeenNhlGame {
  readonly game: NhlGame;
  /** Last update time it was not final; null = never seen so. */
  readonly openT: number | null;
  /** First update time it was final; null = not final yet. */
  readonly finalT: number | null;
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
  /** T31; absent in states saved before T31. */
  readonly vhf?: readonly VhfStation[];
  /** T50; absent in states saved before T50. */
  readonly divertApts?: readonly DivertAirport[];
  /** T51; absent in states saved before T51. */
  readonly places?: Readonly<Record<string, AirportPlace | null>>;
  /** T28; absent in states saved before T28. */
  readonly launches?: readonly RoutedLaunch[];
  /** T27; absent in states saved before T27. */
  readonly natTracks?: readonly NatTrack[];
  /** T29; absent in states saved before T29. */
  readonly spaceWx?: SpaceWeather | null;
  readonly aurora?: { readonly forecastTime: number; readonly cells: readonly RoutedAurora[] };
  readonly ash?: readonly RoutedAsh[];
  readonly quakes?: readonly Earthquake[];
  readonly holidays?: Holidays | null;
  readonly f1?: F1Race | null;
  readonly nhl?: Readonly<Record<string, SeenNhlGame>>;
  /** T30; absent in states saved before T30. */
  readonly connex?: ConnexData | null;
  /** T55; absent in states saved before T55. */
  readonly routes?: RouteStatsData | null;
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
/** Ash clouds farther than this from the route are ignored (docs/07 T29). */
export const ASH_CORRIDOR_NM = 300;
/** Aurora cells farther than this from the route are ignored (one 1° cell ≈ 60 NM). */
export const AURORA_CORRIDOR_NM = 60;

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
  const { wx, atc, events, stands, firs, centers, airports, freqs, launches, natTracks } = x;
  checkSpecial(x, bad);
  checkConnex(x['connex'], bad);
  checkRoutes(x['routes'], bad);
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
          !strOrNull(s['atisCode']) ||
          !(s['atisText'] === undefined || strOrNull(s['atisText']))
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
  if (x['vhf'] !== undefined) {
    if (!Array.isArray(x['vhf'])) bad('vhf');
    for (const v of x['vhf'] as unknown[]) {
      if (
        !isObj(v) ||
        typeof v['icao'] !== 'string' ||
        !ICAO.test(v['icao']) ||
        !isNum(v['lat']) ||
        !isNum(v['lon']) ||
        Math.abs(v['lat'] as number) > 90 ||
        Math.abs(v['lon'] as number) > 180
      ) {
        bad('vhf item');
      }
    }
  }
  if (x['places'] !== undefined) {
    if (!isObj(x['places'])) bad('places');
    for (const [k, v] of Object.entries(x['places'] as Record<string, unknown>)) {
      if (!ICAO.test(k)) bad('places key');
      if (
        v !== null &&
        (!isObj(v) ||
          !isNum(v['lat']) ||
          !isNum(v['lon']) ||
          Math.abs(v['lat'] as number) > 90 ||
          Math.abs(v['lon'] as number) > 180)
      ) {
        bad('places item');
      }
    }
  }
  if (x['divertApts'] !== undefined) {
    if (!Array.isArray(x['divertApts'])) bad('divertApts');
    for (const v of x['divertApts'] as unknown[]) {
      if (
        !isObj(v) ||
        typeof v['icao'] !== 'string' ||
        !ICAO.test(v['icao']) ||
        !isNum(v['lat']) ||
        !isNum(v['lon']) ||
        Math.abs(v['lat'] as number) > 90 ||
        Math.abs(v['lon'] as number) > 180 ||
        !isNum(v['rwyM']) ||
        (v['rwyM'] as number) <= 0 ||
        !(v['widthM'] === null || (isNum(v['widthM']) && (v['widthM'] as number) > 0)) ||
        typeof v['large'] !== 'boolean'
      ) {
        bad('divertApts item');
      }
    }
  }
  if (launches !== undefined) {
    if (!Array.isArray(launches)) bad('launches');
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
  if (natTracks !== undefined) {
    if (!Array.isArray(natTracks)) bad('natTracks');
    for (const k of natTracks as unknown[]) {
      if (
        !isObj(k) ||
        typeof k['ident'] !== 'string' ||
        !/^[A-Z]{1,2}$/.test(k['ident']) ||
        !Array.isArray(k['route']) ||
        !(k['route'] as unknown[]).every((p) => typeof p === 'string' && NAT_POINT.test(p)) ||
        !isNum(k['validFrom']) ||
        !isNum(k['validTo']) ||
        !Array.isArray(k['levelsFt']) ||
        !(k['levelsFt'] as unknown[]).every(isNum)
      )
        bad('natTracks item');
    }
  }
  return x as unknown as ExtDataUpdate;
}

const isLatLon = (p: unknown): boolean =>
  isObj(p) &&
  isNum(p['lat']) &&
  isNum(p['lon']) &&
  Math.abs(p['lat']) <= 90 &&
  Math.abs(p['lon']) <= 180;
const isStr = (v: unknown): v is string => typeof v === 'string';
const numOrNull = (v: unknown) => v === null || isNum(v);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const level = (v: unknown) => isNum(v) && Number.isInteger(v) && v >= 0 && v <= 5;

const CONNEX_NUMBER = /^[A-Z0-9]{3,8}$/;
const CONNEX_GATE = /^[A-Z0-9]{1,6}$/;

/** The T30 field of an update. */
function checkConnex(c: unknown, bad: (why: string) => never): void {
  if (c === undefined) return;
  if (!isObj(c) || !ICAO.test(String(c['icao'])) || !Array.isArray(c['list'])) bad('connex');
  for (const f of (c as { list: unknown[] }).list) {
    if (
      !isObj(f) ||
      !CONNEX_NUMBER.test(String(f['number'])) ||
      !ICAO.test(String(f['dest'])) ||
      !numOrNull(f['std']) ||
      !(f['terminal'] === null || CONNEX_GATE.test(String(f['terminal']))) ||
      !(f['gate'] === null || CONNEX_GATE.test(String(f['gate']))) ||
      typeof f['codeshare'] !== 'boolean' ||
      !(f['model'] === undefined || f['model'] === null || connexModel(f['model']))
    )
      bad('connex item');
  }
}

/** `aircraft.model` of a departure (T55): free text, printable, short. */
const connexModel = (v: unknown) => isStr(v) && v.length <= 60 && /^[ -~]*$/.test(v);

/** The T55 field of an update. */
function checkRoutes(r: unknown, bad: (why: string) => never): void {
  if (r === undefined) return;
  if (!isObj(r) || !ICAO.test(String(r['icao'])) || !Array.isArray(r['list'])) bad('routes');
  for (const x of (r as { list: unknown[] }).list) {
    if (
      !isObj(x) ||
      !ICAO.test(String(x['dest'])) ||
      !(x['daily'] === null || (isNum(x['daily']) && x['daily'] >= 0)) ||
      !Array.isArray(x['operators']) ||
      !x['operators'].every((o) => isStr(o) && /^[A-Z]{3}$/.test(o))
    )
      bad('routes item');
  }
}

/** T29 fields of an update. */
function checkSpecial(x: Record<string, unknown>, bad: (why: string) => never): void {
  const { spaceWx, aurora, ash, quakes, holidays, f1, nhl } = x;
  if (spaceWx !== undefined) {
    if (!isObj(spaceWx) || !isNum(spaceWx['issued'])) bad('spaceWx');
    const s = spaceWx as Record<string, unknown>;
    const c = s['current'];
    if (!isObj(c) || !level(c['r']) || !level(c['s']) || !level(c['g'])) bad('spaceWx.current');
    const f = s['gForecast'];
    if (
      !Array.isArray(f) ||
      !f.every((d: unknown) => isObj(d) && DATE.test(String(d['date'])) && level(d['g']))
    )
      bad('spaceWx.gForecast');
  }
  if (aurora !== undefined) {
    if (!isObj(aurora) || !isNum(aurora['forecastTime']) || !Array.isArray(aurora['cells']))
      bad('aurora');
    for (const c of (aurora as { cells: unknown[] }).cells) {
      if (!isLatLon(c) || !isNum((c as Record<string, unknown>)['prob'])) bad('aurora cell');
    }
  }
  if (ash !== undefined) {
    if (!Array.isArray(ash)) bad('ash');
    for (const a of ash as unknown[]) {
      if (
        !isObj(a) ||
        !isStr(a['id']) ||
        !isStr(a['fir']) ||
        !isStr(a['volcano']) ||
        !numOrNull(a['baseFt']) ||
        !numOrNull(a['topFt']) ||
        !isNum(a['validFrom']) ||
        !isNum(a['validTo']) ||
        !Array.isArray(a['areas']) ||
        !(a['areas'] as unknown[]).every(
          (r) => Array.isArray(r) && r.length >= 3 && r.every(isLatLon),
        )
      )
        bad('ash item');
    }
  }
  if (quakes !== undefined) {
    if (!Array.isArray(quakes)) bad('quakes');
    for (const q of quakes as unknown[]) {
      const r = q as Record<string, unknown>;
      if (
        !isLatLon(q) ||
        !isStr(r['id']) ||
        !isNum(r['mag']) ||
        !isStr(r['place']) ||
        !isNum(r['time']) ||
        !isNum(r['depthKm'])
      )
        bad('quakes item');
    }
  }
  if (holidays !== undefined) {
    if (!isObj(holidays) || !/^[A-Z]{2}$/.test(String(holidays['country']))) bad('holidays');
    const list = (holidays as Record<string, unknown>)['list'];
    if (
      !Array.isArray(list) ||
      !list.every(
        (h: unknown) =>
          isObj(h) && DATE.test(String(h['date'])) && isStr(h['name']) && isStr(h['localName']),
      )
    )
      bad('holidays.list');
  }
  if (f1 !== undefined && f1 !== null) {
    if (
      !isObj(f1) ||
      !isStr(f1['season']) ||
      !isStr(f1['round']) ||
      !isStr(f1['name']) ||
      !isNum(f1['start']) ||
      !isNum(f1['finish']) ||
      !Array.isArray(f1['podium']) ||
      !(f1['podium'] as unknown[]).every(
        (p) => isObj(p) && isNum(p['pos']) && isStr(p['code']) && isStr(p['team']),
      )
    )
      bad('f1');
  }
  if (nhl !== undefined) {
    if (!Array.isArray(nhl)) bad('nhl');
    for (const g of nhl as unknown[]) {
      if (
        !isObj(g) ||
        !isNum(g['id']) ||
        !isNum(g['start']) ||
        !NHL_STATES.includes(g['state'] as NhlState) ||
        !isStr(g['away']) ||
        !isStr(g['home']) ||
        !numOrNull(g['awayScore']) ||
        !numOrNull(g['homeScore']) ||
        !(g['lastPeriod'] === null || isStr(g['lastPeriod']))
      )
        bad('nhl item');
    }
  }
}

/** T29 fields of an update. */
function applySpecial(state: ExtState, u: ExtDataUpdate, route: RoutePolyline): ExtState {
  let next = state;
  if (u.spaceWx !== undefined) next = { ...next, spaceWx: u.spaceWx };
  if (u.aurora !== undefined) {
    const cells = u.aurora.cells
      .map((c) => ({ c, at: route.locate(c) }))
      .filter((x) => x.at.offNm <= AURORA_CORRIDOR_NM)
      .map((x) => ({ lat: x.c.lat, lon: x.c.lon, prob: x.c.prob, alongNm: x.at.alongNm }))
      .sort((a, b) => a.alongNm - b.alongNm || a.lat - b.lat || a.lon - b.lon);
    next = { ...next, aurora: { forecastTime: u.aurora.forecastTime, cells } };
  }
  if (u.ash !== undefined) {
    const ash: RoutedAsh[] = [];
    for (const a of u.ash) {
      const near = route.near(a.areas, ASH_CORRIDOR_NM);
      if (near.length > 0) ash.push({ ...a, near });
    }
    next = { ...next, ash };
  }
  if (u.quakes !== undefined) next = { ...next, quakes: [...u.quakes] };
  if (u.holidays !== undefined) next = { ...next, holidays: u.holidays };
  if (u.f1 !== undefined) next = { ...next, f1: u.f1 };
  if (u.nhl !== undefined) {
    const seen: Record<string, SeenNhlGame> = { ...(next.nhl ?? {}) };
    for (const g of u.nhl) {
      const prev = seen[String(g.id)];
      seen[String(g.id)] = isNhlFinal(g.state)
        ? { game: g, openT: prev?.openT ?? null, finalT: prev?.finalT ?? u.t }
        : { game: g, openT: u.t, finalT: null };
    }
    next = { ...next, nhl: seen };
  }
  return next;
}

/** A point of a NAT track: a named fix or `63/20`, `6330/20`. */
export const NAT_POINT = /^(?:[A-Z]{2,5}|\d{2}(?:\d{2})?\/\d{2,3})$/;

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
  if (u.natTracks !== undefined) next = { ...next, natTracks: [...u.natTracks] };
  if (u.connex !== undefined && u.connex.icao === ofp.destination.icao) {
    next = { ...next, connex: { icao: u.connex.icao, list: [...u.connex.list] } };
  }
  if (u.routes !== undefined && u.routes.icao === ofp.destination.icao) {
    next = { ...next, routes: { icao: u.routes.icao, list: [...u.routes.list] } };
  }
  if (u.vhf !== undefined) next = { ...next, vhf: u.vhf.map((v) => ({ ...v })) };
  if (u.places !== undefined) next = { ...next, places: { ...next.places, ...u.places } };
  if (u.divertApts !== undefined) {
    next = { ...next, divertApts: u.divertApts.map((v) => ({ ...v })) };
  }
  next = applySpecial(next, u, route);
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

  /** The sampled route points (≤ 10 NM apart) with their route distance from the origin. */
  get points(): readonly (LatLon & { readonly along: number })[] {
    return this.pts;
  }

  /**
   * Route points within `maxNm` of any of the polygons (0 inside one): `[alongNm, offNm]`,
   * rounded, in route order (T29 ash clouds).
   */
  near(areas: readonly (readonly LatLon[])[], maxNm: number): [number, number][] {
    const edges: LatLon[] = [];
    for (const ring of areas) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i] as LatLon;
        const b = ring[(i + 1) % ring.length] as LatLon;
        const n = Math.max(1, Math.ceil(distanceNm(a, b) / 10));
        for (let k = 0; k < n; k++) edges.push(interpolate(a, b, k / n));
      }
    }
    const out: [number, number][] = [];
    for (const q of this.pts) {
      let d = areas.some((r) => insidePolygon(q, r)) ? 0 : Number.POSITIVE_INFINITY;
      for (const e of edges) {
        if (d === 0) break;
        d = Math.min(d, distanceNm(q, e));
      }
      if (d <= maxNm) out.push([Math.round(q.along), Math.round(d)]);
    }
    return out;
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
