// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { describe, expect, it } from 'vitest';
import { createRng, hashSeed, rngFromState } from '../src/index.js';

/** Straight BigInt port of xoshiro128starstar.c — independent of the Math.imul implementation. */
function referenceXoshiro(state: [bigint, bigint, bigint, bigint]) {
  const M = 0xffff_ffffn;
  const rotl = (x: bigint, k: bigint) => ((x << k) | (x >> (32n - k))) & M;
  const s = [...state];
  return (): number => {
    const [s0, s1, s2, s3] = s as [bigint, bigint, bigint, bigint];
    const result = (rotl((s1 * 5n) & M, 7n) * 9n) & M;
    const t = (s1 << 9n) & M;
    let n2 = s2 ^ s0;
    const n3 = s3 ^ s1;
    const n1 = s1 ^ n2;
    const n0 = s0 ^ n3;
    n2 ^= t;
    s[0] = n0;
    s[1] = n1;
    s[2] = n2;
    s[3] = rotl(n3, 11n);
    return Number(result);
  };
}

describe('xoshiro128**', () => {
  it('matches the published sequence for state [1, 2, 3, 4]', () => {
    // Same vector as rand_xoshiro's Xoshiro128StarStar reference test.
    const rng = rngFromState([1, 2, 3, 4]);
    const got = Array.from({ length: 10 }, () => rng.nextU32());
    expect(got).toEqual([
      11520, 0, 5927040, 70819200, 2031721883, 1637235492, 1287239034, 3734860849, 3729100597,
      4258142804,
    ]);
  });

  it('matches an independent BigInt port of the C code for 10 000 outputs', () => {
    const state = createRng('cross-check').getState();
    const rng = rngFromState(state);
    const ref = referenceXoshiro(state.map(BigInt) as [bigint, bigint, bigint, bigint]);
    for (let i = 0; i < 10_000; i++) expect(rng.nextU32()).toBe(ref());
  });
});

describe('seeding (replay contract — changing it changes every generated flight)', () => {
  it('hashSeed is FNV-1a 32', () => {
    expect(hashSeed('')).toBe(0x811c9dc5);
    expect(hashSeed('a')).toBe(0xe40c292c);
    expect(hashSeed('foobar')).toBe(0xbf9cf968);
  });

  it('golden: string seed → first outputs', () => {
    const rng = createRng('SJX822/188988250');
    expect(Array.from({ length: 5 }, () => rng.nextU32())).toMatchInlineSnapshot(`
      [
        4124526478,
        660485401,
        2354520197,
        4244830780,
        2285923059,
      ]
    `);
  });

  it('golden: numeric seed → first outputs', () => {
    const rng = createRng(42);
    expect(Array.from({ length: 5 }, () => rng.nextU32())).toMatchInlineSnapshot(`
      [
        2837322924,
        544945897,
        479756282,
        3500138142,
        339756180,
      ]
    `);
  });

  it('same seed → same sequence, different seed → different sequence', () => {
    const a = createRng('EDDF-EGLL');
    const b = createRng('EDDF-EGLL');
    const c = createRng('EDDF-EGLM');
    const sa = Array.from({ length: 100 }, () => a.next());
    expect(Array.from({ length: 100 }, () => b.next())).toEqual(sa);
    expect(Array.from({ length: 100 }, () => c.next())).not.toEqual(sa);
  });

  it('state round-trips through getState / rngFromState (resume after restart)', () => {
    const a = createRng(7);
    for (let i = 0; i < 37; i++) a.nextU32();
    const saved = JSON.parse(JSON.stringify(a.getState()));
    const b = rngFromState(saved);
    expect(Array.from({ length: 50 }, () => b.nextU32())).toEqual(
      Array.from({ length: 50 }, () => a.nextU32()),
    );
  });

  it('rejects invalid seeds and states', () => {
    expect(() => createRng(-1)).toThrow(RangeError);
    expect(() => createRng(1.5)).toThrow(RangeError);
    expect(() => createRng(2 ** 32)).toThrow(RangeError);
    expect(() => rngFromState([0, 0, 0, 0])).toThrow(/all zero/);
    expect(() => rngFromState([1, 2, 3, -4])).toThrow(/uint32/);
  });
});

describe('Rng helpers', () => {
  it('next() is in [0, 1)', () => {
    const rng = createRng(1);
    for (let i = 0; i < 10_000; i++) {
      const x = rng.next();
      expect(x >= 0 && x < 1).toBe(true);
    }
  });

  it('int(min, max) covers the inclusive range evenly', () => {
    const rng = createRng(2);
    const counts = new Map<number, number>();
    const N = 60_000;
    for (let i = 0; i < N; i++) {
      const x = rng.int(-5, 5);
      counts.set(x, (counts.get(x) ?? 0) + 1);
    }
    expect([...counts.keys()].sort((a, b) => a - b)).toEqual([
      -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5,
    ]);
    for (const c of counts.values()) expect(Math.abs(c - N / 11)).toBeLessThan(N / 11 / 10);
  });

  it('int handles single-value and full uint32 ranges', () => {
    const rng = createRng(3);
    expect(rng.int(7, 7)).toBe(7);
    const x = rng.int(0, 2 ** 32 - 1);
    expect(Number.isInteger(x) && x >= 0 && x < 2 ** 32).toBe(true);
    expect(() => rng.int(5, 4)).toThrow(RangeError);
    expect(() => rng.int(0, 2 ** 32)).toThrow(/too wide/);
  });

  it('chance(p) respects the edges and the rate', () => {
    const rng = createRng(4);
    expect(Array.from({ length: 100 }, () => rng.chance(0)).some(Boolean)).toBe(false);
    expect(Array.from({ length: 100 }, () => rng.chance(1)).every(Boolean)).toBe(true);
    const hits = Array.from({ length: 20_000 }, () => rng.chance(0.05)).filter(Boolean).length;
    expect(hits).toBeGreaterThan(800);
    expect(hits).toBeLessThan(1200);
    expect(() => rng.chance(1.1)).toThrow(RangeError);
    expect(() => rng.chance(Number.NaN)).toThrow(RangeError);
  });

  it('pick() returns elements and rejects empty arrays', () => {
    const rng = createRng(5);
    const items = ['CHEST PAIN', 'FAINTED', 'BREATHING DIFFICULTY'] as const;
    const seen = new Set(Array.from({ length: 200 }, () => rng.pick(items)));
    expect(seen).toEqual(new Set(items));
    expect(() => rng.pick([])).toThrow(RangeError);
  });
});
