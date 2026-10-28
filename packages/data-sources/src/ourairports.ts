// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import {
  type AirportFrequency,
  type AirportPlace,
  bearingDeg,
  type DivertAirport,
  distanceNm,
  type Ofp,
  RoutePolyline,
  type RunwayNeed,
  VHF_CORRIDOR_NM,
  type VhfStation,
} from '@acars/core';
import { DataSourceError, expectOk, type FetchContext, request } from './common.js';
import { OURAIRPORTS_AIRPORTS_URL } from './holidays.js';

/**
 * Airport frequencies for the departure clearance (T24, docs/06 "OurAirports"): OurAirports
 * `airport-frequencies.csv`, https://davidmegginson.github.io/ourairports-data/airport-frequencies.csv
 * (~1.3 MB, refreshed nightly). Licence (https://ourairports.com/data/, checked 2026-10-09):
 * "All data is released to the Public Domain, and comes with no guarantee of accuracy or
 * fitness for use." — crowd-sourced, used only when live VATSIM data has no frequency.
 * Columns: `id`, `airport_ref`, `airport_ident`, `type` (`DEL`, `CLD`, `GND`, `TWR`, `APP`,
 * `DEP`, `ATIS` …), `description`, `frequency_mhz`.
 */

export const OURAIRPORTS_FREQS_URL =
  'https://davidmegginson.github.io/ourairports-data/airport-frequencies.csv';

export async function fetchAirportFrequencies(
  ctx: FetchContext,
  icao: string,
): Promise<AirportFrequency[]> {
  const res = await request(ctx, OURAIRPORTS_FREQS_URL);
  expectOk(res, 'OurAirports');
  return parseAirportFrequencies(res.body, icao);
}

/** Rows of one airport, in file order; air-band frequencies only. */
export function parseAirportFrequencies(csv: string, icao: string): AirportFrequency[] {
  const lines = csv.split(/\r?\n/);
  const head = splitCsv(lines[0] ?? '');
  const col = (name: string) => head.indexOf(name);
  const [ident, type, mhz] = [col('airport_ident'), col('type'), col('frequency_mhz')];
  if (ident < 0 || type < 0 || mhz < 0) {
    throw new DataSourceError('OurAirports: unexpected CSV header');
  }
  const out: AirportFrequency[] = [];
  for (const line of lines.slice(1)) {
    // Cheap pre-filter: the ident is quoted in every row.
    if (!line.includes(`"${icao}"`)) continue;
    const c = splitCsv(line);
    if (c[ident] !== icao) continue;
    const v = Number(c[mhz]);
    if (!(v >= 118 && v < 137)) continue;
    out.push({ type: (c[type] ?? '').toUpperCase(), mhz: String(v) });
  }
  return out;
}

/**
 * Runway coordinates for the smoke effect (T34): OurAirports `runways.csv`,
 * https://davidmegginson.github.io/ourairports-data/runways.csv (same licence as above, columns
 * checked 2026-10-15): `airport_ident`, `le_ident`, `le_latitude_deg`, `le_longitude_deg`,
 * `he_ident`, `he_latitude_deg`, `he_longitude_deg`. Many small-field rows have no coordinates.
 */
export const OURAIRPORTS_RUNWAYS_URL =
  'https://davidmegginson.github.io/ourairports-data/runways.csv';

/**
 * Middle of a runway, degrees; the middle of the strip between its two thresholds. `headingDeg`:
 * true course from the named end's threshold to the other one (the direction of `24L` for `24L`).
 */
export interface RunwayPoint {
  readonly lat: number;
  readonly lon: number;
  readonly headingDeg: number;
}

export async function fetchRunwayPoint(
  ctx: FetchContext,
  icao: string,
  rwy: string,
): Promise<RunwayPoint | null> {
  const res = await request(ctx, OURAIRPORTS_RUNWAYS_URL);
  expectOk(res, 'OurAirports');
  return parseRunwayPoint(res.body, icao, rwy);
}

