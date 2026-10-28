// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { type F1Race, NHL_STATES, type NhlGame, type NhlState } from '@acars/core';
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
 * Sport results (T29, docs/06; checked 2026-10-09).
 *
 * Formula 1: Jolpica (successor of Ergast) `GET https://api.jolpi.ca/ergast/f1/current/last/results.json`
 * → `{MRData: {RaceTable: {season, round, Races: [{raceName, date, time, Results: [{position,
 * Driver: {code, familyName}, Constructor: {name}, Time: {millis}}]}]}}}`. The finish is the
 * start + the winner's race time `Time.millis`. No key; non-commercial use, data CC BY-NC-SA 4.0
 * (attribution: `SOURCE JOLPICA`).
 *
 * NHL: `GET https://api-web.nhle.com/v1/score/{YYYY-MM-DD}` (`/v1/score/now` is a 307 to the
 * current date; the HTTP client follows no redirects) → `{games: [{id, gameType (1 preseason,
 * 2 regular, 3 playoffs), startTimeUTC, gameState, awayTeam: {abbrev, score}, homeTeam: {abbrev,
 * score}, gameOutcome: {lastPeriodType}}]}`. The league's own domain, without documentation or
 * published terms (approved 2026-10-09). No end time: the core sees a game go final between
 * updates.
 */

export const JOLPICA_F1_URL = 'https://api.jolpi.ca/ergast/f1/current/last/results.json';
export const NHL_SCORE_URL = 'https://api-web.nhle.com/v1/score';

export async function fetchF1(ctx: FetchContext): Promise<F1Race | null> {
  const res = await request(ctx, JOLPICA_F1_URL);
  expectOk(res, 'Jolpica');
  return parseF1(parseJson(res.body, 'Jolpica'));
}

export function parseF1(json: unknown): F1Race | null {
  const mr = isObj(json) ? json['MRData'] : null;
  const table = isObj(mr) ? mr['RaceTable'] : null;
  if (!isObj(table) || !Array.isArray(table['Races'])) {
    throw new DataSourceError('Jolpica: no RaceTable.Races');
  }
  const race = table['Races'][0];
  if (!isObj(race) || !Array.isArray(race['Results'])) return null;
  const start = Date.parse(`${String(race['date'])}T${String(race['time'] ?? '')}`);
  const results = race['Results'].filter(isObj);
  const winner = results.find((r) => r['position'] === '1');
  const millis = isObj(winner) && isObj(winner['Time']) ? Number(winner['Time']['millis']) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(millis)) return null;
  const podium: { pos: number; code: string; team: string }[] = [];
  for (const pos of [1, 2, 3]) {
    const r = results.find((x) => x['position'] === String(pos));
    if (r === undefined) continue;
    const d = isObj(r['Driver']) ? r['Driver'] : {};
    const code = telexText(String(d['code'] ?? d['familyName'] ?? ''), 20);
    const team = telexText(isObj(r['Constructor']) ? String(r['Constructor']['name']) : '', 30);
    if (code !== '') podium.push({ pos, code, team });
  }
  if (podium.length === 0) return null;
  return {
    season: String(race['season'] ?? table['season']),
    round: String(race['round'] ?? table['round']),
    name: telexText(String(race['raceName'] ?? ''), 50),
    start,
    finish: start + millis,
    podium,
  };
}

export async function fetchNhl(ctx: FetchContext, dates: readonly string[]): Promise<NhlGame[]> {
  const lists = await Promise.all(
    dates.map(async (d) => {
      const res = await request(ctx, `${NHL_SCORE_URL}/${d}`);
      expectOk(res, 'NHL');
      return parseNhl(parseJson(res.body, 'NHL'));
    }),
  );
  const byId = new Map<number, NhlGame>();
  for (const g of lists.flat()) byId.set(g.id, g);
  return [...byId.values()].sort((a, b) => a.start - b.start || a.id - b.id);
}

export function parseNhl(json: unknown): NhlGame[] {
  if (!isObj(json) || !Array.isArray(json['games'])) throw new DataSourceError('NHL: no games[]');
  const out: NhlGame[] = [];
  for (const g of json['games']) {
    if (!isObj(g) || typeof g['id'] !== 'number') continue;
    if (g['gameType'] !== 2 && g['gameType'] !== 3) continue;
    const state = g['gameState'] as NhlState;
    if (!NHL_STATES.includes(state)) continue;
    const start = Date.parse(String(g['startTimeUTC']));
    const away = g['awayTeam'];
    const home = g['homeTeam'];
    if (!Number.isFinite(start) || !isObj(away) || !isObj(home)) continue;
    const abbrev = (t: Record<string, unknown>) => telexText(String(t['abbrev'] ?? ''), 4);
    const score = (t: Record<string, unknown>) =>
      typeof t['score'] === 'number' ? t['score'] : null;
    const outcome = g['gameOutcome'];
    const last = isObj(outcome) ? outcome['lastPeriodType'] : null;
    if (abbrev(away) === '' || abbrev(home) === '') continue;
    out.push({
      id: g['id'],
      start,
      state,
      away: abbrev(away),
      home: abbrev(home),
      awayScore: score(away),
      homeScore: score(home),
      lastPeriod: typeof last === 'string' ? telexText(last, 3) : null,
    });
  }
  return out;
}
