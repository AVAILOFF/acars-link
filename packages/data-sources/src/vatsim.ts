import type { AtcFacility, AtcStation } from '@acars/core';
import {
  DataSourceError,
  expectOk,
  type FetchContext,
  isObj,
  parseJson,
  request,
} from './common.js';
import type { VatsimCenter } from './vatspy.js';

/**
 * Online VATSIM ATC from the data feed v3 (docs/06; URL from `status.vatsim.net/status.json`,
 * checked 2026-10-08): `GET https://data.vatsim.net/v3/vatsim-data.json`, ~1.5 MB, refreshed
 * every 15 s. `controllers[]` and `atis[]` have `callsign`, `frequency`, `facility` (0 OBS,
 * 1 FSS, 2 DEL, 3 GND, 4 TWR, 5 APP, 6 CTR) and `atis_code` (ATIS). Only callsign,
 * frequency, facility and ATIS letter are kept — no names or CIDs.
 *
 * Which airport a station serves is not in the feed: the callsign prefix (before the first
 * `_`) is matched against the ICAO code, the IATA code and, for US airports (`K…`), the
 * ICAO code without the `K` (`MCI_TWR`) `[ПРОВЕРИТЬ]` other local conventions.
 */

export const VATSIM_DATA_URL = 'https://data.vatsim.net/v3/vatsim-data.json';

const FACILITY: Readonly<Record<number, AtcFacility>> = { 2: 'DEL', 3: 'GND', 4: 'TWR', 5: 'APP' };

/** A station of the feed with its callsign prefix. */
export interface VatsimStation extends AtcStation {
  readonly prefix: string;
}

/** Longest ATIS text kept for a telex, characters. */
const ATIS_TEXT_MAX = 400;

/**
 * `text_atis` (an array of lines in the v3 feed) as telex text: upper case, only `A–Z0–9` and
 * a few punctuation marks, lines joined with a space, cut at a word boundary. Null without
 * text. The text is the controller's broadcast, not personal data.
 */
export function atisTelexText(lines: unknown): string | null {
  if (!Array.isArray(lines)) return null;
  const text = lines
    .filter((l): l is string => typeof l === 'string')
    .join(' ')
    .toUpperCase()
    .replace(/[^A-Z0-9 ./,-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return null;
  if (text.length <= ATIS_TEXT_MAX) return text;
  const cut = text.slice(0, ATIS_TEXT_MAX);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 1)).trim();
}

export async function fetchVatsimStations(ctx: FetchContext): Promise<VatsimStation[]> {
  return (await fetchVatsim(ctx)).stations;
}

/** Airport stations and centres (T23) from one fetch of the feed. */
export async function fetchVatsim(
  ctx: FetchContext,
): Promise<{ stations: VatsimStation[]; centers: VatsimCenter[] }> {
  const res = await request(ctx, VATSIM_DATA_URL);
  expectOk(res, 'VATSIM');
  const json = parseJson(res.body, 'VATSIM');
  return { stations: parseVatsimFeed(json), centers: parseVatsimCenters(json) };
}

/** Centres (facility 6 CTR) and FSS (1) on an air-band frequency, for the XATC station (T23). */
export function parseVatsimCenters(json: unknown): VatsimCenter[] {
  if (!isObj(json) || !Array.isArray(json['controllers'])) {
    throw new DataSourceError('VATSIM: no controllers[] in the feed');
  }
  const out: VatsimCenter[] = [];
  for (const x of json['controllers'] as unknown[]) {
    if (!isObj(x) || typeof x['callsign'] !== 'string' || typeof x['frequency'] !== 'string')
      continue;
    if (x['facility'] !== 6 && x['facility'] !== 1) continue;
    const callsign = x['callsign'].toUpperCase();
    const mhz = Number(x['frequency']);
    if (!/^[A-Z0-9_]{3,20}$/.test(callsign) || !(mhz >= 118 && mhz < 137)) continue;
    out.push({ callsign, frequency: x['frequency'] });
  }
  return out;
}

export function parseVatsimFeed(json: unknown): VatsimStation[] {
  if (!isObj(json) || !Array.isArray(json['controllers'])) {
    throw new DataSourceError('VATSIM: no controllers[] in the feed');
  }
  const out: VatsimStation[] = [];
  const add = (x: unknown, atis: boolean) => {
    if (!isObj(x) || typeof x['callsign'] !== 'string' || typeof x['frequency'] !== 'string')
      return;
    const facility: AtcFacility | undefined = atis ? 'ATIS' : FACILITY[x['facility'] as number];
    if (facility === undefined) return; // OBS, FSS, CTR
    const callsign = x['callsign'].toUpperCase();
    // Air band only: 199.998 is the "no frequency" of observers and supervisors.
    const mhz = Number(x['frequency']);
    if (!/^[A-Z0-9_]{3,20}$/.test(callsign) || !(mhz >= 118 && mhz < 137)) return;
    const code = typeof x['atis_code'] === 'string' ? x['atis_code'].toUpperCase() : '';
    out.push({
      callsign,
      facility,
      frequency: x['frequency'],
      atisCode: atis && /^[A-Z]$/.test(code) ? code : null,
      atisText: atis ? atisTelexText(x['text_atis']) : null,
      prefix: callsign.split('_')[0] as string,
    });
  };
  for (const c of json['controllers']) add(c, false);
  if (Array.isArray(json['atis'])) for (const a of json['atis']) add(a, true);
  return out;
}

/** Stations serving each airport (see the prefix rule above). */
export function stationsFor(
  stations: readonly VatsimStation[],
  airports: readonly { readonly icao: string; readonly iata: string | null }[],
): Record<string, AtcStation[]> {
  const out: Record<string, AtcStation[]> = {};
  for (const a of airports) {
    const prefixes = new Set([a.icao]);
    if (a.iata !== null && /^[A-Z]{3}$/.test(a.iata)) prefixes.add(a.iata);
    if (/^K[A-Z]{3}$/.test(a.icao)) prefixes.add(a.icao.slice(1));
    out[a.icao] = stations
      .filter((s) => prefixes.has(s.prefix))
      .map(({ callsign, facility, frequency, atisCode, atisText }) => ({
        callsign,
        facility,
        frequency,
        atisCode,
        atisText: atisText ?? null,
      }));
  }
  return out;
}
