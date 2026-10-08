import type { NaturalEvent } from '@acars/core';
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
 * Natural events from NASA EONET v3 (docs/06; checked 2026-10-08):
 * `GET https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=N&category=a,b` →
 * `{events: [{id, title, categories: [{id}], geometry: [{date, type, coordinates}]}]}`;
 * `coordinates` is `[lon, lat]` for a Point, rings of `[lon, lat]` for a Polygon. Without
 * `days` the open list has thousands of years-old wildfires, so: storms, wildfires,
 * earthquakes and man-made events of the last 30 days, volcanoes of the last year (an
 * eruption stays "open" for months). Categories as in the original (docs/01). No key.
 */

export const EONET_EVENTS_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events';

const QUERIES = [
  { days: 30, categories: 'severeStorms,wildfires,earthquakes,manmade' },
  { days: 365, categories: 'volcanoes' },
] as const;

export async function fetchEonetEvents(ctx: FetchContext): Promise<NaturalEvent[]> {
  const lists = await Promise.all(
    QUERIES.map(async (q) => {
      const url = `${EONET_EVENTS_URL}?status=open&days=${q.days}&category=${q.categories}`;
      const res = await request(ctx, url);
      expectOk(res, 'EONET');
      return parseEonet(parseJson(res.body, 'EONET'));
    }),
  );
  const byId = new Map<string, NaturalEvent>();
  for (const e of lists.flat()) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function parseEonet(json: unknown): NaturalEvent[] {
  if (!isObj(json) || !Array.isArray(json['events'])) {
    throw new DataSourceError('EONET: no events[]');
  }
  const out: NaturalEvent[] = [];
  for (const e of json['events']) {
    if (!isObj(e) || typeof e['id'] !== 'string' || typeof e['title'] !== 'string') continue;
    const cats = Array.isArray(e['categories']) ? e['categories'] : [];
    const category = cats.find((c): c is Record<string, unknown> => isObj(c));
    if (category === undefined || typeof category['id'] !== 'string') continue;
    const geo = Array.isArray(e['geometry']) ? e['geometry'] : [];
    // The latest position (a storm moves; the list is in time order).
    let best: { date: number; lat: number; lon: number } | null = null;
    for (const g of geo) {
      if (!isObj(g) || typeof g['date'] !== 'string') continue;
      const date = Date.parse(g['date']);
      const pos = position(g['type'], g['coordinates']);
      if (!Number.isFinite(date) || pos === null) continue;
      if (best === null || date >= best.date) best = { date, ...pos };
    }
    if (best === null) continue;
    const title = telexText(e['title']);
    if (title === '') continue;
    out.push({ id: e['id'], title, category: category['id'], ...best });
  }
  return out;
}

function position(type: unknown, c: unknown): { lat: number; lon: number } | null {
  const pt = (p: unknown) =>
    Array.isArray(p) &&
    typeof p[0] === 'number' &&
    typeof p[1] === 'number' &&
    Math.abs(p[1]) <= 90 &&
    Math.abs(p[0]) <= 180
      ? { lon: p[0], lat: p[1] }
      : null;
  if (type === 'Point') return pt(c);
  if (type === 'Polygon' && Array.isArray(c) && Array.isArray(c[0])) {
    // Centroid of the outer ring's vertices: good enough for "near the route".
    const ring = (c[0] as unknown[]).map(pt).filter((p) => p !== null);
    if (ring.length === 0) return null;
    return {
      lat: ring.reduce((s, p) => s + p.lat, 0) / ring.length,
      lon: ring.reduce((s, p) => s + p.lon, 0) / ring.length,
    };
  }
  return null;
}
