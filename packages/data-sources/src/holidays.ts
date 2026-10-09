import type { PublicHoliday } from '@acars/core';
import {
  DataSourceError,
  expectOk,
  type FetchContext,
  isObj,
  parseJson,
  request,
  telexText,
} from './common.js';
import { splitCsv } from './ourairports.js';

/**
 * Public holidays of the destination country (T29, docs/06; checked 2026-10-09).
 *
 * Country of the airport: OurAirports `airports.csv`
 * (https://davidmegginson.github.io/ourairports-data/airports.csv, ~12.7 MB, refreshed nightly;
 * "All data is released to the Public Domain") — `icao_code`, else a 4-letter `ident` or
 * `gps_code`, → `iso_country` (ISO 3166-1 alpha-2). The service keeps the whole map (cached 30
 * days), so the file is fetched rarely.
 *
 * Holidays: Nager.Date `GET https://date.nager.at/api/v3/PublicHolidays/{year}/{CC}` → `[{date,
 * localName, name, countryCode, global, counties, types}]`; 204 (no content) for a country it
 * does not cover, 404 for an unknown code. No key; "free for private and non-commercial use",
 * commercial use — sponsorship `[ПРИ РЕЛИЗЕ]`. Only nationwide (`global: true`) holidays are kept.
 */

export const OURAIRPORTS_AIRPORTS_URL =
  'https://davidmegginson.github.io/ourairports-data/airports.csv';
export const NAGER_URL = 'https://date.nager.at/api/v3/PublicHolidays';

export async function fetchAirportCountries(ctx: FetchContext): Promise<Record<string, string>> {
  const res = await request(ctx, OURAIRPORTS_AIRPORTS_URL);
  expectOk(res, 'OurAirports');
  return parseAirportCountries(res.body);
}

/** ICAO code → ISO 3166-1 alpha-2 country. */
export function parseAirportCountries(csv: string): Record<string, string> {
  const lines = csv.split(/\r?\n/);
  const head = splitCsv(lines[0] ?? '');
  const col = (name: string) => head.indexOf(name);
  const [ident, icao, gps, country] = [
    col('ident'),
    col('icao_code'),
    col('gps_code'),
    col('iso_country'),
  ];
  if (ident < 0 || icao < 0 || gps < 0 || country < 0) {
    throw new DataSourceError('OurAirports: unexpected CSV header');
  }
  const out: Record<string, string> = {};
  const fourLetters = /^[A-Z]{4}$/;
  for (const line of lines.slice(1)) {
    if (line === '') continue;
    const c = splitCsv(line);
    const cc = c[country] ?? '';
    if (!/^[A-Z]{2}$/.test(cc)) continue;
    // `icao_code` wins over an ident or GPS code another row might share.
    const code = [c[icao], c[ident], c[gps]].find((x) => x !== undefined && fourLetters.test(x));
    if (code === undefined) continue;
    if (code === c[icao] || out[code] === undefined) out[code] = cc;
  }
  return out;
}

export async function fetchHolidays(
  ctx: FetchContext,
  country: string,
  year: number,
): Promise<PublicHoliday[]> {
  const res = await request(ctx, `${NAGER_URL}/${year}/${country}`);
  if (res.status === 204 || res.status === 404) return [];
  expectOk(res, 'Nager.Date');
  return parseHolidays(parseJson(res.body, 'Nager.Date'));
}

export function parseHolidays(json: unknown): PublicHoliday[] {
  if (!Array.isArray(json)) throw new DataSourceError('Nager.Date: not a list');
  const out: PublicHoliday[] = [];
  for (const h of json) {
    if (!isObj(h) || h['global'] !== true) continue;
    const date = String(h['date']);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const name = telexText(String(h['name'] ?? ''), 50);
    if (name === '') continue;
    const localName = telexText(String(h['localName'] ?? ''), 50);
    out.push({ date, name, localName: localName === '' ? name : localName });
  }
  return out;
}
