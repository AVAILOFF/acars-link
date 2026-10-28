// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { WxReport } from '@acars/core';
import {
  DataSourceError,
  expectOk,
  type FetchContext,
  ICAO_RE,
  isObj,
  parseJson,
  request,
} from './common.js';

/**
 * METAR/TAF from the aviationweather.gov Data API (docs/06; checked 2026-10-08):
 * `GET https://aviationweather.gov/api/data/metar?ids=EDDF,KJFK&format=json` → array of
 * `{icaoId, obsTime (epoch s), rawOb, …}`; `…/taf?…` → `{icaoId, rawTAF, …}`; 204 when no
 * station has data. No key; 100 requests/min, a custom User-Agent recommended; METARs
 * mostly change once an hour, TAFs every few hours, so a 10-min refresh is plenty.
 */

export const AWC_BASE = 'https://aviationweather.gov/api/data';

/** Weather for each airport asked: a report, or null when the API has neither METAR nor TAF. */
export async function fetchWx(
  ctx: FetchContext,
  icaos: readonly string[],
): Promise<Record<string, WxReport | null>> {
  const ids = [...new Set(icaos.map((i) => i.toUpperCase()))].filter((i) => ICAO_RE.test(i));
  if (ids.length === 0) return {};
  const q = `ids=${ids.join(',')}&format=json`;
  const [metars, tafs] = await Promise.all([
    getList(ctx, `${AWC_BASE}/metar?${q}`, 'METAR'),
    getList(ctx, `${AWC_BASE}/taf?${q}`, 'TAF'),
  ]);
  const out: Record<string, WxReport | null> = {};
  for (const icao of ids) {
    const m = parseMetar(metars, icao);
    const taf = parseTaf(tafs, icao);
    out[icao] =
      m === null && taf === null
        ? null
        : { metar: m?.metar ?? null, taf, obsTime: m?.obsTime ?? null };
  }
  return out;
}

async function getList(ctx: FetchContext, url: string, what: string): Promise<unknown[]> {
  const res = await request(ctx, url);
  if (res.status === 204) return [];
  expectOk(res, what);
  const json = parseJson(res.body, what);
  if (!Array.isArray(json)) throw new DataSourceError(`${what}: expected an array`);
  return json;
}

/** The newest METAR of `icao` in an API answer: raw text without the `METAR ` prefix. */
export function parseMetar(
  list: readonly unknown[],
  icao: string,
): { metar: string; obsTime: number | null } | null {
  let best: { metar: string; obsTime: number | null } | null = null;
  for (const x of list) {
    if (!isObj(x) || x['icaoId'] !== icao || typeof x['rawOb'] !== 'string') continue;
    const obs = typeof x['obsTime'] === 'number' ? x['obsTime'] * 1000 : null;
    if (best !== null && (obs ?? 0) <= (best.obsTime ?? 0)) continue;
    best = { metar: cleanReport(x['rawOb'], /^(METAR|SPECI)\s+/), obsTime: obs };
  }
  return best;
}

/** The TAF of `icao` (the first one marked most recent, else the first). */
export function parseTaf(list: readonly unknown[], icao: string): string | null {
  const own = list.filter(
    (x): x is Record<string, unknown> =>
      isObj(x) && x['icaoId'] === icao && typeof x['rawTAF'] === 'string',
  );
  const t = own.find((x) => x['mostRecent'] === 1) ?? own[0];
  return t === undefined ? null : cleanReport(t['rawTAF'] as string, /^$/);
}

/**
 * Single spaces, no `$` (US "maintenance needed" flag: the formatter would turn it into
 * `USD`), no trailing `=`.
 */
function cleanReport(raw: string, prefix: RegExp): string {
  return raw
    .replace(prefix, '')
    .replace(/\s\$(?=\s|$)/g, '')
    .replace(/=\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}
