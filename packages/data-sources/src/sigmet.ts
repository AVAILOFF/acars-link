// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { AshSigmet, LatLon } from '@acars/core';
import {
  DataSourceError,
  expectOk,
  type FetchContext,
  isObj,
  parseJson,
  request,
  telexText,
} from './common.js';

/**
 * Volcanic ash SIGMETs (T29, docs/06; checked 2026-10-09): aviationweather.gov international
 * SIGMETs `GET https://aviationweather.gov/api/data/isigmet?format=json&hazard=va` → `[{icaoId,
 * firId, firName, validTimeFrom, validTimeTo (epoch s), seriesId, hazard: "VA", qualifier:
 * "ERUPTION MT DUKONO", base, top (ft, null), geom: "AREA" | "AREAS", coords: [{lat, lon}] |
 * [[{lat, lon}]], rawSigmet}]`. Forecast positions of a cloud come as their own entries (series
 * with `F`, e.g. `A3F`). No key; 100 requests a minute (as for METAR, T13).
 */

export const ISIGMET_URL = 'https://aviationweather.gov/api/data/isigmet';

export async function fetchAshSigmets(ctx: FetchContext): Promise<AshSigmet[]> {
  const res = await request(ctx, `${ISIGMET_URL}?format=json&hazard=va`);
  if (res.status === 204) return [];
  expectOk(res, 'SIGMET');
  return parseAshSigmets(parseJson(res.body, 'SIGMET'));
}

const pt = (p: unknown): LatLon | null =>
  isObj(p) &&
  typeof p['lat'] === 'number' &&
  typeof p['lon'] === 'number' &&
  Math.abs(p['lat']) <= 90 &&
  Math.abs(p['lon']) <= 180
    ? { lat: p['lat'], lon: p['lon'] }
    : null;

export function parseAshSigmets(json: unknown): AshSigmet[] {
  if (!Array.isArray(json)) throw new DataSourceError('SIGMET: not a list');
  const out: AshSigmet[] = [];
  for (const s of json) {
    if (!isObj(s) || s['hazard'] !== 'VA') continue;
    const from = Number(s['validTimeFrom']);
    const to = Number(s['validTimeTo']);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    const c = s['coords'];
    const rings: unknown[] = Array.isArray(c) && Array.isArray(c[0]) ? c : [c];
    const areas = rings
      .map((r) => (Array.isArray(r) ? r.map(pt).filter((p) => p !== null) : []))
      .filter((r) => r.length >= 3);
    if (areas.length === 0) continue;
    const fir = telexText(String(s['firId'] ?? ''), 4);
    const qualifier = telexText(String(s['qualifier'] ?? ''), 40).replace(/^ERUPTION\s+/, '');
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    out.push({
      id: `${fir} ${telexText(String(s['seriesId'] ?? ''), 4)}`.trim(),
      fir,
      volcano: qualifier === '' ? 'UNKNOWN VOLCANO' : qualifier,
      baseFt: num(s['base']),
      topFt: num(s['top']),
      validFrom: from * 1000,
      validTo: to * 1000,
      areas,
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.validFrom - b.validFrom));
}
