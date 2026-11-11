// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Ofp, parseSimbriefOfp } from '@acars/core';
import { describe, expect, it } from 'vitest';
import {
  AERODATABOX_GATEWAY,
  connexUrl,
  DataSourceError,
  ExternalDataService,
  fetchConnex,
  type HttpClient,
  localStamp,
  parseConnex,
  parseUtc,
} from '../src/index.js';

/**
 * T30: AeroDataBox FIDS with the user's key (docs/07 C1, C5, C10, C11). The fixture is built
 * from the OpenAPI spec v1.15.4.0 (no live answer without a key: `[VERIFY]`, C6).
 */

const fixture = readFileSync(
  join(import.meta.dirname, 'fixtures', 'aerodatabox-fids.json'),
  'utf8',
);
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

interface Asked {
  url: string;
  headers: Readonly<Record<string, string>>;
}

function fake(asked: Asked[], status: number | (() => number), body = fixture): HttpClient {
  return {
    async request(req) {
      asked.push({ url: req.url, headers: req.headers ?? {} });
      return { status: typeof status === 'function' ? status() : status, body };
    },
  };
}

describe('AeroDataBox adapter', () => {
  it('asks the local window STA+30 min … STA+4 h of the destination, passenger departures', () => {
    expect(ofp.destination.utcOffsetH).toBe(9);
    // STA 10:20Z = 19:20 local.
    expect(connexUrl(ofp)).toBe(
      'https://aerodatabox.p.rapidapi.com/flights/airports/icao/RJBB/2026-10-08T19:50/2026-10-08T23:20' +
        '?direction=Departure&withLeg=false&withCancelled=false&withCodeshared=true' +
        '&withCargo=false&withPrivate=false&withLocation=false',
    );
    expect(localStamp(Date.parse('2026-10-08T23:30:00Z'), 5.5)).toBe('2026-10-09T05:00');
  });

  it('no request without the airline or the UTC offset (C10)', () => {
    expect(connexUrl({ ...ofp, airlineIcao: null })).toBeNull();
    expect(connexUrl({ ...ofp, destination: { ...ofp.destination, utcOffsetH: null } })).toBeNull();
  });

  it('keeps the departures of the airline: no cargo, no cancelled; codes cleaned', () => {
    expect(parseConnex(JSON.parse(fixture), 'SJX')).toEqual([
      {
        number: 'JX862',
        dest: 'RCTP',
        std: Date.parse('2026-10-08T11:35:00Z'),
        terminal: '1',
        gate: '12',
        codeshare: false,
        model: null,
      },
      {
        number: 'JX9862',
        dest: 'RCTP',
        std: Date.parse('2026-10-08T11:35:00Z'),
        terminal: null,
        gate: null,
        codeshare: true,
        model: null,
      },
      {
        number: 'JX868',
        dest: 'RCKH',
        std: Date.parse('2026-10-08T12:50:00Z'),
        terminal: 'T1',
        gate: null,
        codeshare: false,
        model: null,
      },
    ]);
    expect(parseConnex(JSON.parse(fixture), 'ANA')[0]?.gate).toBe('5');
    expect(() => parseConnex([], 'SJX')).toThrow(DataSourceError);
  });

  it('UTC times: the AeroDataBox form and ISO; nothing else', () => {
    expect(parseUtc('2026-10-08 11:35Z')).toBe(Date.parse('2026-10-08T11:35:00Z'));
    expect(parseUtc('2026-10-08T11:35:00Z')).toBe(Date.parse('2026-10-08T11:35:00Z'));
    expect(parseUtc('2026-10-08T11:35:00+00:00')).toBe(Date.parse('2026-10-08T11:35:00Z'));
    expect(parseUtc('2026-10-08 20:35+09:00')).toBeNull();
    expect(parseUtc(null)).toBeNull();
  });

  it('the key goes in the RapidAPI header only (C1, C11)', async () => {
    const asked: Asked[] = [];
    const got = await fetchConnex({ http: fake(asked, 200), userAgent: 't' }, KEY, ofp);
    expect(got?.icao).toBe('RJBB');
    expect(got?.list.length).toBe(3);
    expect(asked[0]?.headers[AERODATABOX_GATEWAY.keyHeader]).toBe(KEY);
    expect(asked[0]?.headers['X-RapidAPI-Host']).toBe('aerodatabox.p.rapidapi.com');
    expect(asked[0]?.url).not.toContain(KEY);
  });

  it('204: no departures; 401/429/4xx: final; 5xx: may be retried; never the key in an error', async () => {
    const run = (status: number) =>
      fetchConnex({ http: fake([], status), userAgent: 't' }, KEY, ofp);
    expect(await run(204)).toEqual({ icao: 'RJBB', list: [] });
    for (const status of [401, 403, 429, 404]) {
      const e = await run(status).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(DataSourceError);
      expect((e as DataSourceError).final).toBe(true);
      expect((e as Error).message).not.toContain(KEY);
    }
    const e = await run(503).catch((x: unknown) => x);
    expect((e as DataSourceError).final).toBe(false);
  });
});

describe('ExternalDataService: onward departures (C5, C10)', () => {
  it('only with a key; once per flight; the result is the update field', async () => {
    const none: Asked[] = [];
    const off = new ExternalDataService({
      http: fake(none, 200),
      userAgent: 't',
      sources: ['connex'],
    });
    off.startFlight(ofp, T0);
    off.tick(T0, null);
    await off.settle();
    expect(none).toEqual([]);

    const asked: Asked[] = [];
    const svc = new ExternalDataService({
      http: fake(asked, 200),
      userAgent: 't',
      sources: ['connex'],
    });
    svc.startFlight(ofp, T0, { connexKey: KEY });
    svc.tick(T0, null);
    await svc.settle();
    expect(svc.take(T0).update?.connex?.list.length).toBe(3);
    svc.tick(T0 + 3_600_000, 'CRUISE');
    await svc.settle();
    expect(asked.length).toBe(1);
  });

  it('a 5xx is retried once after 2 min, then the source gives up', async () => {
    const asked: Asked[] = [];
    const svc = new ExternalDataService({
      http: fake(asked, 500),
      userAgent: 't',
      sources: ['connex'],
    });
    svc.startFlight(ofp, T0, { connexKey: KEY });
    for (const min of [0, 1, 2, 5, 60]) {
      svc.tick(T0 + min * 60_000, null);
      await svc.settle();
    }
    expect(asked.length).toBe(2);
    expect(svc.take(T0).notes.map((n) => n.ok)).toEqual([false]);
  });

  it('a rejected key (401) or a used-up quota (429) is not asked again in the flight', async () => {
    for (const status of [401, 429]) {
      const asked: Asked[] = [];
      const svc = new ExternalDataService({
        http: fake(asked, status),
        userAgent: 't',
        sources: ['connex'],
      });
      svc.startFlight(ofp, T0, { connexKey: KEY });
      for (const min of [0, 5, 60]) {
        svc.tick(T0 + min * 60_000, null);
        await svc.settle();
      }
      expect(asked.length).toBe(1);
    }
  });
});
