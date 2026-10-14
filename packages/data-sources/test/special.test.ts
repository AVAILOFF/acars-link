import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSimbriefOfp } from '@acars/core';
import { describe, expect, it } from 'vitest';
import {
  DataSourceError,
  ExternalDataService,
  type HttpClient,
  parseAirportCountries,
  parseAshSigmets,
  parseF1,
  parseHolidays,
  parseNhl,
  parseNoaaScales,
  parseOvation,
  parseQuakes,
} from '../src/index.js';

/** T29: parsers of the special-event sources on trimmed real answers; the service per group. */

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const json = (name: string) => JSON.parse(fixture(name)) as unknown;
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

describe('NOAA SWPC', () => {
  it('scales: current R/S/G and the G forecast of today and tomorrow', () => {
    expect(parseNoaaScales(json('noaa-scales.json'))).toEqual({
      issued: Date.parse('2026-10-09T13:52:00Z'),
      current: { r: 0, s: 0, g: 0 },
      gForecast: [
        { date: '2026-10-09', g: 2 },
        { date: '2026-10-10', g: 0 },
      ],
    });
    expect(() => parseNoaaScales({})).toThrow(DataSourceError);
  });

  it('OVATION: one cell per route point, probability > 0, longitudes −180..180', () => {
    const route = [
      { lat: 64.2, lon: -21.9 }, // outside the trimmed fixture (lon 0..30): nothing
      { lat: 65.1, lon: 10.2 },
      { lat: 65.4, lon: 10.4 }, // same cell
      { lat: 69.6, lon: 18.9 },
    ];
    const a = parseOvation(json('ovation-aurora.json'), route);
    expect(a.forecastTime).toBe(Date.parse('2026-10-09T14:54:00Z'));
    expect(a.cells.every((c) => c.prob > 0 && c.lon >= -180 && c.lon <= 180)).toBe(true);
    expect(new Set(a.cells.map((c) => `${c.lat}/${c.lon}`)).size).toBe(a.cells.length);
    expect(
      a.cells.every((c) => (c.lat === 65 && c.lon === 10) || (c.lat === 70 && c.lon === 19)),
    ).toBe(true);
  });
});

describe('SIGMET VA', () => {
  it('volcano, levels, validity, polygons; forecast positions as their own entries', () => {
    const list = parseAshSigmets(json('isigmet-va.json'));
    expect(list.map((s) => s.id)).toEqual(['MHTG A3', 'MHTG A3F', 'WAAF 06', 'WAAF 09']);
    const fuego = list[0];
    expect(fuego).toMatchObject({
      fir: 'MHTG',
      volcano: 'FUEGO',
      baseFt: 0,
      topFt: 14000,
      validFrom: Date.parse('2026-10-09T13:03:00Z'),
      validTo: Date.parse('2026-10-09T19:03:00Z'),
    });
    expect(fuego?.areas[0]?.length).toBe(5);
    expect(list[2]?.volcano).toBe('MT DUKONO');
  });

  it('AREAS (several rings) and non-VA entries', () => {
    const ring = [
      { lat: 1, lon: 1 },
      { lat: 1, lon: 2 },
      { lat: 2, lon: 2 },
      { lat: 1, lon: 1 },
    ];
    const list = parseAshSigmets([
      { hazard: 'TS', firId: 'XXXX', validTimeFrom: 1, validTimeTo: 2, coords: ring },
      {
        hazard: 'VA',
        firId: 'UHPP',
        seriesId: '3',
        qualifier: 'ERUPTION MT KLYUCHEVSKOY',
        base: null,
        top: 25000,
        validTimeFrom: 1,
        validTimeTo: 2,
        geom: 'AREAS',
        coords: [ring, ring],
      },
    ]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'UHPP 3', baseFt: null, topFt: 25000, validTo: 2000 });
    expect(list[0]?.areas).toHaveLength(2);
  });
});

describe('USGS', () => {
  it('earthquakes with magnitude, place, time, position, depth', () => {
    const list = parseQuakes(json('usgs-4.5-day.geojson'));
    expect(list).toHaveLength(13);
    const nic = list.find((q) => q.id === 'us6000u15l');
    expect(nic).toEqual({
      id: 'us6000u15l',
      mag: 4.8,
      place: '17 KM S OF NANDAIME, NICARAGUA',
      time: 1791549223985,
      lat: 11.5951,
      lon: -86.0613,
      depthKm: 165.662,
    });
  });
});

