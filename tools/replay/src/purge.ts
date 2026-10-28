// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { CONNEX_ATTRIBUTION } from '@acars/core';

/**
 * AeroDataBox data in a recording (T30, docs/07 C9): the terms (ed. 2026-10-11, p. 5.5) allow a
 * copy for at most 7 days; identifiers — flight number, airport code — may stay (p. 5.8). The
 * app purges recordings older than that: in `tick` data the time, terminal, gate and aircraft
 * model (T55) of every `connex` departure and the daily average of every `routes` route (T55)
 * become null, and a live telex carrying the data (its attribution line) keeps only
 * {@link PURGED_TEXT}. A replay then runs the fallback (no real onward flight), and `--check`
 * reports the purged telexes as differences.
 */

export const CONNEX_RETENTION_MS = 7 * 24 * 3_600_000;
export const PURGED_TEXT = 'PURGED: AERODATABOX DATA OLDER THAN 7 DAYS';

/** Lines that may carry AeroDataBox data. */
const ADB = ['"connex"', '"routes"', CONNEX_ATTRIBUTION];

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/** The JSONL text with the AeroDataBox data purged; null when there is nothing to purge. */
export function purgeConnex(jsonl: string): string | null {
  if (!ADB.some((k) => jsonl.includes(k))) return null;
  let changed = false;
  const lines = jsonl.split('\n').map((line) => {
    if (!ADB.some((k) => line.includes(k))) return line;
    let x: unknown;
    try {
      x = JSON.parse(line);
    } catch {
      return line; // a broken last line stays as it is (the reader skips it)
    }
    if (!isObj(x)) return line;
    let hit = false;
    const data = x['type'] === 'tick' && isObj(x['data']) ? x['data'] : null;
    if (data !== null && isObj(data['connex'])) {
      const c = data['connex'];
      if (Array.isArray(c['list'])) {
        c['list'] = c['list'].map((f: unknown) => {
          if (
            !isObj(f) ||
            (f['std'] === null &&
              f['terminal'] === null &&
              f['gate'] === null &&
              (f['model'] ?? null) === null)
          ) {
            return f;
          }
          hit = true;
          const model = 'model' in f ? { model: null } : {};
          return { ...f, std: null, terminal: null, gate: null, ...model };
        });
      }
    }
    if (data !== null && isObj(data['routes'])) {
      const r = data['routes'];
      if (Array.isArray(r['list'])) {
        r['list'] = r['list'].map((route: unknown) => {
          if (!isObj(route) || route['daily'] === null) return route;
          hit = true;
          return { ...route, daily: null };
        });
      }
    }
    if (
      x['type'] === 'out' &&
      typeof x['text'] === 'string' &&
      x['text'].includes(CONNEX_ATTRIBUTION)
    ) {
      hit = true;
      x['text'] = PURGED_TEXT;
    }
    if (!hit) return line;
    changed = true;
    return JSON.stringify(x);
  });
  return changed ? lines.join('\n') : null;
}

/** True when the recording has AeroDataBox data that was purged (for `--check`). */
export function hasPurgedConnex(jsonl: string): boolean {
  return (
    jsonl.includes(PURGED_TEXT) ||
    jsonl
      .split('\n')
      .some(
        (l) =>
          (l.includes('"connex"') && l.includes('"std":null')) ||
          (l.includes('"routes"') && l.includes('"daily":null')),
      )
  );
}
