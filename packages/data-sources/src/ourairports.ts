import type { AirportFrequency } from '@acars/core';
import { DataSourceError, expectOk, type FetchContext, request } from './common.js';

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

/** Middle of a runway, degrees; the middle of the strip between its two thresholds. */
export interface RunwayPoint {
  readonly lat: number;
  readonly lon: number;
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
    return { lat: ((a as number) + (d as number)) / 2, lon: ((b as number) + (e as number)) / 2 };
  }
  return null;
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