describe('Nager.Date and OurAirports countries', () => {
  it('nationwide holidays only, telex-safe names', () => {
    const list = parseHolidays(json('nager-2026-de.json'));
    expect(list.map((h) => h.date)).toEqual([
      '2026-01-01',
      '2026-04-03',
      '2026-04-06',
      '2026-05-01',
      '2026-05-14',
      '2026-05-25',
      '2026-10-03',
      '2026-12-25',
      '2026-12-26',
    ]);
    expect(list.find((h) => h.date === '2026-10-03')).toEqual({
      date: '2026-10-03',
      name: 'GERMAN UNITY DAY',
      localName: 'TAG DER DEUTSCHEN EINHEIT',
    });
  });

  it('airport → country: icao_code, else a 4-letter ident or GPS code (K00A is no ICAO code)', () => {
    expect(parseAirportCountries(fixture('ourairports-airports.csv'))).toEqual({
      EDDF: 'DE',
      EGLL: 'GB',
      KJFK: 'US',
      RJBB: 'JP',
    });
  });
});

describe('sport', () => {
  it('F1: the podium and the finish = start + winner time', () => {
    const r = parseF1(json('jolpica-f1-last.json'));
    expect(r).toMatchObject({
      season: '2026',
      round: '16',
      name: 'BAHRAIN GRAND PRIX IN MALAYSIA',
    });
    expect(r?.start).toBe(Date.parse('2026-10-04T07:00:00Z'));
    expect(r?.finish).toBe(Date.parse('2026-10-04T07:00:00Z') + 6434808);
    expect(r?.podium).toEqual([
      { pos: 1, code: 'VER', team: 'RED BULL' },
      { pos: 2, code: 'ANT', team: 'MERCEDES' },
      { pos: 3, code: 'HAM', team: 'FERRARI' },
    ]);
    // No race yet in the season.
    expect(parseF1({ MRData: { RaceTable: { season: '2027', Races: [] } } })).toBeNull();
  });

  it('NHL: regular season and playoffs, state, score, OT/SO', () => {
    const games = parseNhl(json('nhl-score.json'));
    expect(
      games.map(
        (g) => `${g.away} ${g.awayScore} ${g.home} ${g.homeScore} ${g.state} ${g.lastPeriod}`,
      ),
    ).toEqual(['CHI 1 NYI 4 OFF REG', 'SJS 3 STL 2 OFF OT', 'COL 7 CGY 3 OFF REG']);
    const pre = parseNhl({
      games: [
        {
          id: 1,
          gameType: 1,
          gameState: 'FUT',
          startTimeUTC: '2026-10-09T23:00:00Z',
          awayTeam: { abbrev: 'A' },
          homeTeam: { abbrev: 'B' },
        },
      ],
    });
    expect(pre).toEqual([]);
  });
});

describe('airportCountry (T38)', () => {
  const svc = (body: string | null) =>
    new ExternalDataService({
      userAgent: 't',
      http: {
        async request() {
          if (body === null) throw new Error('offline');
          return { status: 200, body };
        },
      },
    });

  it('real airports → ISO country (OurAirports rows of 2026-10-14)', async () => {
    const s = svc(fixture('ourairports-drone-airports.csv'));
    const now = Date.parse('2026-10-14T12:00:00Z');
    const got: Record<string, string | null> = {};
    for (const i of ['UUEE', 'EDDM', 'EKCH', 'OMDB', 'KJFK', 'RJBB', 'ZZZZ']) {
      got[i] = await s.airportCountry(i, now);
    }
    expect(got).toEqual({
      UUEE: 'RU',
      EDDM: 'DE',
      EKCH: 'DK',
      OMDB: 'AE',
      KJFK: 'US',
      RJBB: 'JP',
      ZZZZ: null,
    });
  });

  it('no network → null, no throw', async () => {
    expect(await svc(null).airportCountry('UUEE', 0)).toBeNull();
    expect(await svc('not,a,csv').airportCountry('UUEE', 0)).toBeNull();
  });
});

