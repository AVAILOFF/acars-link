// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

/**
 * Source of "now" for the core (CLAUDE.md, invariant 4). The core never reads ambient
 * time: the app passes a real clock, tests and replay pass a {@link ManualClock}.
 */
export interface Clock {
  /** Current time, epoch milliseconds UTC. */
  now(): number;
}

/** Clock that only moves when told to. For tests, replay and synthetic flights. */
export class ManualClock implements Clock {
  private ms: number;

  constructor(startMs: number) {
    ManualClock.check(startMs);
    this.ms = startMs;
  }

  now(): number {
    return this.ms;
  }

  set(ms: number): void {
    ManualClock.check(ms);
    if (ms < this.ms) throw new RangeError(`ManualClock cannot go backwards: ${ms} < ${this.ms}`);
    this.ms = ms;
  }

  advance(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      throw new RangeError(`ManualClock.advance needs a finite delta ≥ 0, got ${deltaMs}`);
    }
    this.ms += deltaMs;
  }

  private static check(ms: number): void {
    if (!Number.isFinite(ms)) throw new RangeError(`ManualClock needs a finite time, got ${ms}`);
  }
}
