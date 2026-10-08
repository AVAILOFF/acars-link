import { describe, expect, it } from 'vitest';
import {
  bearingDeg,
  destinationPoint,
  distanceNm,
  interpolate,
  ManualClock,
  normalizeDeg,
} from '../src/index.js';

describe('ManualClock', () => {
  it('starts, advances and sets forward only', () => {
    const c = new ManualClock(1_000);
    expect(c.now()).toBe(1_000);
    c.advance(500);
    expect(c.now()).toBe(1_500);
    c.set(2_000);
    expect(c.now()).toBe(2_000);
    expect(() => c.set(1_999)).toThrow(/backwards/);
    expect(() => c.advance(-1)).toThrow(RangeError);
    expect(() => new ManualClock(Number.NaN)).toThrow(RangeError);
  });
});

describe('geo', () => {
  const RCTP = { lat: 25.080278, lon: 121.232222 };
  const RJBB = { lat: 34.434167, lon: 135.232778 };

  it('great-circle distance matches SimBrief gc_distance (919 NM) for RCTP-RJBB', () => {
    expect(distanceNm(RCTP, RJBB)).toBeCloseTo(919, -0.5);
  });

  it('1° of latitude ≈ 60 NM, distance is symmetric and zero to itself', () => {
    expect(distanceNm({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(60.04, 1);
    expect(distanceNm(RJBB, RCTP)).toBeCloseTo(distanceNm(RCTP, RJBB), 9);
    expect(distanceNm(RCTP, RCTP)).toBe(0);
  });

  it('bearing: cardinal directions', () => {
    expect(bearingDeg({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(0, 6);
    expect(bearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(90, 6);
    expect(bearingDeg({ lat: 0, lon: 0 }, { lat: -1, lon: 0 })).toBeCloseTo(180, 6);
    expect(bearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: -1 })).toBeCloseTo(270, 6);
  });

  it('destinationPoint and interpolate stay on the great circle', () => {
    const d = distanceNm(RCTP, RJBB);
    const end = destinationPoint(RCTP, bearingDeg(RCTP, RJBB), d);
    expect(distanceNm(end, RJBB)).toBeLessThan(0.01);
    const mid = interpolate(RCTP, RJBB, 0.5);
    expect(distanceNm(RCTP, mid)).toBeCloseTo(d / 2, 3);
    expect(distanceNm(mid, RJBB)).toBeCloseTo(d / 2, 3);
  });

  it('wraps across the antimeridian', () => {
    const p = destinationPoint({ lat: 0, lon: 179.5 }, 90, 60);
    expect(p.lon).toBeCloseTo(-179.5, 2);
    expect(normalizeDeg(-90)).toBe(270);
    expect(normalizeDeg(720)).toBe(0);
  });
});