describe('ExternalDataService: special-event groups (T29)', () => {
  const T0 = Date.parse('2026-10-09T12:00:00Z');
  const fake = (asked: string[]): HttpClient => ({
    async request(req) {
      asked.push(req.url);
      const u = req.url;
      if (u.includes('noaa-scales')) return { status: 200, body: fixture('noaa-scales.json') };
      if (u.includes('ovation')) return { status: 200, body: fixture('ovation-aurora.json') };
      if (u.includes('isigmet')) return { status: 200, body: fixture('isigmet-va.json') };
      if (u.includes('earthquake.usgs'))
        return { status: 200, body: fixture('usgs-4.5-day.geojson') };
      if (u.includes('airports.csv'))
        return { status: 200, body: fixture('ourairports-airports.csv') };
      if (u.includes('date.nager.at')) return { status: 204, body: '' };
      if (u.includes('jolpi.ca')) return { status: 200, body: fixture('jolpica-f1-last.json') };
      if (u.includes('nhle.com')) return { status: 200, body: fixture('nhl-score.json') };
      return { status: 500, body: '' };
    },
  });

  it('no group: none of the T29 sources is asked', async () => {
    const asked: string[] = [];
    const svc = new ExternalDataService({
      http: fake(asked),
      userAgent: 't',
      sources: ['spacewx', 'f1'],
    });
    svc.startFlight(ofp, T0);
    svc.tick(T0, null);
    await svc.settle();
    expect(asked).toEqual([]);
  });

  it('each group asks its sources; NHL by the dates of 12 h ago and now', async () => {
    const asked: string[] = [];
    const svc = new ExternalDataService({
      http: fake(asked),
      userAgent: 't',
      sources: ['spacewx', 'aurora', 'ash', 'quakes', 'holidays', 'f1', 'nhl'],
    });
    svc.startFlight(ofp, T0, { special: ['aviation', 'other', 'sport'] });
    svc.tick(T0, null);
    await svc.settle();
    const { update, notes } = svc.take(T0);
    expect(notes).toEqual([]);
    expect(update?.spaceWx?.gForecast[0]?.g).toBe(2);
    expect(update?.aurora?.cells).toEqual([]); // RCTP–RJBB: no aurora cell on the route
    expect(update?.ash?.length).toBe(4);
    expect(update?.quakes?.length).toBe(13);
    expect(update?.holidays).toEqual({ country: 'JP', list: [] }); // Nager 204
    expect(update?.f1?.round).toBe('16');
    expect(update?.nhl?.length).toBe(3);
    expect(asked.filter((u) => u.includes('nhle.com'))).toEqual([
      'https://api-web.nhle.com/v1/score/2026-10-09',
    ]);
    expect(asked.filter((u) => u.includes('isigmet'))).toEqual([
      'https://aviationweather.gov/api/data/isigmet?format=json&hazard=va',
    ]);
    // Holidays once; ash again after 15 min, NOAA after 30.
    asked.length = 0;
    svc.tick(T0 + 16 * 60_000, 'CRUISE');
    await svc.settle();
    expect(asked.map((u) => new URL(u).hostname).sort()).toEqual([
      'api-web.nhle.com',
      'aviationweather.gov',
    ]);
    asked.length = 0;
    svc.tick(T0 + 31 * 60_000, 'CRUISE');
    await svc.settle();
    expect(asked.some((u) => u.includes('nager') || u.includes('airports.csv'))).toBe(false);
    expect(asked.some((u) => u.includes('noaa-scales'))).toBe(true);
  });

  it('NHL in the early UTC hours asks yesterday and today', async () => {
    const asked: string[] = [];
    const svc = new ExternalDataService({ http: fake(asked), userAgent: 't', sources: ['nhl'] });
    const t = Date.parse('2026-10-09T03:00:00Z');
    svc.startFlight(ofp, t, { special: ['sport'] });
    svc.tick(t, null);
    await svc.settle();
    expect(asked).toEqual([
      'https://api-web.nhle.com/v1/score/2026-10-08',
      'https://api-web.nhle.com/v1/score/2026-10-09',
    ]);
  });
});
