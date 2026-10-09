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

/** One CSV line: commas, double-quoted fields with `""` escapes. */
function splitCsv(line: string): string[] {
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