/**
 * The middle of runway `rwy` (`24L`, either end) of `icao`; null when the airport has no such
 * runway or no coordinates for both ends. Never guesses another runway.
 */
export function parseRunwayPoint(csv: string, icao: string, rwy: string): RunwayPoint | null {
  const lines = csv.split(/\r?\n/);
  const head = splitCsv(lines[0] ?? '');
  const col = (name: string) => head.indexOf(name);
  const idx = [
    'airport_ident',
    'le_ident',
    'le_latitude_deg',
    'le_longitude_deg',
    'he_ident',
    'he_latitude_deg',
    'he_longitude_deg',
  ].map(col);
  if (idx.some((i) => i < 0)) throw new DataSourceError('OurAirports: unexpected CSV header');
  const [ident, leId, leLat, leLon, heId, heLat, heLon] = idx as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const want = rwy.trim().toUpperCase();
  for (const line of lines.slice(1)) {
    if (!line.includes(`"${icao}"`)) continue;
    const c = splitCsv(line);
    if (c[ident] !== icao) continue;
    if (c[leId]?.toUpperCase() !== want && c[heId]?.toUpperCase() !== want) continue;
    const [a, b, d, e] = [leLat, leLon, heLat, heLon].map((i) => Number(c[i]));
    if ([c[leLat], c[leLon], c[heLat], c[heLon]].some((v) => v === undefined || v === '')) continue;
    if (![a, b, d, e].every(Number.isFinite)) continue;
    const le = { lat: a as number, lon: b as number };
    const he = { lat: d as number, lon: e as number };
    const fromLe = c[leId]?.toUpperCase() === want;
    return {
      lat: (le.lat + he.lat) / 2,
      lon: (le.lon + he.lon) / 2,
      headingDeg: fromLe ? bearingDeg(le, he) : bearingDeg(he, le),
    };
  }
  return null;
}

/**
 * The landing runway for the rescue services (T54): threshold of the landing end and its true
 * course toward the other end, the length between the two ends' coordinates. OurAirports gives the
 * runway ends (`le_*` / `he_*`), not displaced thresholds.
 */
export interface LandingRunway {
  readonly ident: string;
  readonly thrLat: number;
  readonly thrLon: number;
  readonly headingDeg: number;
  readonly lengthM: number;
}

export async function fetchLandingRunway(
  ctx: FetchContext,
  icao: string,
  rwy: string | null,
  windFromDeg: number | null = null,
): Promise<LandingRunway | null> {
  const res = await request(ctx, OURAIRPORTS_RUNWAYS_URL);
  expectOk(res, 'OurAirports');
  return parseLandingRunway(res.body, icao, rwy, windFromDeg);
}

/**
 * Runway `rwy` (`24L`, landing on that end) of `icao`; without `rwy`, or when it is not in the
 * file, the longest open runway with coordinates at both ends, landing into the wind of
 * `windFromDeg` (the end whose course is closer to it), on its `le` end without wind (user
 * decision of T54, 2026-10-17). Null when no runway has coordinates.
 */
