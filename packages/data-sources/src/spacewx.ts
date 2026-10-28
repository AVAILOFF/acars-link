// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { AuroraCell, AuroraForecast, LatLon, SpaceWeather } from '@acars/core';
import {
  DataSourceError,
  expectOk,
  type FetchContext,
  isObj,
  parseJson,
  request,
} from './common.js';

/**
 * NOAA SWPC space weather (T29, docs/06; checked 2026-10-09). No key; data of the US
 * government (licence text `[ПРИ РЕЛИЗЕ]`).
 *
 * `GET https://services.swpc.noaa.gov/products/noaa-scales.json` → `{"-1": …, "0": …, "1": …,
 * "2": …, "3": …}`, each `{DateStamp: "2026-10-09", TimeStamp: "13:52:00", R: {Scale, Text,
 * MinorProb, MajorProb}, S: {Scale, Text, Prob}, G: {Scale, Text}}`: `0` — the latest observed
 * scales, `-1` — the maximum of the last 24 h, `1`–`3` — today and the next two days, where only
 * G has a scale (R and S give probabilities, approved 2026-10-09: not used).
 *
 * `GET https://services.swpc.noaa.gov/json/ovation_aurora_latest.json` (~0.9 MB) →
 * `{"Observation Time", "Forecast Time", "Data Format": "[Longitude, Latitude, Aurora]",
 * coordinates: [[lon 0..359, lat -90..90, probability %], …]}` — 1°×1° grid, a forecast about an
 * hour ahead. Only the cells nearest the route samples are kept (probability > 0).
 */

export const NOAA_SCALES_URL = 'https://services.swpc.noaa.gov/products/noaa-scales.json';
export const OVATION_URL = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';

export async function fetchSpaceWeather(ctx: FetchContext): Promise<SpaceWeather> {
  const res = await request(ctx, NOAA_SCALES_URL);
  expectOk(res, 'NOAA scales');
  return parseNoaaScales(parseJson(res.body, 'NOAA scales'));
}

const scale = (x: unknown): number | null => {
  if (!isObj(x)) return null;
  const v = Number(x['Scale']);
  return x['Scale'] !== null && Number.isInteger(v) && v >= 0 && v <= 5 ? v : null;
};

export function parseNoaaScales(json: unknown): SpaceWeather {
  if (!isObj(json) || !isObj(json['0'])) throw new DataSourceError('NOAA scales: no "0"');
  const now = json['0'];
  const r = scale(now['R']);
  const s = scale(now['S']);
  const g = scale(now['G']);
  const issued = Date.parse(`${String(now['DateStamp'])}T${String(now['TimeStamp'])}Z`);
  if (r === null || s === null || g === null || !Number.isFinite(issued)) {
    throw new DataSourceError('NOAA scales: bad current values');
  }
  const gForecast: { date: string; g: number }[] = [];
  for (const k of ['1', '2']) {
    const d = json[k];
    if (!isObj(d)) continue;
    const fg = scale(d['G']);
    const date = String(d['DateStamp']);
    if (fg !== null && /^\d{4}-\d{2}-\d{2}$/.test(date)) gForecast.push({ date, g: fg });
  }
  return { issued, current: { r, s, g }, gForecast };
}

export async function fetchAurora(
  ctx: FetchContext,
  route: readonly LatLon[],
): Promise<AuroraForecast> {
  const res = await request(ctx, OVATION_URL);
  expectOk(res, 'OVATION');
  return parseOvation(parseJson(res.body, 'OVATION'), route);
}

/** Cells (probability > 0) nearest the given route points, one per point, deduplicated. */
export function parseOvation(json: unknown, route: readonly LatLon[]): AuroraForecast {
  if (!isObj(json) || !Array.isArray(json['coordinates'])) {
    throw new DataSourceError('OVATION: no coordinates[]');
  }
  const forecastTime = Date.parse(String(json['Forecast Time']));
  if (!Number.isFinite(forecastTime)) throw new DataSourceError('OVATION: no Forecast Time');
  const grid = new Map<string, number>();
  for (const c of json['coordinates']) {
    if (!Array.isArray(c) || c.length < 3) continue;
    const [lon, lat, p] = c as [unknown, unknown, unknown];
    if (typeof lon !== 'number' || typeof lat !== 'number' || typeof p !== 'number') continue;
    if (p > 0) grid.set(`${Math.round(lat)}/${((Math.round(lon) % 360) + 360) % 360}`, p);
  }
  const cells = new Map<string, AuroraCell>();
  for (const pt of route) {
    const lat = Math.round(pt.lat);
    const lon360 = ((Math.round(pt.lon) % 360) + 360) % 360;
    const key = `${lat}/${lon360}`;
    const prob = grid.get(key);
    if (prob === undefined || cells.has(key)) continue;
    cells.set(key, { lat, lon: lon360 > 180 ? lon360 - 360 : lon360, prob });
  }
  return { forecastTime, cells: [...cells.values()] };
}
