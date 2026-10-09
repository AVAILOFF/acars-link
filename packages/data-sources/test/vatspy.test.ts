import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FirMap, type Ofp, parseSimbriefOfp } from '@acars/core';
import { describe, expect, it } from 'vitest';
import {
  buildVatspy,
  centersFor,
  DataSourceError,
  ExternalDataService,
  type HttpClient,
  parseVatsimCenters,
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
