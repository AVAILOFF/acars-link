// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { Earthquake } from '@acars/core';
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
 * Earthquakes (T29, docs/06; checked 2026-10-09): USGS real-time feed "M4.5+, past day"
 * `GET https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson` (refreshed
 * every minute) → GeoJSON `{features: [{id, properties: {mag, place, time (epoch ms), type},
 * geometry: {coordinates: [lon, lat, depth km]}}]}`. No key; USGS terms `[ПРИ РЕЛИЗЕ]`.
 */

export const USGS_FEED_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson';

export async function fetchQuakes(ctx: FetchContext): Promise<Earthquake[]> {
  const res = await request(ctx, USGS_FEED_URL);
  expectOk(res, 'USGS');
  return parseQuakes(parseJson(res.body, 'USGS'));
}

export function parseQuakes(json: unknown): Earthquake[] {
  if (!isObj(json) || !Array.isArray(json['features'])) {
    throw new DataSourceError('USGS: no features[]');
  }
  const out: Earthquake[] = [];
  for (const f of json['features']) {
    if (!isObj(f) || typeof f['id'] !== 'string') continue;
    const p = f['properties'];
    const g = f['geometry'];
    if (!isObj(p) || !isObj(g) || !Array.isArray(g['coordinates'])) continue;
    if (p['type'] !== 'earthquake') continue;
    const [lon, lat, depth] = g['coordinates'] as unknown[];
    const mag = p['mag'];
    const time = p['time'];
    if (
      typeof lon !== 'number' ||
      typeof lat !== 'number' ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180 ||
      typeof mag !== 'number' ||
      typeof time !== 'number'
    )
      continue;
    const place = telexText(typeof p['place'] === 'string' ? p['place'] : '', 60);
    out.push({
      id: f['id'],
      mag,
      place: place === '' ? 'UNKNOWN LOCATION' : place,
      time,
      lat,
      lon,
      depthKm: typeof depth === 'number' ? depth : 0,
    });
  }
  return out.sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1));
}
