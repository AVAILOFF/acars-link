import type { ParkingStand } from '@acars/core';
import {
  DataSourceError,
  expectOk,
  type FetchContext,
  isObj,
  parseJson,
  request,
} from './common.js';

/**
 * Gates and parking positions of an airport from OpenStreetMap via the Overpass API
 * (docs/06): `aeroway=gate` / `aeroway=parking_position` nodes and ways within 4 km of the
 * airport reference point, `ref` tag only. `POST https://overpass-api.de/api/interpreter`
 * with `data=<query>`, `[out:json]` → `{elements: [{type, id, tags: {aeroway, ref}}]}`.
 * Usage policy: < 10 000 queries and < 1 GB a day, identify the client; the public server is
 * often busy (504) — the result is cached for 30 days and a failure only means the
 * placeholder gate. `[ПРОВЕРИТЬ]` on a live answer: the server was overloaded during T13.
 */

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
export const STANDS_RADIUS_M = 4000;

export function standsQuery(lat: number, lon: number): string {
  const at = `around:${STANDS_RADIUS_M},${lat.toFixed(5)},${lon.toFixed(5)}`;
  return `[out:json][timeout:25];nw["aeroway"~"^(gate|parking_position)$"](${at});out tags;`;
}

export async function fetchStands(
  ctx: FetchContext,
  airport: { readonly lat: number; readonly lon: number },
): Promise<ParkingStand[]> {
  const res = await request(ctx, OVERPASS_URL, {
    method: 'POST',
    body: `data=${encodeURIComponent(standsQuery(airport.lat, airport.lon))}`,
    contentType: 'application/x-www-form-urlencoded',
  });
  expectOk(res, 'Overpass');
  return parseOverpassStands(parseJson(res.body, 'Overpass'));
}

export function parseOverpassStands(json: unknown): ParkingStand[] {
  if (!isObj(json) || !Array.isArray(json['elements'])) {
    throw new DataSourceError('Overpass: no elements[]');
  }
  const seen = new Set<string>();
  const out: ParkingStand[] = [];
  for (const el of json['elements']) {
    const tags = isObj(el) && isObj(el['tags']) ? el['tags'] : null;
    if (tags === null || typeof tags['ref'] !== 'string') continue;
    const kind = tags['aeroway'] === 'gate' ? 'gate' : 'stand';
    if (tags['aeroway'] !== 'gate' && tags['aeroway'] !== 'parking_position') continue;
    for (const ref of standRefs(tags['ref'])) {
      const key = `${kind}:${ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ref, kind });
    }
  }
  return out;
}

/** `A12;A13` → A12, A13; `Gate 5` → 5; `v 105` → V105. Anything else is dropped. */
export function standRefs(raw: string): string[] {
  return raw
    .split(/[;,]/)
    .map((r) =>
      r
        .toUpperCase()
        .trim()
        .replace(/^(GATE|STAND|POSITION|POS)\s+/, '')
        .replace(/\s+/g, ''),
    )
    .filter((r) => /^[A-Z0-9]{1,6}$/.test(r));
}