export function parseLandingRunway(
  csv: string,
  icao: string,
  rwy: string | null,
  windFromDeg: number | null = null,
): LandingRunway | null {
  const lines = csv.split(/\r?\n/);
  const head = splitCsv(lines[0] ?? '');
  const col = (name: string) => head.indexOf(name);
  const idx = [
    'airport_ident',
    'closed',
    'le_ident',
    'le_latitude_deg',
    'le_longitude_deg',
    'he_ident',
    'he_latitude_deg',
    'he_longitude_deg',
  ].map(col);
  if (idx.some((i) => i < 0)) throw new DataSourceError('OurAirports: unexpected CSV header');
  const [ident, closed, leId, leLat, leLon, heId, heLat, heLon] = idx as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const want = rwy?.trim().toUpperCase() ?? null;
  let named: LandingRunway | null = null;
  let longest: LandingRunway | null = null;
  for (const line of lines.slice(1)) {
    if (!line.includes(`"${icao}"`)) continue;
    const c = splitCsv(line);
    if (c[ident] !== icao) continue;
    if ([c[leLat], c[leLon], c[heLat], c[heLon]].some((v) => v === undefined || v === '')) continue;
    const [a, b, d, e] = [leLat, leLon, heLat, heLon].map((i) => Number(c[i]));
    if (![a, b, d, e].every(Number.isFinite)) continue;
    const le = { lat: a as number, lon: b as number };
    const he = { lat: d as number, lon: e as number };
    const lengthM = Math.round(distanceNm(le, he) * 1852);
    if (lengthM <= 0) continue;
    const end = (id: string, thr: typeof le, far: typeof le): LandingRunway => ({
      ident: id,
      thrLat: thr.lat,
      thrLon: thr.lon,
      headingDeg: bearingDeg(thr, far),
      lengthM,
    });
    const [leName, heName] = [c[leId]?.toUpperCase() ?? '', c[heId]?.toUpperCase() ?? ''];
    if (want !== null && named === null) {
      if (leName === want) named = end(leName, le, he);
      else if (heName === want) named = end(heName, he, le);
    }
    if (c[closed] !== '1' && (longest === null || lengthM > longest.lengthM)) {
      const fromLe = end(leName, le, he);
      const fromHe = end(heName, he, le);
      longest =
        windFromDeg !== null &&
        angleOff(fromHe.headingDeg, windFromDeg) < angleOff(fromLe.headingDeg, windFromDeg)
          ? fromHe
          : fromLe;
    }
  }
  return named ?? longest;
}

