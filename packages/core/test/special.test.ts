import { describe, expect, it } from 'vitest';
import {
  dayRangeText,
  eclipsesBetween,
  insidePolygon,
  latLonText,
  localEclipse,
  SOLAR_ECLIPSES,
  sunElevationDeg,
} from '../src/index.js';

/** T29: the astronomy of the special events, against NASA's published values. */

const byDate = (date: string) => {
  const e = SOLAR_ECLIPSES.find((x) => x.date === date);
  if (e === undefined) throw new Error(date);
  return e;
};
/** TD of greatest eclipse (catalogue) → UT with the catalogue ΔT. */
const ut = (date: string, td: string, dt: number) => Date.parse(`${date}T${td}Z`) - dt * 1000;

describe('localEclipse (NASA 5MCSE Besselian elements)', () => {
  it('2026-08-12: total at the point of greatest eclipse, magnitude and sun altitude as catalogued', () => {
    // Catalogue: greatest eclipse 17:47:06 TD, ΔT 75.4 s, 65.2N 25.2W, magnitude 1.0386, sun 26°.
    const e = byDate('2026-08-12');
    const le = localEclipse(
      e,
      { lat: 65.22345, lon: -25.21619 },
      ut('2026-08-12', '17:47:06', 75.4),
    );
    expect(le?.kind).toBe('TOTAL');
    expect(le?.magnitude).toBeCloseTo(1.0386, 2);
    expect(le?.sunAltDeg).toBeCloseTo(25.8, 0);
  });

  it('2027-08-02: total near Luxor at greatest eclipse (sun 82°)', () => {
    const e = byDate('2027-08-02');
    const le = localEclipse(e, { lat: 25.50236, lon: 33.19617 }, ut('2027-08-02', '10:07:50', 76));
    expect(le?.kind).toBe('TOTAL');
    expect(le?.magnitude).toBeCloseTo(1.079, 2);
    expect(le?.sunAltDeg).toBeCloseTo(81.7, 0);
  });

  it('partial away from the path, none far away or outside the time range', () => {
    const e = byDate('2026-08-12');
    const t = ut('2026-08-12', '17:47:06', 75.4);
    // London: partial, roughly 0.9 at this time.
    const london = localEclipse(e, { lat: 51.5, lon: -0.1 }, t + 15 * 60_000);
    expect(london?.kind).toBe('PARTIAL');
    expect(london?.magnitude).toBeGreaterThan(0.7);
    expect(london?.magnitude).toBeLessThan(1);
    expect(localEclipse(e, { lat: -35, lon: 150 }, t)).toBeNull();
    expect(localEclipse(e, { lat: 65.2, lon: -25.2 }, t + 10 * 3_600_000)).toBeNull();
  });

  it('eclipsesBetween picks the elements covering the window', () => {
    const t = Date.parse('2026-08-12T18:00:00Z');
    expect(eclipsesBetween(t, t + 3_600_000).map((e) => e.date)).toEqual(['2026-08-12']);
    expect(eclipsesBetween(t + 2 * 86_400_000, t + 3 * 86_400_000)).toEqual([]);
  });
});

describe('sunElevationDeg', () => {
  it('high at local noon near the equinox, below the horizon at midnight', () => {
    expect(sunElevationDeg({ lat: 0, lon: 0 }, Date.parse('2026-03-20T12:07:00Z'))).toBeGreaterThan(
      88,
    );
    expect(sunElevationDeg({ lat: 0, lon: 0 }, Date.parse('2026-03-20T00:07:00Z'))).toBeLessThan(
      -88,
    );
    // Tromsø in December: polar night, the sun stays below the horizon at noon.
    expect(
      sunElevationDeg({ lat: 69.65, lon: 18.96 }, Date.parse('2026-12-21T11:00:00Z')),
    ).toBeLessThan(0);
  });
});

describe('helpers', () => {
  it('insidePolygon, latLonText, dayRangeText', () => {
    const sq = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 1 },
      { lat: 1, lon: 1 },
      { lat: 1, lon: 0 },
    ];
    expect(insidePolygon({ lat: 0.5, lon: 0.5 }, sq)).toBe(true);
    expect(insidePolygon({ lat: 1.5, lon: 0.5 }, sq)).toBe(false);
    expect(latLonText({ lat: 65.2, lon: -25.4 })).toBe('65N 025W');
    expect(latLonText({ lat: -33.9, lon: 151.2 })).toBe('34S 151E');
    expect(dayRangeText('2026-07-20', '2026-07-24')).toBe('20-24JUL');
    expect(dayRangeText('2026-06-30', '2026-07-03')).toBe('30JUN-03JUL');
    expect(dayRangeText('2026-07-20', '2026-07-20')).toBe('20JUL');
  });
});
