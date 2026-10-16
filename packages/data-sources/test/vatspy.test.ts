import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FirMap, type Ofp, parseSimbriefOfp } from '@acars/core';
import { describe, expect, it } from 'vitest';
import {
  airportInfo,
  buildVatspy,
  centersFor,
  DataSourceError,
  ExternalDataService,
  type HttpClient,
  NATTRAK_TRACKS_URL,
  OURAIRPORTS_AIRPORTS_URL,
  OURAIRPORTS_FREQS_URL,
  OURAIRPORTS_RUNWAYS_URL,
  parseAirportFrequencies,
  parseNatTracks,
  parseRunwayPoint,
  parseVatsimCenters,
  parseVhfStations,
  routeFirs,
  VATSPY_BOUNDARIES_URL,
  VATSPY_DAT_URL,
} from '../src/index.js';

/** T23: VATSpy FIR boundaries (trimmed real release v2610.1) and VATSIM centres. */

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const data = buildVatspy(JSON.parse(fixture('vatspy-boundaries.json')), fixture('vatspy.dat'));

const baseOfp = parseSimbriefOfp(
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
/** EDDF → EDDM, direct (coordinates of the aerodrome reference points). */
const eddfEddm: Ofp = {
  ...baseOfp,
  origin: { ...baseOfp.origin, icao: 'EDDF', lat: 50.0333, lon: 8.5706 },
  destination: { ...baseOfp.destination, icao: 'EDDM', lat: 48.3538, lon: 11.7861 },
  navlog: [],
};

describe('VATSpy data', () => {
  it('keeps the 4-letter FIRs with their names, drops sectors (EDGG-N), marks airport FIRs', () => {
    expect(data.firs.map((f) => [f.id, f.name, f.oceanic, f.airports])).toEqual([
      ['EDGG', 'Langen', false, true],
      ['EDMM', 'Muenchen', false, true],
      ['EDXX', 'Langen Information - FIS only', false, false],
      ['EGTL', 'London TMA (Up to FL195) - London', false, false],
      ['EGTT', 'London', false, true],
    ]);
    expect(data.airports).toEqual({ EDDF: 'EDGG', EDDM: 'EDMM', EGKK: 'EGTT', EGLL: 'EGTT' });
  });

  it('locates real airports in their FIRs; overlays (EDXX FIS only) and EGTL lose', () => {
    const map = new FirMap(data.firs);
    // EDXX covers Frankfurt and is larger than EDGG, but no airport has it as its FIR.
    expect(map.locate({ lat: 50.0333, lon: 8.5706 })?.id).toBe('EDGG'); // EDDF
    expect(map.locate({ lat: 48.3538, lon: 11.7861 })?.id).toBe('EDMM'); // EDDM
    expect(map.locate({ lat: 51.4706, lon: -0.4619 })?.id).toBe('EGTT'); // EGLL, inside EGTL too
    expect(map.locate({ lat: 40, lon: 0 })).toBeNull();
  });

  it('maps callsign prefixes to FIRs: own prefix, sectors, UIRs (sector members → their FIR)', () => {
    expect(data.prefixes['EDGG']).toEqual(['EDGG']);
    expect(data.prefixes['EDGG_N']).toEqual(['EDGG']);
    expect(data.prefixes['LON']).toEqual(['EGTT']);
    expect(data.prefixes['LTC']).toEqual(['EGTL']);
    expect(data.prefixes['EUC_ME']).toEqual(['EDWW', 'EDMM', 'EDGG', 'LOVV']);
  });

  it('route FIRs in order (legs sampled every ≤ 10 NM)', () => {
    expect(routeFirs(data, eddfEddm).map((f) => f.id)).toEqual(['EDGG', 'EDMM']);
  });

  it('rejects a file without FIRs', () => {
    expect(() => buildVatspy({ features: [] }, '')).toThrow(DataSourceError);
    expect(() => buildVatspy({}, '')).toThrow(DataSourceError);
  });
});

describe('VATSIM centres', () => {
  it('reads CTR and FSS from the feed (trimmed real feed)', () => {
    expect(parseVatsimCenters(JSON.parse(fixture('vatsim-data.json')))).toEqual([
      { callsign: 'ENBD_E_CTR', frequency: '126.705' },
    ]);
  });

  it('finds the FIRs a centre covers by the longest VATSpy prefix', () => {
    const centers = [
      { callsign: 'EDGG_N_CTR', frequency: '127.725' },
      { callsign: 'LON_S_CTR', frequency: '129.425' },
      { callsign: 'EUC_ME_CTR', frequency: '134.700' },
      { callsign: 'EDMM_ALB_CTR', frequency: '132.555' },
      { callsign: 'ENBD_E_CTR', frequency: '126.705' },
    ];
    expect(centersFor(centers, data, new Set(['EDGG', 'EDMM']))).toEqual([
      { callsign: 'EDGG_N_CTR', frequency: '127.725', firs: ['EDGG'] },
      { callsign: 'EDMM_ALB_CTR', frequency: '132.555', firs: ['EDMM'] },
      { callsign: 'EUC_ME_CTR', frequency: '134.700', firs: ['EDMM', 'EDGG'] },
    ]);
    expect(centersFor(centers, data, new Set(['EGTT']))).toEqual([
      { callsign: 'LON_S_CTR', frequency: '129.425', firs: ['EGTT'] },
    ]);
  });
});

describe('ExternalDataService with the ROPS station', () => {
  const T0 = Date.UTC(2026, 9, 9, 8, 0);
  const feed = JSON.stringify({
    controllers: [
      { callsign: 'EDGG_N_CTR', frequency: '127.725', facility: 6 },
      { callsign: 'LON_S_CTR', frequency: '129.425', facility: 6 },
    ],
    atis: [],
  });
  const calls: string[] = [];
  const http: HttpClient = {
    async request(req) {
      calls.push(req.url);
      if (req.url === VATSPY_BOUNDARIES_URL) {
        return { status: 200, body: fixture('vatspy-boundaries.json') };
      }
      if (req.url === VATSPY_DAT_URL) return { status: 200, body: fixture('vatspy.dat') };
      if (req.url.includes('vatsim-data.json')) return { status: 200, body: feed };
      return { status: 404, body: '' };
    },
  };

  it('passes the route FIRs once and the centres covering them', async () => {
    const svc = new ExternalDataService({ http, userAgent: 't', sources: ['vatsim', 'firs'] });
    svc.startFlight(eddfEddm, T0, { firs: true });
    svc.tick(T0, 'PREFLIGHT');
    await svc.settle();
    const { update, notes } = svc.take(T0);
    expect(notes).toEqual([]);
    expect(update?.firs?.map((f) => f.id)).toEqual(['EDGG', 'EDMM']);
    expect(update?.centers).toEqual([
      { callsign: 'EDGG_N_CTR', frequency: '127.725', firs: ['EDGG'] },
    ]);
    // Boundaries once; the next VATSIM fetch maps its centres again.
    svc.tick(T0 + 6 * 60_000, 'CRUISE');
    await svc.settle();
    const next = svc.take(T0 + 6 * 60_000).update;
    expect(next?.firs).toBeUndefined();
    expect(next?.centers?.map((c) => c.callsign)).toEqual(['EDGG_N_CTR']);
    expect(calls.filter((u) => u.includes('vatspy'))).toHaveLength(2);
  });

  it('fetches nothing of VATSpy without the station', async () => {
    calls.length = 0;
    const svc = new ExternalDataService({ http, userAgent: 't', sources: ['vatsim', 'firs'] });
    svc.startFlight(eddfEddm, T0);
    svc.tick(T0, 'PREFLIGHT');
    await svc.settle();
    const { update } = svc.take(T0);
    expect(update?.firs).toBeUndefined();
    expect(update?.centers).toBeUndefined();
    expect(calls.some((u) => u.includes('vatspy'))).toBe(false);
  });
});

describe('T24: airport facts and frequencies', () => {
  it('airport FIR and country from VATSpy [Airports] / [Countries]', () => {
    expect(airportInfo(data, 'EDDF')).toEqual({ fir: 'EDGG', country: 'Germany' });
    expect(airportInfo(data, 'EGLL')).toEqual({ fir: 'EGTT', country: 'United Kingdom' });
    expect(airportInfo(data, 'LFPG')).toEqual({ fir: null, country: null });
  });

  it('OurAirports frequencies of one airport (trimmed real file, air band only)', () => {
    const csv = fixture('ourairports-frequencies.csv');
    expect(parseAirportFrequencies(csv, 'KMSP')).toEqual([
      { type: 'APP', mhz: '118.72' },
      { type: 'ATIS', mhz: '120.8' },
      { type: 'CLD', mhz: '133.2' },
      { type: 'DEP', mhz: '132.975' },
      { type: 'GND', mhz: '121.8' },
      { type: 'RDO', mhz: '122.3' },
      { type: 'TWR', mhz: '123.675' },
      { type: 'UNIC', mhz: '122.95' },
    ]);
    expect(parseAirportFrequencies(csv, 'EFHK').filter((f) => f.type === 'GND')).toEqual([
      { type: 'GND', mhz: '121.8' },
    ]);
    expect(parseAirportFrequencies(csv, 'ZZZZ')).toEqual([]);
    expect(() => parseAirportFrequencies('a,b\n1,2', 'KMSP')).toThrow(DataSourceError);
  });

  it('the service passes origin/destination facts and the origin frequencies with ROPS', async () => {
    const http: HttpClient = {
      async request(req) {
        if (req.url === VATSPY_BOUNDARIES_URL) {
          return { status: 200, body: fixture('vatspy-boundaries.json') };
        }
        if (req.url === VATSPY_DAT_URL) return { status: 200, body: fixture('vatspy.dat') };
        if (req.url === OURAIRPORTS_FREQS_URL) {
          return { status: 200, body: fixture('ourairports-frequencies.csv') };
        }
        return { status: 404, body: '' };
      },
    };
    const svc = new ExternalDataService({ http, userAgent: 't', sources: ['firs', 'freqs'] });
    const T0 = Date.UTC(2026, 9, 9, 8, 0);
    svc.startFlight(eddfEddm, T0, { firs: true });
    svc.tick(T0, 'PREFLIGHT');
    await svc.settle();
    const { update } = svc.take(T0);
    expect(update?.airports).toEqual({
      EDDF: { fir: 'EDGG', country: 'Germany' },
      EDDM: { fir: 'EDMM', country: 'Germany' },
    });
    expect(update?.freqs?.icao).toBe('EDDF');
    expect(update?.freqs?.list.find((f) => f.type === 'GND')).toEqual({
      type: 'GND',
      mhz: '121.805',
    });
  });
});

describe('T27: NAT tracks from natTrak', () => {
  it('parses the active tracks (trimmed real answer of 2026-10-09)', () => {
    const tracks = parseNatTracks(JSON.parse(fixture('nattrak-tracks.json')));
    expect(tracks.map((k) => k.ident)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(tracks[4]).toEqual({
      ident: 'E',
      route: ['SUNOT', '58/20', '60/30', '60/40', '59/50', 'AVUTI'],
      validFrom: Date.UTC(2026, 9, 9, 11, 30),
      validTo: Date.UTC(2026, 9, 9, 19, 0),
      levelsFt: [34000, 35000, 36000, 37000, 38000, 39000, 40000],
    });
  });

  it('drops inactive and Concorde tracks and bad routes; a non-list is an error', () => {
    const base = JSON.parse(fixture('nattrak-tracks.json'))[0];
    const list = parseNatTracks([
      { ...base, identifier: 'X', active: false },
      { ...base, identifier: 'SM', concorde: 1 },
      { ...base, identifier: 'Y', last_routeing: 'RATSU 63/20 ???' },
      { ...base, identifier: 'Z' },
    ]);
    expect(list.map((k) => k.ident)).toEqual(['Z']);
    expect(() => parseNatTracks({ message: 'Server Error' })).toThrow(DataSourceError);
  });

  it('the service fetches them with the ROPS station only, hourly', async () => {
    const calls: string[] = [];
    const http: HttpClient = {
      async request(req) {
        calls.push(req.url);
        if (req.url === NATTRAK_TRACKS_URL) {
          return { status: 200, body: fixture('nattrak-tracks.json') };
        }
        return { status: 404, body: '' };
      },
    };
    const T0 = Date.UTC(2026, 9, 9, 12, 0);
    const svc = new ExternalDataService({ http, userAgent: 't', sources: ['nattracks'] });
    svc.startFlight(eddfEddm, T0);
    svc.tick(T0, 'PREFLIGHT');
    await svc.settle();
    expect(svc.take(T0).update).toBeNull();
    expect(calls).toEqual([]);

    const rops = new ExternalDataService({ http, userAgent: 't', sources: ['nattracks'] });
    rops.startFlight(eddfEddm, T0, { firs: true });
    const step = async (t: number) => {
      rops.tick(t, 'CRUISE');
      await rops.settle();
      return rops.take(t).update;
    };
    expect((await step(T0))?.natTracks?.length).toBe(5);
    expect(await step(T0 + 30 * 60_000)).toBeNull();
    expect((await step(T0 + 61 * 60_000))?.natTracks?.length).toBe(5);
    expect(calls).toEqual([NATTRAK_TRACKS_URL, NATTRAK_TRACKS_URL]);
  });
});

describe('T34: runway coordinates from OurAirports', () => {
  const csv = fixture('ourairports-runways.csv');

  it('the middle of a runway, either end by name (trimmed real file)', () => {
    // RJBB 06L (34.42850, 135.20616) .. 24R (34.45133, 135.24001)
    const p = parseRunwayPoint(csv, 'RJBB', '24R');
    expect(p?.lat).toBeCloseTo(34.43992, 4);
    expect(p?.lon).toBeCloseTo(135.22308, 4);
    expect(p?.headingDeg).toBeCloseTo(230.6, 0); // 24R flies from its threshold south-west
    const back = parseRunwayPoint(csv, 'RJBB', '06L');
    expect(back?.lat).toBe(p?.lat);
    expect(back?.lon).toBe(p?.lon);
    expect(parseRunwayPoint(csv, 'RJBB', '24r')).toEqual(p);
  });

  it('null for an unknown runway or airport, never another runway', () => {
    expect(parseRunwayPoint(csv, 'RJBB', '09')).toBeNull();
    expect(parseRunwayPoint(csv, 'ZZZZ', '24R')).toBeNull();
    expect(() => parseRunwayPoint('a,b\n1,2', 'RJBB', '24R')).toThrow(DataSourceError);
  });

  it('a runway without coordinates gives null', () => {
    const bare =
      '"id","airport_ident","le_ident","le_latitude_deg","le_longitude_deg","he_ident","he_latitude_deg","he_longitude_deg"\n1,"00AK","N",,,"S",,';
    expect(parseRunwayPoint(bare, '00AK', 'N')).toBeNull();
  });

  it('the service fetches the file once and caches the answer', async () => {
    let calls = 0;
    const http: HttpClient = {
      async request(req) {
        if (req.url !== OURAIRPORTS_RUNWAYS_URL) return { status: 404, body: '' };
        calls++;
        return { status: 200, body: csv };
      },
    };
    const svc = new ExternalDataService({ http, userAgent: 't', sources: ['freqs'] });
    const T0 = Date.UTC(2026, 9, 15, 8, 0);
    const a = await svc.runwayPoint('RJBB', '24R', T0);
    expect(a?.lat).toBeCloseTo(34.43992, 4);
    expect(await svc.runwayPoint('RJBB', '24R', T0 + 60_000)).toEqual(a);
    expect(calls).toBe(1);
    expect(await svc.runwayPoint('RJBB', '30', T0)).toBeNull();
  });
});

describe('T31: conditional VHF stations from OurAirports', () => {
  const csv = fixture('ourairports-airports.csv');

  it('large and medium airports with scheduled service, four-letter ident (trimmed real file)', () => {
    const list = parseVhfStations(csv);
    expect(list.map((s) => s.icao)).toEqual(['EDDF', 'EGLL', 'KJFK', 'RJBB']);
    expect(list[0]).toEqual({ icao: 'EDDF', lat: 50.026706, lon: 8.55835 });
    expect(() => parseVhfStations('a,b\n1,2')).toThrow(DataSourceError);
  });

  it('the service keeps only stations near the route, with the datalink option only', async () => {
    const http: HttpClient = {
      async request(req) {
        return req.url === OURAIRPORTS_AIRPORTS_URL
          ? { status: 200, body: csv }
          : { status: 404, body: '' };
      },
    };
    const T0 = Date.UTC(2026, 9, 15, 8, 0);
    const off = new ExternalDataService({ http, userAgent: 't', sources: ['vhf'] });
    off.startFlight(eddfEddm, T0);
    off.tick(T0, 'PREFLIGHT');
    await off.settle();
    expect(off.take(T0).update).toBeNull();

    const svc = new ExternalDataService({ http, userAgent: 't', sources: ['vhf'] });
    svc.startFlight(eddfEddm, T0, { datalink: true });
    svc.tick(T0, 'PREFLIGHT');
    await svc.settle();
    expect(svc.take(T0).update?.vhf?.map((s) => s.icao)).toEqual(['EDDF']);
  });
});
