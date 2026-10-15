import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSimbriefOfp } from '@acars/core';
import { describe, expect, it } from 'vitest';
import {
  ExternalDataService,
  fetchDivertAirports,
  type HttpClient,
  isHardSurface,
  OURAIRPORTS_AIRPORTS_URL,
  OURAIRPORTS_RUNWAYS_URL,
  parseAirportPlaces,
  parseBestRunways,
  parseDivertCandidates,
} from '../src/index.js';

/**
 * T50: airports to divert to besides the OFP's. The header of `runways.csv` is the real one
 * (checked 2026-10-15); the rows are made up for the test (lengths in feet as in the file).
 */

const airports = readFileSync(
  join(import.meta.dirname, 'fixtures', 'ourairports-airports.csv'),
  'utf8',
);
const HEAD =
  '"id","airport_ref","airport_ident","length_ft","width_ft","surface","lighted","closed","le_ident","le_latitude_deg","le_longitude_deg","le_elevation_ft","le_heading_degT","le_displaced_threshold_ft","he_ident","he_latitude_deg","he_longitude_deg","he_elevation_ft","he_heading_degT","he_displaced_threshold_ft"';
const row = (icao: string, len: string, wid: string, surface: string, closed = 0) =>
  `1,2,"${icao}",${len},${wid},"${surface}",1,${closed},"06","","","","","","24","","","","",""`;
const runways = [
  HEAD,
  row('RJBB', '11975', '197', 'ASP'),
  row('RJBB', '13000', '197', 'ASP', 1), // closed: ignored although longer
  row('RJBB', '14000', '197', 'TURF'), // not hard: ignored
  row('EGLL', '12802', '164', 'ASPH-G'),
  row('EGLL', '12000', '', 'CON'),
  row('EDDF', '13123', '', 'CONC'),
  row('KJFK', '9000', '150', 'ASPH-TURF'), // mixed: not hard
].join('\n');

describe('surfaces', () => {
  it('hard: asphalt, concrete, pavement; not: turf, grass, gravel, dirt, mixed, water', () => {
    for (const s of [
      'ASP',
      'ASPH',
      'ASPH-G',
      'ASPHALT',
      'CON',
      'CONC',
      'CONC-G',
      'CONCRETE',
      'PEM',
    ]) {
      expect(isHardSurface(s), s).toBe(true);
    }
    for (const s of [
      'TURF',
      'TURF-G',
      'GRS',
      'GRASS',
      'GVL',
      'GRVL',
      'DIRT',
      'EARTH',
      'WATER',
      'ASPH-TURF',
      '',
      'UNK',
      'X',
    ]) {
      expect(isHardSurface(s), s).toBe(false);
    }
  });
});

describe('runways', () => {
  it('the longest open hard runway of each airport, in metres; no width stays null', () => {
    const best = parseBestRunways(runways, new Set(['RJBB', 'EGLL', 'EDDF', 'KJFK']));
    expect(best.get('RJBB')).toEqual({ rwyM: 3650, widthM: 60 });
    expect(best.get('EGLL')).toEqual({ rwyM: 3902, widthM: 50 });
    expect(best.get('EDDF')).toEqual({ rwyM: 4000, widthM: null });
    expect(best.has('KJFK')).toBe(false);
    expect(parseBestRunways(runways, new Set(['EGLL'])).size).toBe(1);
  });

  it('an unexpected header is an error', () => {
    expect(() => parseBestRunways('a,b\n1,2', new Set())).toThrow();
  });
});

describe('candidates', () => {
  it('large and medium airports with scheduled service, with their size', () => {
    const list = parseDivertCandidates(airports);
    expect(list.map((a) => a.icao)).toEqual(['EDDF', 'EGLL', 'KJFK', 'RJBB']);
    expect(list.every((a) => typeof a.large === 'boolean')).toBe(true);
  });
});

