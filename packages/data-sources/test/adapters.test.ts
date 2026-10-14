import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSimbriefOfp } from '@acars/core';
import { describe, expect, it } from 'vitest';
import {
  type DataCache,
  DataSourceError,
  ExternalDataService,
  fetchWx,
  type HttpClient,
  MemoryCache,
  parseEonet,
  parseLaunches,
  parseMetar,
  parseOverpassStands,
  parseTaf,
  parseVatsimFeed,
  standRefs,
  standsQuery,
  stationsFor,
  telexText,
} from '../src/index.js';

/** T13: parsers on (trimmed) real answers, the service's schedule, cache and degradation. */

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const ofp = parseSimbriefOfp(
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
const MIN = 60_000;

type Route = (url: string, body?: string) => { status: number; body: string } | Promise<never>;

/** Fake HTTP: routes by URL prefix, records requests, can hold answers until released. */
function fakeHttp(route: Route) {
  const calls: { method: string; url: string; body?: string; ua?: string }[] = [];
  const http: HttpClient = {
    async request(req) {
      calls.push({
        method: req.method,
        url: req.url,
        ...(req.body === undefined ? {} : { body: req.body }),
        ...(req.headers?.['User-Agent'] === undefined ? {} : { ua: req.headers['User-Agent'] }),
      });
      return route(req.url, req.body);
    },
  };
  return { http, calls };
}

const live: Route = (url) => {
  if (url.includes('/api/data/metar')) return { status: 200, body: fixture('metar.json') };
  if (url.includes('/api/data/taf')) return { status: 200, body: fixture('taf.json') };
  if (url.includes('vatsim-data.json')) return { status: 200, body: fixture('vatsim-data.json') };
  if (url.includes('eonet')) return { status: 200, body: fixture('eonet.json') };
  if (url.includes('overpass')) return { status: 200, body: fixture('overpass-stands.json') };
  if (url.includes('thespacedevs')) return { status: 200, body: fixture('launches.json') };
  return { status: 404, body: '' };
};

describe('aviationweather.gov METAR/TAF', () => {
  const metars = JSON.parse(fixture('metar.json')) as unknown[];
  const tafs = JSON.parse(fixture('taf.json')) as unknown[];

  it('takes the raw METAR without the type prefix and the observation time in ms', () => {
    const m = parseMetar(metars, 'EDDF');
    expect(m?.metar).toMatch(/^EDDF \d{6}Z /);
    expect(m?.obsTime).toBe(
      (metars.find((x) => (x as { icaoId: string }).icaoId === 'EDDF') as { obsTime: number })
        .obsTime * 1000,
    );
    expect(parseMetar(metars, 'ZZZZ')).toBeNull();
  });

  it('drops the US maintenance flag `$` (the formatter would print USD)', () => {
    const m = parseMetar(
      [{ icaoId: 'KJFK', obsTime: 1, rawOb: 'METAR KJFK 081351Z 27011KT A2986 RMK AO2 $' }],
      'KJFK',
    );
    expect(m?.metar).toBe('KJFK 081351Z 27011KT A2986 RMK AO2');
  });

  it('keeps the newest METAR of a station and the most recent TAF', () => {
    const m = parseMetar(
      [
        { icaoId: 'EDDF', obsTime: 100, rawOb: 'METAR EDDF OLD' },
        { icaoId: 'EDDF', obsTime: 200, rawOb: 'SPECI EDDF NEW' },
      ],
      'EDDF',
    );
    expect(m).toEqual({ metar: 'EDDF NEW', obsTime: 200_000 });
    expect(parseTaf(tafs, 'EDDF')).toMatch(/^TAF .*EDDF/);
  });

  it('asks both endpoints once for all airports; 204 = no report', async () => {
    const { http, calls } = fakeHttp((url) =>
      url.includes('metar')
        ? { status: 200, body: fixture('metar.json') }
        : { status: 204, body: '' },
    );
    const wx = await fetchWx({ http, userAgent: 'test' }, ['eddf', 'ZZZZ', 'EDDF', 'bad!']);
    expect(calls.map((c) => c.url)).toEqual([
      'https://aviationweather.gov/api/data/metar?ids=EDDF,ZZZZ&format=json',
      'https://aviationweather.gov/api/data/taf?ids=EDDF,ZZZZ&format=json',
    ]);
    expect(calls.every((c) => c.ua === 'test')).toBe(true);
    expect(wx['EDDF']?.metar).toMatch(/^EDDF /);
    expect(wx['EDDF']?.taf).toBeNull();
    expect(wx['ZZZZ']).toBeNull();
  });

  it('turns HTTP errors, 429 and non-JSON into DataSourceError', async () => {
    for (const r of [
      { status: 500, body: '' },
      { status: 429, body: '' },
      { status: 200, body: '<html>' },
    ]) {
      const { http } = fakeHttp(() => r);
      await expect(fetchWx({ http, userAgent: 't' }, ['EDDF'])).rejects.toBeInstanceOf(
        DataSourceError,
      );
    }
    const down: HttpClient = { request: () => Promise.reject(new Error('network error')) };
    await expect(fetchWx({ http: down, userAgent: 't' }, ['EDDF'])).rejects.toThrow(
      DataSourceError,
    );
  });
});

describe('VATSIM data feed v3', () => {
  const stations = parseVatsimFeed(JSON.parse(fixture('vatsim-data.json')));

  it('keeps DEL/GND/TWR/APP and ATIS, no observers, centres or names', () => {
    expect(stations.some((s) => s.callsign.endsWith('_OBS') || s.callsign.endsWith('_CTR'))).toBe(
      false,
    );
    expect(stations.find((s) => s.callsign === 'EDDF_ATIS')).toEqual({
      callsign: 'EDDF_ATIS',
      atisText: 'SYNTHETIC',
      facility: 'ATIS',
      frequency: '118.025',
      atisCode: 'K',
      prefix: 'EDDF',
    });
    expect(JSON.stringify(stations)).not.toMatch(/"(name|cid)"/);
    // `EDDF_X_SUP` on 199.998 is not a real frequency.
    expect(stations.some((s) => s.callsign === 'EDDF_X_SUP')).toBe(false);
  });

  it('matches stations to airports by ICAO, IATA and US short code', () => {
    const atc = stationsFor(stations, [
      { icao: 'EDDF', iata: 'FRA' },
      { icao: 'KJFK', iata: 'JFK' },
      { icao: 'RJBB', iata: 'KIX' },
      { icao: 'RCTP', iata: 'TPE' },
    ]);
    expect(atc['EDDF']?.map((s) => s.callsign).sort()).toEqual([
      'EDDF_ATIS',
      'EDDF_DEL',
      'EDDF_N_APP',
      'EDDF_TWR',
    ]);
    expect(atc['KJFK']?.map((s) => s.callsign).sort()).toEqual(['JFK_TWR', 'KJFK_GND']);
    expect(atc['RJBB']?.map((s) => s.callsign).sort()).toEqual(['KIX_APP', 'RJBB_TWR']);
    expect(atc['RCTP']).toEqual([]);
  });

  it('rejects a feed without controllers', () => {
    expect(() => parseVatsimFeed({})).toThrow(DataSourceError);
  });
});

describe('NASA EONET v3', () => {
  it('takes the latest position of each event, telex-safe title', () => {
    const events = parseEonet(JSON.parse(fixture('eonet.json')));
    expect(events.length).toBeGreaterThan(3);
    for (const e of events) {
      expect(e.title).toMatch(/^[A-Z0-9 .,/()-]+$/);
      expect(Math.abs(e.lat)).toBeLessThanOrEqual(90);
    }
    const storm = parseEonet({
      events: [
        {
          id: 'E1',
          title: 'Typhoon Ça-Va, Japan',
          categories: [{ id: 'severeStorms' }],
          geometry: [
            { date: '2026-10-07T00:00:00Z', type: 'Point', coordinates: [130, 20] },
            { date: '2026-10-08T00:00:00Z', type: 'Point', coordinates: [131, 21] },
          ],
        },
        {
          id: 'E2',
          title: 'Fire',
          categories: [{ id: 'wildfires' }],
          geometry: [
            {
              date: '2026-10-08T00:00:00Z',
              type: 'Polygon',
              coordinates: [
                [
                  [10, 40],
                  [12, 40],
                  [12, 42],
                  [10, 42],
                ],
              ],
            },
          ],
        },
        { id: 'E3', title: 'No geometry', categories: [{ id: 'floods' }], geometry: [] },
      ],
    });
    expect(storm).toEqual([
      {
        id: 'E1',
        title: 'TYPHOON CA-VA, JAPAN',
        category: 'severeStorms',
        lat: 21,
        lon: 131,
        date: Date.UTC(2026, 9, 8),
      },
      {
        id: 'E2',
        title: 'FIRE',
        category: 'wildfires',
        lat: 41,
        lon: 11,
        date: Date.UTC(2026, 9, 8),
      },
    ]);
  });
});

describe('TheSpaceDevs Launch Library 2.3.0 (T28)', () => {
  it('keeps Go launches and launches that happened, pad position, telex-safe names', () => {
    const list = parseLaunches(JSON.parse(fixture('launches.json')));
    expect(list).toEqual([
      {
        id: expect.any(String),
        rocket: 'KSLV-2 NURI',
        mission: 'NEONSAT-2 TO 6',
        pad: 'LC-2, NARO SPACE CENTER, KOR',
        lat: 34.431867,
        lon: 127.535069,
        net: Date.UTC(2026, 9, 7, 3, 25),
        windowStart: expect.any(Number),
        windowEnd: expect.any(Number),
        status: 'success',
      },
      {
        id: 'a1bb0984-19d4-4b47-9bba-706d225573e2',
        rocket: 'LONG MARCH 12',
        // "Unknown Payload" says nothing: no mission line.
        mission: null,
        pad: 'COMMERCIAL LC-2, WENCHANG SPACE LAUNCH SITE, CHN',
        lat: 19.59755,
        lon: 110.936481,
        net: Date.UTC(2026, 9, 9, 19, 25),
        windowStart: Date.UTC(2026, 9, 9, 19, 20),
        windowEnd: Date.UTC(2026, 9, 9, 19, 49),
        status: 'go',
      },
      {
        id: expect.any(String),
        rocket: 'FALCON 9 BLOCK 5',
        mission: 'SDA TRANCHE 1 TRANSPORT LAYER A',
        pad: 'SPACE LAUNCH COMPLEX 4E, VANDENBERG SFB, USA',
        lat: 34.632,
        lon: -120.611,
        net: Date.UTC(2026, 9, 10, 7, 29),
        windowStart: Date.UTC(2026, 9, 10, 7, 29),
        windowEnd: Date.UTC(2026, 9, 10, 7, 29),
        status: 'go',
      },
    ]);
  });

  it('drops TBD/TBC/Hold, Go with a vague time, and launches without a pad', () => {
    const base = JSON.parse(fixture('launches.json')).results[1];
    const variant = (patch: Record<string, unknown>) => ({ ...base, ...patch });
    const list = parseLaunches({
      results: [
        variant({ id: 'tbd', status: { id: 2 } }),
        variant({ id: 'tbc', status: { id: 8 } }),
        variant({ id: 'hold', status: { id: 5 } }),
        variant({ id: 'day', net_precision: { id: 5 } }),
        variant({ id: 'nopad', pad: null }),
        variant({ id: 'fail', status: { id: 4 }, net_precision: { id: 7 } }),
        variant({ id: 'partial', status: { id: 7 } }),
        variant({ id: 'flying', status: { id: 6 } }),
        variant({ id: 'deployed', status: { id: 9 } }),
      ],
    });
    // A launch that happened keeps its status whatever the precision.
    expect(list.map((l) => [l.id, l.status])).toEqual([
      ['deployed', 'deployed'],
      ['fail', 'failure'],
      ['flying', 'in_flight'],
      ['partial', 'partial_failure'],
    ]);
    expect(() => parseLaunches({ detail: 'Request was throttled.' })).toThrow(DataSourceError);
  });
});

describe('Overpass stands', () => {
  it('parses refs of gates and parking positions, dedups, drops the rest', () => {
    expect(parseOverpassStands(JSON.parse(fixture('overpass-stands.json')))).toEqual([
      { ref: '11', kind: 'stand' },
      { ref: '2', kind: 'stand' },
      { ref: '12', kind: 'stand' },
      { ref: '13', kind: 'stand' },
      { ref: '41', kind: 'stand' },
      { ref: '5', kind: 'gate' },
    ]);
    expect(standRefs('A12; a13 ,Gate B5')).toEqual(['A12', 'A13', 'B5']);
    expect(standsQuery(34.4347, 135.244)).toBe(
      '[out:json][timeout:25];nw["aeroway"~"^(gate|parking_position)$"](around:4000,34.43470,135.24400);out tags;',
    );
  });
});

describe('telexText', () => {
  it('folds accents, upper-cases, keeps safe characters, cuts at a word', () => {
    expect(telexText('Volcán Popocatépetl, México [orange]')).toBe(
      'VOLCAN POPOCATEPETL, MEXICO ORANGE',
    );
    expect(telexText('Prescribed Fire D3 Bear RX, Greenlee, Arizona', 25)).toBe(
      'PRESCRIBED FIRE D3 BEAR',
    );
  });
});

describe('ExternalDataService', () => {
  const T0 = Date.UTC(2026, 9, 8, 8, 0);

  async function step(
    svc: ExternalDataService,
    now: number,
    phase: Parameters<ExternalDataService['tick']>[1],
  ) {
    svc.tick(now, phase);
    await svc.settle();
    return svc.take(now);
  }

  it('fetches everything at start, as one core update', async () => {
    const { http, calls } = fakeHttp(live);
    const svc = new ExternalDataService({ http, userAgent: 'acars-sim test' });
    svc.startFlight(ofp, T0);
    const { update, notes } = await step(svc, T0, 'PREFLIGHT');
    expect(notes).toEqual([]);
    expect(update?.t).toBe(T0);
    expect(Object.keys(update?.wx ?? {}).sort()).toEqual(['RCTP', 'RJBB', 'RJGG']);
    expect(update?.wx?.['RJBB']?.metar).toMatch(/^RJBB /);
    expect(update?.atc?.['RJBB']?.map((s) => s.callsign).sort()).toEqual(['KIX_APP', 'RJBB_TWR']);
    expect(update?.events?.length).toBeGreaterThan(0);
    expect(update?.stands).toEqual({ icao: 'RJBB', list: expect.any(Array) });
    expect(update?.launches?.map((l) => l.rocket)).toEqual([
      'KSLV-2 NURI',
      'LONG MARCH 12',
      'FALCON 9 BLOCK 5',
    ]);
    // One query: from an hour before the start to an hour after now + the OFP block time.
    const block = ofp.times.schedBlockSec ?? ofp.times.estTimeEnrouteSec;
    const iso = (t: number) => new Date(t).toISOString().replace('.000Z', 'Z');
    expect(calls.filter((c) => c.url.includes('thespacedevs')).map((c) => c.url)).toEqual([
      'https://ll.thespacedevs.com/2.3.0/launches/?mode=normal&ordering=net&limit=100' +
        `&net__gte=${iso(T0 - 60 * MIN)}&net__lte=${iso(T0 + block * 1000 + 60 * MIN)}`,
    ]);
    // EONET is two queries (recent events, volcanoes of the year); Overpass a POST.
    expect(calls.filter((c) => c.url.includes('eonet')).map((c) => c.url)).toEqual([
      'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=30&category=severeStorms,wildfires,earthquakes,manmade',
      'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=365&category=volcanoes',
    ]);
    const post = calls.find((c) => c.url.includes('overpass'));
    expect(post?.method).toBe('POST');
    expect(decodeURIComponent(post?.body?.slice(5) ?? '')).toContain('around:4000,34.43');
    // Nothing new on the next second.
    expect((await step(svc, T0 + 1000, 'PREFLIGHT')).update).toBeNull();
  });

  it('refreshes on its schedule; VATSIM only from the climb; stands once', async () => {
    const { http, calls } = fakeHttp(live);
    const svc = new ExternalDataService({ http, userAgent: 't', cache: noCache() });
    svc.startFlight(ofp, T0);
    await step(svc, T0, 'BOARDING');
    const count = (part: string) => calls.filter((c) => c.url.includes(part)).length;
    await step(svc, T0 + 6 * MIN, 'BOARDING');
    expect([count('metar'), count('vatsim'), count('eonet'), count('overpass')]).toEqual([
      1, 1, 2, 1,
    ]);
    await step(svc, T0 + 11 * MIN, 'CLIMB');
    expect([count('metar'), count('vatsim')]).toEqual([2, 2]);
    await step(svc, T0 + 61 * MIN, 'CRUISE');
    expect([count('metar'), count('vatsim'), count('eonet'), count('overpass')]).toEqual([
      3, 3, 4, 1,
    ]);
    // Launch Library: 15 requests an hour without a key — once an hour.
    expect(count('thespacedevs')).toBe(2);
    await step(svc, T0 + 100 * MIN, 'CRUISE');
    expect(count('thespacedevs')).toBe(2);
  });

  it('uses the cache: a second flight to the same airports asks nothing fresh', async () => {
    const { http, calls } = fakeHttp(live);
    const cache = new MemoryCache();
    const a = new ExternalDataService({ http, userAgent: 't', cache });
    a.startFlight(ofp, T0);
    await step(a, T0, 'PREFLIGHT');
    const n = calls.length;
    const b = new ExternalDataService({ http, userAgent: 't', cache });
    b.startFlight(ofp, T0 + 30_000);
    const { update } = await step(b, T0 + 30_000, 'PREFLIGHT');
    expect(calls.length).toBe(n);
    expect(update?.stands?.list.length).toBeGreaterThan(0);
    // A broken cache entry is a miss, not a crash.
    await cache.set('wx:RJBB', { t: T0 + 60_000, value: { metar: 42 } });
    const c = new ExternalDataService({ http, userAgent: 't', cache });
    c.startFlight(ofp, T0 + 60_000);
    await step(c, T0 + 60_000, 'PREFLIGHT');
    expect(calls.filter((x) => x.url.includes('metar')).at(-1)?.url).toContain('ids=RJBB');
  });

  it('degrades: a failing source gives one note, backs off, recovers with one note', async () => {
    let down = true;
    const { http, calls } = fakeHttp((url, body) =>
      down && url.includes('overpass') ? { status: 504, body: '<html>' } : live(url, body),
    );
    const svc = new ExternalDataService({ http, userAgent: 't', cache: noCache() });
    svc.startFlight(ofp, T0);
    const first = await step(svc, T0, 'PREFLIGHT');
    expect(first.update?.wx).toBeDefined();
    expect(first.update?.stands).toBeUndefined();
    expect(first.notes).toEqual([
      { t: T0, source: 'stands', ok: false, error: 'Overpass: HTTP 504' },
    ]);
    expect((await step(svc, T0 + 5 * MIN, 'PREFLIGHT')).notes).toEqual([]);
    expect(calls.filter((c) => c.url.includes('overpass')).length).toBe(1);
    down = false;
    const again = await step(svc, T0 + 10 * MIN, 'PREFLIGHT');
    expect(again.notes).toEqual([{ t: T0 + 10 * MIN, source: 'stands', ok: true, error: null }]);
    expect(again.update?.stands?.icao).toBe('RJBB');
  });

  it('Launch Library rate limit (429): one note, no launches, retry after 15 min', async () => {
    let limited = true;
    const { http, calls } = fakeHttp((url, body) =>
      limited && url.includes('thespacedevs')
        ? { status: 429, body: '{"detail":"Request was throttled."}' }
        : live(url, body),
    );
    const svc = new ExternalDataService({ http, userAgent: 't', cache: noCache() });
    svc.startFlight(ofp, T0);
    const first = await step(svc, T0, 'PREFLIGHT');
    expect(first.update?.launches).toBeUndefined();
    expect(first.notes).toEqual([
      { t: T0, source: 'launches', ok: false, error: 'Launch Library: rate limited (429)' },
    ]);
    await step(svc, T0 + 10 * MIN, 'PREFLIGHT');
    expect(calls.filter((c) => c.url.includes('thespacedevs')).length).toBe(1);
    limited = false;
    const again = await step(svc, T0 + 15 * MIN, 'PREFLIGHT');
    expect(again.update?.launches?.length).toBe(3);
  });

  it('gives up on stands after 3 failures', async () => {
    const { http, calls } = fakeHttp((url, body) =>
      url.includes('overpass') ? { status: 504, body: '' } : live(url, body),
    );
    const svc = new ExternalDataService({ http, userAgent: 't', cache: noCache() });
    svc.startFlight(ofp, T0);
    for (let m = 0; m <= 60; m += 10) await step(svc, T0 + m * MIN, 'CRUISE');
    expect(calls.filter((c) => c.url.includes('overpass')).length).toBe(3);
  });

  it('fetches a pilot-requested airport at once, also while a refresh is not due', async () => {
    const { http, calls } = fakeHttp(live);
    const svc = new ExternalDataService({ http, userAgent: 't', cache: noCache() });
    svc.startFlight(ofp, T0);
    await step(svc, T0, 'CRUISE');
    svc.requestWx('EDDF');
    const { update } = await step(svc, T0 + 1000, 'CRUISE');
    expect(calls.filter((c) => c.url.includes('metar')).at(-1)?.url).toContain('EDDF');
    expect(update?.wx?.['EDDF']?.metar).toMatch(/^EDDF /);
  });

  it('without a weather source a pilot request is answered "no data" at once', async () => {
    const { http } = fakeHttp(live);
    const svc = new ExternalDataService({ http, userAgent: 't', sources: ['eonet'] });
    svc.startFlight(ofp, T0);
    svc.requestWx('EDDF');
    expect(svc.take(T0).update?.wx).toEqual({ EDDF: null });
  });

  it('drops answers of a flight that was stopped', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const http: HttpClient = {
      request: async (req) => {
        await gate;
        return live(req.url, req.body) as { status: number; body: string };
      },
    };
    const svc = new ExternalDataService({ http, userAgent: 't', cache: noCache() });
    svc.startFlight(ofp, T0);
    svc.tick(T0, 'PREFLIGHT');
    svc.stopFlight();
    release();
    await svc.settle();
    expect(svc.take(T0).update).toBeNull();
  });
});

function noCache(): DataCache {
  return { get: async () => null, set: async () => {} };
}