/** Angle between two courses, 0..180°. */
function angleOff(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/**
 * Idents of the large airports (`type = large_airport`) of OurAirports `airports.csv` — the
 * "large airport" of the T54 vehicle rules.
 */
export async function fetchLargeAirports(ctx: FetchContext): Promise<string[]> {
  const res = await request(ctx, OURAIRPORTS_AIRPORTS_URL);
  expectOk(res, 'OurAirports');
  return parseLargeAirports(res.body);
}

export function parseLargeAirports(csv: string): string[] {
  const lines = csv.split(/\r?\n/);
  const head = splitCsv(lines[0] ?? '');
  const [ident, type] = [head.indexOf('ident'), head.indexOf('type')];
  if (ident < 0 || type < 0) throw new DataSourceError('OurAirports: unexpected CSV header');
  const out: string[] = [];
  for (const line of lines.slice(1)) {
    if (!line.includes('"large_airport"')) continue;
    const c = splitCsv(line);
    if (c[type] === 'large_airport' && c[ident]) out.push(c[ident] as string);
  }
  return out;
}

/**
 * Conditional VHF stations for the data link (T31, docs/07 A1): the airports of OurAirports
 * `airports.csv` that are large or medium with scheduled service and a four-letter ident,
 * only those within {@link VHF_CORRIDOR_NM} of the planned route. Real SITA/ARINC stations
 * have no open list; the pilot sees these as conditional ones.
 */
export async function fetchVhfStations(ctx: FetchContext, ofp: Ofp): Promise<VhfStation[]> {
  const res = await request(ctx, OURAIRPORTS_AIRPORTS_URL);
  expectOk(res, 'OurAirports');
  const route = new RoutePolyline(ofp);
  return parseVhfStations(res.body).filter((s) => route.locate(s).offNm <= VHF_CORRIDOR_NM);
}

/** Large and medium airports with scheduled service (file order, 4-letter ident). */
export function parseVhfStations(csv: string): VhfStation[] {
  const lines = csv.split(/\r?\n/);
  const head = splitCsv(lines[0] ?? '');
  const col = (name: string) => head.indexOf(name);
  const idx = ['ident', 'type', 'latitude_deg', 'longitude_deg', 'scheduled_service'].map(col);
  if (idx.some((i) => i < 0)) throw new DataSourceError('OurAirports: unexpected CSV header');
  const [ident, type, lat, lon, sched] = idx as [number, number, number, number, number];
  const out: VhfStation[] = [];
  for (const line of lines.slice(1)) {
    if (line === '') continue;
    const c = splitCsv(line);
    if (c[type] !== 'large_airport' && c[type] !== 'medium_airport') continue;
    if (c[sched] !== 'yes' || !/^[A-Z]{4}$/.test(c[ident] ?? '')) continue;
    const [la, lo] = [Number(c[lat]), Number(c[lon])];
    if (!(Math.abs(la) <= 90 && Math.abs(lo) <= 180) || c[lat] === '' || c[lon] === '') continue;
    out.push({ icao: c[ident] as string, lat: la, lon: lo });
  }
  return out;
}

/** One CSV line: commas, double-quoted fields with `""` escapes. */
export function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Airports to divert to besides the OFP's (T50, docs/07 T50 part B): the large and medium
 * airports with scheduled service of `airports.csv` within {@link DIVERT_CORRIDOR_NM} of the
 * route, each with its longest open hard-surface runway from `runways.csv` (columns checked
 * 2026-10-15: `airport_ident`, `length_ft`, `width_ft`, `surface`, `closed`). Only those whose
 * runway is as long and wide as `need`. Fetched when the type has a runway need (the table in
 * `@acars/core` `divert.ts`); public domain, as above.
 */
export const DIVERT_CORRIDOR_NM = 300;
const FT_M = 0.3048;

export async function fetchDivertAirports(
  ctx: FetchContext,
  ofp: Ofp,
  need: RunwayNeed,
): Promise<DivertAirport[]> {
  const air = await request(ctx, OURAIRPORTS_AIRPORTS_URL);
  expectOk(air, 'OurAirports');
  const route = new RoutePolyline(ofp);
  const near = parseDivertCandidates(air.body).filter(
    (a) => route.locate(a).offNm <= DIVERT_CORRIDOR_NM,
  );
  const rwy = await request(ctx, OURAIRPORTS_RUNWAYS_URL);
  expectOk(rwy, 'OurAirports');
  return joinRunways(near, parseBestRunways(rwy.body, new Set(near.map((a) => a.icao)))).filter(
    (a) =>
      a.rwyM >= need.lengthM &&
      (a.widthM === null || a.widthM >= need.widthM) &&
      (need.large !== true || a.large),
  );
}

export interface DivertCandidate {
  readonly icao: string;
  readonly lat: number;
  readonly lon: number;
  readonly large: boolean;
}

/** Large and medium airports with scheduled service and a four-letter ident (file order). */
export function parseDivertCandidates(csv: string): DivertCandidate[] {
  const lines = csv.split(/\r?\n/);
  const head = splitCsv(lines[0] ?? '');
  const col = (name: string) => head.indexOf(name);
  const idx = ['ident', 'type', 'latitude_deg', 'longitude_deg', 'scheduled_service'].map(col);
  if (idx.some((i) => i < 0)) throw new DataSourceError('OurAirports: unexpected CSV header');
  const [ident, type, lat, lon, sched] = idx as [number, number, number, number, number];
  const out: DivertCandidate[] = [];
  for (const line of lines.slice(1)) {
    if (line === '') continue;
    const c = splitCsv(line);
    if (c[type] !== 'large_airport' && c[type] !== 'medium_airport') continue;
    if (c[sched] !== 'yes' || !/^[A-Z]{4}$/.test(c[ident] ?? '')) continue;
    const [la, lo] = [Number(c[lat]), Number(c[lon])];
    if (!(Math.abs(la) <= 90 && Math.abs(lo) <= 180) || c[lat] === '' || c[lon] === '') continue;
    out.push({ icao: c[ident] as string, lat: la, lon: lo, large: c[type] === 'large_airport' });
  }
  return out;
}

/**
 * A runway surface that takes an airliner: asphalt, concrete, pavement, bitumen. The file's
 * `surface` is free text (`ASP`, `CON`, `ASPH-G`, `ASPH/ CONC`, `TURF` …); a mixed or unpaved
 * value (turf, grass, gravel, dirt, sand, water, `ASPH-TURF`) is not hard.
 */
export function isHardSurface(surface: string): boolean {
  const s = surface.trim().toUpperCase();
  if (/(TURF|GRS|GRASS|GRE|GVL|GRVL|GRAVEL|DIRT|EARTH|SAND|WATER|WAT|SOD|MATS|WOOD)/.test(s)) {
    return false;
  }
  return /^(ASP|CON|PEM|BIT|TAR|PAVED)/.test(s);
}

/** The longest open hard-surface runway of each airport in `icaos`: length and width, m. */
export function parseBestRunways(
  csv: string,
  icaos: ReadonlySet<string>,
): Map<string, { rwyM: number; widthM: number | null }> {
  const lines = csv.split(/\r?\n/);
  const head = splitCsv(lines[0] ?? '');
  const col = (name: string) => head.indexOf(name);
  const idx = ['airport_ident', 'length_ft', 'width_ft', 'surface', 'closed'].map(col);
  if (idx.some((i) => i < 0)) throw new DataSourceError('OurAirports: unexpected CSV header');
  const [ident, len, wid, surf, closed] = idx as [number, number, number, number, number];
  const best = new Map<string, { rwyM: number; widthM: number | null }>();
  for (const line of lines.slice(1)) {
    if (line === '') continue;
    const c = splitCsv(line);
    const icao = c[ident] as string;
    if (!icaos.has(icao) || c[closed] === '1' || !isHardSurface(c[surf] ?? '')) continue;
    const lengthFt = Number(c[len]);
    if (!(lengthFt > 0)) continue;
    const rwyM = Math.round(lengthFt * FT_M);
    const widthFt = Number(c[wid]);
    const widthM = widthFt > 0 ? Math.round(widthFt * FT_M) : null;
    const cur = best.get(icao);
    if (cur === undefined || rwyM > cur.rwyM) best.set(icao, { rwyM, widthM });
  }
  return best;
}

function joinRunways(
  list: readonly DivertCandidate[],
  rwy: ReadonlyMap<string, { rwyM: number; widthM: number | null }>,
): DivertAirport[] {
  const out: DivertAirport[] = [];
  for (const a of list) {
    const r = rwy.get(a.icao);
    if (r !== undefined) out.push({ ...a, ...r });
  }
  return out;
}

/**
 * Where an airport is (T51): every airport of `airports.csv` that has a runway (large, medium,
 * small) by its four-letter code (`icao_code`, else `ident`, else `gps_code`) — the airports a pilot
 * may name in `DIVERT <ICAO>`. Fetched on request, the whole file once per app session.
 */
export async function fetchAirportPlaces(ctx: FetchContext): Promise<Map<string, AirportPlace>> {
  const res = await request(ctx, OURAIRPORTS_AIRPORTS_URL);
  expectOk(res, 'OurAirports');
  return parseAirportPlaces(res.body);
}

export function parseAirportPlaces(csv: string): Map<string, AirportPlace> {
  const lines = csv.split(/\r?\n/);
  const head = splitCsv(lines[0] ?? '');
  const col = (name: string) => head.indexOf(name);
  const idx = ['ident', 'type', 'latitude_deg', 'longitude_deg', 'icao_code', 'gps_code'].map(col);
  if (idx.some((i) => i < 0)) throw new DataSourceError('OurAirports: unexpected CSV header');
  const [ident, type, lat, lon, icaoCode, gps] = idx as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const out = new Map<string, AirportPlace>();
  for (const line of lines.slice(1)) {
    if (line === '') continue;
    const c = splitCsv(line);
    if (
      c[type] !== 'large_airport' &&
      c[type] !== 'medium_airport' &&
      c[type] !== 'small_airport'
    ) {
      continue;
    }
    const code = [c[icaoCode], c[ident], c[gps]].find((x) => /^[A-Z]{4}$/.test(x ?? ''));
    if (code === undefined || out.has(code) || c[lat] === '' || c[lon] === '') continue;
    const [la, lo] = [Number(c[lat]), Number(c[lon])];
    if (!(Math.abs(la) <= 90 && Math.abs(lo) <= 180)) continue;
    out.set(code, { lat: la, lon: lo });
  }
  return out;
}
