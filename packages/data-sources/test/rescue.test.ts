import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DataSourceError,
  ExternalDataService,
  OURAIRPORTS_AIRPORTS_URL,
  OURAIRPORTS_RUNWAYS_URL,
  parseLandingRunway,
  parseLargeAirports,
} from '../src/index.js';

/** T54: the landing runway and the large airports for the rescue vehicles (trimmed real files). */

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const runways = fixture('ourairports-runways.csv');
const airports = fixture('ourairports-airports.csv');

describe('T54: landing runway from OurAirports', () => {
  it('the planned runway: the threshold of its end, the course toward the other end', () => {
    // RJBB 06L (34.42850, 135.20616) .. 24R (34.45133, 135.24001)
    const r = parseLandingRunway(runways, 'RJBB', '24R');
    expect(r?.ident).toBe('24R');
    expect(r?.thrLat).toBeCloseTo(34.45133, 4);
    expect(r?.thrLon).toBeCloseTo(135.24001, 4);
    expect(r?.headingDeg).toBeCloseTo(230.6, 0);
    expect(r?.lengthM).toBeGreaterThan(3900); // 13 123 ft ≈ 4000 m
    expect(r?.lengthM).toBeLessThan(4100);
    const back = parseLandingRunway(runways, 'RJBB', '06l');
    expect(back?.thrLat).toBeCloseTo(34.4285, 4);
    expect(back?.headingDeg).toBeCloseTo(50.6, 0);
  });

  it('no planned runway or an unknown one: the longest, landing on its le end', () => {
    const r = parseLandingRunway(runways, 'KSFO', null);
    expect(r?.ident).toBe('10L'); // 11 870 ft, the longest of KSFO in the file
    expect(parseLandingRunway(runways, 'KSFO', '99')).toEqual(r);
    expect(parseLandingRunway(runways, 'ZZZZ', null)).toBeNull();
  });

  it('the longest runway into the METAR wind (user decision 2026-10-17)', () => {
    expect(parseLandingRunway(runways, 'KSFO', null, 290)?.ident).toBe('28R');
    expect(parseLandingRunway(runways, 'KSFO', null, 100)?.ident).toBe('10L');
    expect(parseLandingRunway(runways, 'KSFO', null, 220)?.ident).toBe('28R'); // 78° off 298°, 102° off 118°
    expect(parseLandingRunway(runways, 'KSFO', null, 200)?.ident).toBe('10L'); // 82° off 118°
    expect(parseLandingRunway(runways, 'KSFO', null, null)?.ident).toBe('10L'); // calm: the le end
    // A planned runway wins over the wind.
    expect(parseLandingRunway(runways, 'RJBB', '24R', 60)?.ident).toBe('24R');
    expect(() => parseLandingRunway('a,b\n1,2', 'RJBB', null)).toThrow(DataSourceError);
  });

  it('large airports: type large_airport only', () => {
    const large = parseLargeAirports(airports);
    expect(large).toEqual(expect.arrayContaining(['EDDF', 'EGLL', 'KJFK', 'RJBB']));
    expect(large).not.toContain('00A');
    expect(() => parseLargeAirports('a,b\n1,2')).toThrow(DataSourceError);
  });

  it('the service caches both and never throws', async () => {
    const calls: string[] = [];
    let offline = false;
    const svc = new ExternalDataService({
      http: {
        request: async (req) => {
          calls.push(req.url);
          if (offline) throw new Error('offline');
          const body = req.url === OURAIRPORTS_RUNWAYS_URL ? runways : airports;
          return { status: 200, headers: {}, body };
        },
      },
      userAgent: 'test',
    });
    const now = Date.UTC(2026, 9, 17);
    expect((await svc.landingRunway('RJBB', '24R', now))?.ident).toBe('24R');
    expect((await svc.landingRunway('RJBB', '24R', now + 1000))?.ident).toBe('24R');
    expect(await svc.isLargeAirport('EDDF', now)).toBe(true);
    expect(await svc.isLargeAirport('00A', now)).toBe(false);
    expect(calls).toEqual([OURAIRPORTS_RUNWAYS_URL, OURAIRPORTS_AIRPORTS_URL]);
    offline = true;
    expect(await svc.landingRunway('KSFO', null, now)).toBeNull();
  });
});
