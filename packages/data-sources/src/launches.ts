import type { LaunchStatus, SpaceLaunch } from '@acars/core';
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
 * Space launches from TheSpaceDevs Launch Library 2.3.0 (T28, docs/06; checked 2026-10-09):
 * `GET https://ll.thespacedevs.com/2.3.0/launches/?mode=normal&ordering=net&limit=100
 * &net__gte=<ISO>&net__lte=<ISO>` → `{count, next, results: [{id, name, status: {id},
 * net, net_precision: {id}, window_start, window_end, rocket: {configuration: {full_name}},
 * mission: {name} | null, pad: {name, latitude, longitude, country: {alpha_3_code},
 * location: {name}}}]}`.
 * Past and upcoming launches in one list (`/launches/upcoming/` would drop the ones that
 * happened during the flight). The pad position is only in `mode=normal` (`list` has no
 * `pad`). No key: 15 requests per hour per IP (`/2.3.0/api-throttle/`: `your_request_limit`
 * 15, `limit_frequency_secs` 3600) — the service asks once an hour and caches.
 *
 * Kept (approved 2026-10-09): status Go (1) with T-0 precision of an hour or better
 * (`net_precision` 0 SEC, 1 MIN, 2 HR), and launches that happened — In Flight (6), Success
 * (3), Payload Deployed (9), Failure (4), Partial Failure (7). TBD (2), TBC (8), Hold (5) are
 * dropped: their time is not confirmed.
 */

export const LAUNCHES_URL = 'https://ll.thespacedevs.com/2.3.0/launches/';

const STATUS: Readonly<Record<number, LaunchStatus>> = {
  1: 'go',
  6: 'in_flight',
  3: 'success',
  9: 'deployed',
  4: 'failure',
  7: 'partial_failure',
};

/** `net_precision.id` of a Go launch: second, minute, hour. */
const PRECISE = new Set([0, 1, 2]);

/** Launches with T-0 in `[from, to]` (epoch ms UTC). */
export async function fetchLaunches(
  ctx: FetchContext,
  from: number,
  to: number,
): Promise<SpaceLaunch[]> {
  const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const url =
    `${LAUNCHES_URL}?mode=normal&ordering=net&limit=100` +
    `&net__gte=${iso(from)}&net__lte=${iso(to)}`;
  const res = await request(ctx, url);
  expectOk(res, 'Launch Library');
  return parseLaunches(parseJson(res.body, 'Launch Library'));
}

export function parseLaunches(json: unknown): SpaceLaunch[] {
  if (!isObj(json) || !Array.isArray(json['results'])) {
    throw new DataSourceError('Launch Library: no results[]');
  }
  const out: SpaceLaunch[] = [];
  for (const l of json['results']) {
    if (!isObj(l) || typeof l['id'] !== 'string') continue;
    const status = STATUS[idOf(l['status']) ?? -1];
    if (status === undefined) continue;
    if (status === 'go' && !PRECISE.has(idOf(l['net_precision']) ?? -1)) continue;
    const net = time(l['net']);
    const pad = l['pad'];
    if (net === null || !isObj(pad)) continue;
    const lat = Number(pad['latitude']);
    const lon = Number(pad['longitude']);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) continue;
    if (Math.abs(lon) > 180) continue;
    const rocketCfg = isObj(l['rocket']) ? l['rocket']['configuration'] : null;
    const rocket = telexText(
      isObj(rocketCfg) && typeof rocketCfg['full_name'] === 'string'
        ? rocketCfg['full_name']
        : (String(l['name'] ?? '').split('|')[0] ?? ''),
      40,
    );
    if (rocket === '') continue;
    const missionName = isObj(l['mission']) ? l['mission']['name'] : null;
    const mission = typeof missionName === 'string' ? telexText(missionName, 40) : '';
    // `Commercial LC-2, Wenchang Space Launch Site, CHN`: the site without its own country
    // part (`…, People's Republic of China`), then the pad's ISO 3166 alpha-3 country code.
    const location = isObj(pad['location']) ? pad['location']['name'] : null;
    const country = isObj(pad['country']) ? pad['country']['alpha_3_code'] : null;
    const padText = telexText(
      [pad['name'], typeof location === 'string' ? location.split(',')[0] : null, country]
        .filter((s) => typeof s === 'string' && s.trim() !== '')
        .join(', '),
      60,
    );
    out.push({
      id: l['id'],
      rocket,
      mission: mission === '' || mission === 'UNKNOWN PAYLOAD' ? null : mission,
      pad: padText === '' ? 'UNKNOWN PAD' : padText,
      lat,
      lon,
      net,
      windowStart: time(l['window_start']),
      windowEnd: time(l['window_end']),
      status,
    });
  }
  return out.sort((a, b) => a.net - b.net || (a.id < b.id ? -1 : 1));
}

const idOf = (x: unknown): number | null =>
  isObj(x) && typeof x['id'] === 'number' ? x['id'] : null;

function time(x: unknown): number | null {
  if (typeof x !== 'string') return null;
  const t = Date.parse(x);
  return Number.isFinite(t) ? t : null;
}
