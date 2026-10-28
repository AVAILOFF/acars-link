// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

/**
 * Seeded randomness for the core (CLAUDE.md, invariant 4): same seed → same sequence,
 * on every platform. Generator: xoshiro128** 1.1 (Blackman & Vigna, public domain),
 * https://prng.di.unimi.it/xoshiro128starstar.c
 *
 * Seeding is ours and part of the replay contract: a string seed is hashed with
 * FNV-1a (32 bit, over UTF-16 code units), the 32-bit seed is expanded to the 128-bit
 * state with a SplitMix32-style mixer. Changing either changes every generated flight —
 * golden tests in test/rng.test.ts guard it.
 */

/** Serializable generator state (four uint32 words). */
export type RngState = readonly [number, number, number, number];

export interface Rng {
  /** Uniform uint32. */
  nextU32(): number;
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max], both inclusive. Unbiased. */
  int(min: number, max: number): number;
  /** True with probability p (0..1). */
  chance(p: number): boolean;
  /** Uniform element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** Snapshot of the internal state; {@link rngFromState} resumes from it. */
  getState(): RngState;
}

const TWO_POW_32 = 0x1_0000_0000;

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** FNV-1a 32-bit over UTF-16 code units. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function expandSeed(seed: number): [number, number, number, number] {
  let x = seed >>> 0;
  const word = (): number => {
    x = (x + 0x9e3779b9) >>> 0;
    let z = x;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
  return [word(), word(), word(), word()];
}

class Xoshiro128StarStar implements Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(state: RngState) {
    const [a, b, c, d] = state;
    for (const w of state) {
      if (!Number.isInteger(w) || w < 0 || w >= TWO_POW_32) {
        throw new RangeError(`Rng state words must be uint32, got ${w}`);
      }
    }
    if ((a | b | c | d) === 0) throw new RangeError('Rng state must not be all zero');
    this.s0 = a;
    this.s1 = b;
    this.s2 = c;
    this.s3 = d;
  }

  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  next(): number {
    return this.nextU32() / TWO_POW_32;
  }

  int(min: number, max: number): number {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
      throw new RangeError(`Rng.int needs integers min ≤ max, got ${min}..${max}`);
    }
    const span = max - min + 1;
    if (span > TWO_POW_32) throw new RangeError(`Rng.int range too wide: ${span}`);
    // Rejection sampling: drop the top partial bucket so every value is equally likely.
    const limit = TWO_POW_32 - (TWO_POW_32 % span);
    let x = this.nextU32();
    while (x >= limit) x = this.nextU32();
    return min + (x % span);
  }

  chance(p: number): boolean {
    if (!(p >= 0 && p <= 1)) throw new RangeError(`Rng.chance needs 0 ≤ p ≤ 1, got ${p}`);
    if (p === 0) return false;
    if (p === 1) return true;
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('Rng.pick needs a non-empty array');
    return items[this.int(0, items.length - 1)] as T;
  }

  getState(): RngState {
    return [this.s0, this.s1, this.s2, this.s3];
  }
}

/** Creates a generator from a numeric (uint32) or string seed, e.g. `callsign + OFP id`. */
export function createRng(seed: number | string): Rng {
  const n = typeof seed === 'string' ? hashSeed(seed) : seed;
  if (!Number.isInteger(n) || n < 0 || n >= TWO_POW_32) {
    throw new RangeError(`Rng seed must be a uint32 or a string, got ${seed}`);
  }
  return new Xoshiro128StarStar(expandSeed(n));
}

/** Resumes a generator from {@link Rng.getState} (e.g. after an app restart). */
export function rngFromState(state: RngState): Rng {
  return new Xoshiro128StarStar(state);
}