describe('fetchDivertAirports', () => {
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
  const http: HttpClient = {
    async request(req) {
      if (req.url === OURAIRPORTS_AIRPORTS_URL) return { status: 200, body: airports };
      if (req.url === OURAIRPORTS_RUNWAYS_URL) return { status: 200, body: runways };
      return { status: 404, body: '' };
    },
  };
  const ctx = { http, userAgent: 't' };

  it('near the route, long and wide enough: RJBB only, EGLL and the others are far away', async () => {
    const list = await fetchDivertAirports(ctx, ofp, { lengthM: 3000, widthM: 45 });
    expect(list.map((a) => a.icao)).toEqual(['RJBB']);
    expect(list[0]).toMatchObject({ rwyM: 3650, widthM: 60 });
    // Longer than any runway there: none.
    expect(await fetchDivertAirports(ctx, ofp, { lengthM: 4000, widthM: 45 })).toEqual([]);
    // Wide enough is checked too.
    expect(await fetchDivertAirports(ctx, ofp, { lengthM: 3000, widthM: 61 })).toEqual([]);
  });
});

describe('places the pilot names (T51)', () => {
  const csv = [
    '"id","ident","type","name","latitude_deg","longitude_deg","elevation_ft","continent","iso_country","iso_region","municipality","scheduled_service","icao_code","iata_code","gps_code","local_code"',
    '1,"EGLL","large_airport","A",51.47,-0.46,83,"EU","GB","GB-ENG","L","yes","EGLL","LHR","EGLL",',
    '2,"00A","small_airport","B",40.0,-74.0,11,"NA","US","US-PA","X","no",,,"K00A","00A"',
    '3,"EGLF","heliport","C",51.2,-0.7,0,"EU","GB","GB-ENG","F","no",,,,',
    '4,"AB12","small_airport","D",10.0,20.0,0,"AF","XX","XX-A","M","no",,,"ABCD",',
    '5,"EGKK","medium_airport","E",51.15,-0.19,202,"EU","GB","GB-ENG","G","yes","EGKK","LGW","EGKK",',
  ].join('\n');

  it('airports with a runway by their four-letter code; no heliports, no short codes', () => {
    const m = parseAirportPlaces(csv);
    expect([...m.keys()].sort()).toEqual(['ABCD', 'EGKK', 'EGLL']);
    expect(m.get('EGLL')).toEqual({ lat: 51.47, lon: -0.46 });
    expect(m.has('EGLF')).toBe(false);
  });

  it('the service answers a question once the file is there, null for an unknown code', async () => {
    let calls = 0;
    const http: HttpClient = {
      async request(req) {
        if (req.url !== OURAIRPORTS_AIRPORTS_URL) return { status: 404, body: '' };
        calls++;
        return { status: 200, body: csv };
      },
    };
    const svc = new ExternalDataService({ http, userAgent: 't', sources: [] });
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
    svc.startFlight(ofp, 0);
    svc.requestPlace('EGLL');
    svc.requestPlace('ZZZZ');
    await svc.settle();
    expect(svc.take(1).update?.places).toEqual({ EGLL: { lat: 51.47, lon: -0.46 }, ZZZZ: null });
    // Known by now: answered at once, the file is not fetched again.
    svc.requestPlace('EGKK');
    expect(svc.take(2).update?.places).toEqual({ EGKK: { lat: 51.15, lon: -0.19 } });
    expect(calls).toBe(1);
  });

  it('a file that cannot be fetched is an answer of "unknown", not silence', async () => {
    const http: HttpClient = {
      async request() {
        return { status: 500, body: '' };
      },
    };
    const svc = new ExternalDataService({ http, userAgent: 't', sources: [] });
    svc.startFlight(
      parseSimbriefOfp(
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
      ),
      0,
    );
    svc.requestPlace('EGLL');
    await svc.settle();
    expect(svc.take(1).update?.places).toEqual({ EGLL: null });
  });
});
