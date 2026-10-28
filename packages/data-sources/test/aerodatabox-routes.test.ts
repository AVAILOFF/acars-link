// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Ofp, parseSimbriefOfp } from '@acars/core';
import { describe, expect, it } from 'vitest';
import {
  AERODATABOX_GATEWAY,
  DataSourceError,
  ExternalDataService,
  fetchRouteStats,
  type HttpClient,
  MemoryCache,
  parseConnex,
  parseRouteStats,
  ROUTES_CACHE_PREFIX,
  ROUTES_RETENTION_MS,
  routeStatsUrl,
} from '../src/index.js';

/**
 * T55: `aircraft.model` of the FIDS departures and the route statistics of the destination. The
 * fixtures are trimmed live answers for EDDF of 2026-10-21 (times and daily averages synthetic,
 * see fixtures/README.md).
 */

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const fids = fixture('aerodatabox-fids-eddf.json');
const stats = fixture('aerodatabox-routes-eddf.json');
const ofp: Ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        '..',
        '..',
        'core',
        'test',
        'fixtures',
        'ofp',
        'rctp-rjbb-a35k-kgs.json',
      ),
      'utf8',
    ),
  ),
);
const KEY = 'abcdefghijklmnopqrstuvwxyz0123456789';
const T0 = Date.parse('2026-10-08T03:00:00Z');
const DAY = 86_400_000;

function fake(asked: string[], status: number, body = stats): HttpClient {
  return {
    async request(req) {
      asked.push(req.url);
      return { status, body };
    },
  };
}

describe('parseConnex on a live FIDS answer (T55)', () => {
  const dlh = parseConnex(JSON.parse(fids), 'DLH');

  it('keeps the model text of each departure of the airline', () => {
    const lh958 = dlh.find((f) => f.number === 'LH958');
    expect(lh958).toMatchObject({
      dest: 'EGBB',
      codeshare: false,
      model: 'Airbus A320 (Sharklets)',
    });
    expect(dlh.find((f) => f.number === 'LH732')?.model).toBe('Airbus A350-900');
    expect(dlh.every((f) => typeof f.model === 'string')).toBe(true);
  });

  it('a codeshare is its own departure marked IsCodeshared (R3)', () => {
    // LH 5590 is marketed by Lufthansa on the Brussels Airlines SN 2618.
    expect(dlh.find((f) => f.number === 'LH5590')).toMatchObject({ dest: 'EBBR', codeshare: true });
    expect(dlh.find((f) => f.number === 'SN2618')).toBeUndefined();
    expect(parseConnex(JSON.parse(fids), 'BEL').map((f) => [f.number, f.codeshare])).toEqual([
      ['SN2618', false],
    ]);
  });

  it('the duplicate of the live answer stays (the core drops it); an airline without ICAO is no one', () => {
    expect(dlh.filter((f) => f.number === 'LH824')).toHaveLength(2);
    expect(dlh.some((f) => f.number === 'JL7132')).toBe(false);
  });
});

describe('route statistics (T55)', () => {
  it('parse: destination, daily average, operators with an ICAO code only (R5)', () => {
    const list = parseRouteStats(JSON.parse(stats));
    expect(list.map((r) => r.dest)).toEqual([
      'EDDM',
      'EDDB',
      'EGLL',
      'LEPA',
      'LIRF',
      'KJFK',
      'OMDB',
    ]);
    const eddm = list.find((r) => r.dest === 'EDDM');
    // GCK and VJH have no ICAO code in the answer.
    expect(eddm).toEqual({
      dest: 'EDDM',
      daily: 12.5,
      operators: ['CFG', 'DLH', 'KAC', 'LHX', 'OCN'],
    });
    expect(() => parseRouteStats({})).toThrow(DataSourceError);
    expect(
      parseRouteStats({
        routes: [{ destination: { icao: 'X' }, averageDailyFlights: 1, operators: [] }],
      }),
    ).toEqual([]);
  });

  it('the key in the RapidAPI header only; 204 = none; 401/429 final, 5xx not', async () => {
    const asked: string[] = [];
    let headers: Readonly<Record<string, string>> = {};
    const http: HttpClient = {
      async request(req) {
        asked.push(req.url);
        headers = req.headers ?? {};
        return { status: 200, body: stats };
      },
    };
    const got = await fetchRouteStats({ http, userAgent: 't' }, KEY, 'EDDF');
    expect(got.icao).toBe('EDDF');
    expect(got.list.length).toBe(7);
    expect(asked).toEqual([routeStatsUrl('EDDF')]);
    expect(asked[0]).toBe(`${AERODATABOX_GATEWAY.base}/airports/icao/EDDF/stats/routes/daily`);
    expect(asked[0]).not.toContain(KEY);
    expect(headers[AERODATABOX_GATEWAY.keyHeader]).toBe(KEY);
    const run = (status: number) =>
      fetchRouteStats({ http: fake([], status), userAgent: 't' }, KEY, 'EDDF');
    expect(await run(204)).toEqual({ icao: 'EDDF', list: [] });
    for (const status of [401, 403, 429, 404]) {
      const e = await run(status).catch((x: unknown) => x);
      expect((e as DataSourceError).final).toBe(true);
      expect((e as Error).message).not.toContain(KEY);
    }
    expect(((await run(503).catch((x: unknown) => x)) as DataSourceError).final).toBe(false);
  });
});

describe('ExternalDataService: route statistics (T55, R5)', () => {
  const service = (asked: string[], status: number, cache = new MemoryCache()) =>
    new ExternalDataService({
      http: fake(asked, status),
      userAgent: 't',
      sources: ['routes'],
      cache,
    });
  const flight = async (svc: ExternalDataService, now: number, key: string | null = KEY) => {
    svc.startFlight(ofp, now, { connexKey: key });
    svc.tick(now, null);
    await svc.settle();
    return svc.take(now);
  };

  it('only with the AeroDataBox key; the update field for the destination', async () => {
    const asked: string[] = [];
    expect((await flight(service(asked, 200), T0, null)).update).toBeNull();
    expect(asked).toEqual([]);
    const got = await flight(service(asked, 200), T0);
    expect(got.update?.routes?.icao).toBe('RJBB');
    expect(got.update?.routes?.list.length).toBe(7);
    expect(asked).toEqual([routeStatsUrl('RJBB')]);
  });

  it('from the cache while younger than 7 days, then asked again', async () => {
    const asked: string[] = [];
    const cache = new MemoryCache();
    await flight(service(asked, 200, cache), T0);
    const hit = await flight(service(asked, 200, cache), T0 + 6 * DAY);
    expect(hit.update?.routes?.list.length).toBe(7);
    expect(asked.length).toBe(1);
    expect((await cache.get(`${ROUTES_CACHE_PREFIX}RJBB`))?.t).toBe(T0);
    await flight(service(asked, 200, cache), T0 + ROUTES_RETENTION_MS + 1);
    expect(asked.length).toBe(2);
  });

  it('429: no statistics (the core falls back to level 3), not asked again in the flight', async () => {
    const asked: string[] = [];
    const svc = service(asked, 429);
    const got = await flight(svc, T0);
    expect(got.update).toBeNull();
    expect(got.notes.map((n) => [n.source, n.ok])).toEqual([['routes', false]]);
    svc.tick(T0 + 3_600_000, 'CRUISE');
    await svc.settle();
    expect(asked.length).toBe(1);
  });
});
