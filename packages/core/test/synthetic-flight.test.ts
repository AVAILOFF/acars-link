// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  distanceNm,
  generateSyntheticFlight,
  isTelemetrySnapshot,
  parseSimbriefOfp,
  type SyntheticStage,
  type TelemetrySnapshot,
  withTouchdown,
} from '../src/index.js';

const ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'ofp', 'rctp-rjbb-a35k-kgs.json'), 'utf8'),
  ),
);
const flight = generateSyntheticFlight({ ofp });
const s = flight.snapshots;

const inStage = (stage: SyntheticStage): TelemetrySnapshot[] => {
  const i = flight.stages.findIndex((m) => m.stage === stage);
  const from = flight.stages[i]?.index ?? 0;
  const to = flight.stages[i + 1]?.index ?? s.length;
  return s.slice(from, to);
};

describe('generateSyntheticFlight — shape', () => {
  it('produces snapshots with the fields of reference/telemetry.sample.json (touchdownFpm is optional, T46)', () => {
    const sample = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../../reference/telemetry.sample.json'), 'utf8'),
    );
    expect(Object.keys(s[0] as object).sort()).toEqual(
      Object.keys(sample)
        .filter((k) => k !== 'touchdownFpm' && k !== 'simUtcMs')
        .sort(),
    );
  });

  it('runs through every stage in order', () => {
    expect(flight.stages.map((m) => m.stage)).toEqual([
      'GATE',
      'PUSHBACK',
      'TAXI_OUT',
      'TAKEOFF_ROLL',
      'CLIMB',
      'CRUISE',
      'DESCENT',
      'APPROACH',
      'ROLLOUT',
      'TAXI_IN',
      'PARKED',
    ]);
  });

  it('samples at 1 Hz from boarding so that pushback starts at sched_out', () => {
    for (let i = 1; i < s.length; i++)
      expect((s[i] as TelemetrySnapshot).t - (s[i - 1] as TelemetrySnapshot).t).toBe(1000);
    expect(flight.stages.find((m) => m.stage === 'PUSHBACK')?.t).toBe(ofp.times.schedOutMs);
  });

  it('honours stepMs and startMs', () => {
    const f = generateSyntheticFlight({ ofp, stepMs: 5000, startMs: 0 });
    expect(f.snapshots[0]?.t).toBe(0);
    expect(f.snapshots[1]?.t).toBe(5000);
    expect(f.stages.map((m) => m.stage)).toEqual(flight.stages.map((m) => m.stage));
  });
});

describe('touchdownFpm (T46)', () => {
  it('is optional, a number, and set by withTouchdown only after the landing', () => {
    const base = generateSyntheticFlight({ ofp }).snapshots;
    expect(base.every((x) => isTelemetrySnapshot(x))).toBe(true);
    const t = withTouchdown(generateSyntheticFlight({ ofp }), 420).snapshots;
    const first = t.findIndex((x) => x.touchdownFpm !== undefined);
    expect(first).toBeGreaterThan(0);
    expect(t.slice(first).every((x) => x.touchdownFpm === 420 && isTelemetrySnapshot(x))).toBe(
      true,
    );
    expect(t[first - 1]?.onGround === false || t[first]?.onGround === true).toBe(true);
    expect(isTelemetrySnapshot({ ...base[0], touchdownFpm: 'x' })).toBe(false);
  });
});

describe('generateSyntheticFlight — determinism (invariant 4)', () => {
  it('same options → identical snapshots', () => {
    expect(generateSyntheticFlight({ ofp })).toEqual(flight);
  });

  it('another seed changes only the noise, not the timeline', () => {
    const other = generateSyntheticFlight({ ofp, seed: 'other' });
    expect(other.stages).toEqual(flight.stages);
    expect(other.snapshots).not.toEqual(s);
  });

  it('noise: false is fully smooth in cruise', () => {
    const f = generateSyntheticFlight({ ofp, noise: false });
    const i = f.stages.findIndex((m) => m.stage === 'CRUISE');
    const cruise = f.snapshots.slice((f.stages[i]?.index ?? 0) + 5, f.stages[i + 1]?.index ?? 0);
    expect(new Set(cruise.map((x) => x.vsFpm))).toEqual(new Set([0]));
    expect(new Set(cruise.map((x) => x.altFt))).toEqual(new Set([ofp.initialAltitudeFt]));
  });
});

describe('generateSyntheticFlight — physical plausibility', () => {
  it('on the ground ⇔ AGL 0; never above cruise altitude', () => {
    for (const x of s) {
      if (x.onGround) expect(x.aglFt).toBe(0);
      expect(x.altFt).toBeLessThanOrEqual(ofp.initialAltitudeFt + 50);
    }
  });

  it('gate: parked, engines off, refuelling up to ramp fuel; doors closed before push', () => {
    const gate = inStage('GATE');
    for (const x of gate) {
      expect(x).toMatchObject({ onGround: true, gsKt: 0, parkingBrake: true });
      expect(x.engRunning.every((r) => !r)).toBe(true);
    }
    expect(gate[0]?.fuelKg).toBeLessThan(ofp.fuel.planRampKg * 0.5);
    expect(gate.at(-1)?.fuelKg).toBe(ofp.fuel.planRampKg);
    expect(gate[0]?.doorsOpen[0]).toBe(100);
    expect(gate.at(-1)?.doorsOpen[0]).toBe(0);
    expect(gate.at(-1)?.beacon).toBe(true);
  });

  it('pushback starts the engines; all are running before taxi', () => {
    expect(inStage('PUSHBACK')[0]?.engRunning).toEqual([false, false]);
    for (const x of inStage('TAXI_OUT')) expect(x.engRunning).toEqual([true, true]);
  });

  it('meets the docs/04 transition conditions somewhere in each stage', () => {
    expect(inStage('TAXI_OUT').some((x) => x.gsKt > 5)).toBe(true);
    expect(inStage('TAKEOFF_ROLL').some((x) => x.onGround && x.gsKt > 40)).toBe(true);
    expect(inStage('CLIMB').some((x) => !x.onGround && x.aglFt > 500)).toBe(true);
    const cruise = inStage('CRUISE');
    expect(cruise.every((x) => Math.abs(x.vsFpm) < 500)).toBe(true);
    expect(cruise.length).toBeGreaterThan(60);
    expect(inStage('DESCENT').some((x) => x.vsFpm < -800)).toBe(true);
    expect(inStage('APPROACH').every((x) => x.aglFt < 5000 && x.gearDown)).toBe(true);
    expect(inStage('ROLLOUT')[0]).toMatchObject({ onGround: true });
    expect(inStage('ROLLOUT')[0]?.gsKt).toBeGreaterThan(30);
  });

  it('timing is close to the OFP schedule', () => {
    const off = flight.stages.find((m) => m.stage === 'CLIMB')?.t ?? 0;
    const on = flight.stages.find((m) => m.stage === 'ROLLOUT')?.t ?? 0;
    expect(Math.abs(off - (ofp.times.schedOffMs ?? 0))).toBeLessThan(5 * 60_000);
    expect(Math.abs(on - (ofp.times.estOnMs ?? 0))).toBeLessThan(20 * 60_000);
  });

  it('fuel only goes down after refuelling and lands near the planned landing fuel', () => {
    const afterGate = s.slice(inStage('GATE').length);
    for (let i = 1; i < afterGate.length; i++) {
      expect((afterGate[i] as TelemetrySnapshot).fuelKg).toBeLessThanOrEqual(
        (afterGate[i - 1] as TelemetrySnapshot).fuelKg,
      );
    }
    const landing = inStage('ROLLOUT')[0]?.fuelKg ?? 0;
    expect(Math.abs(landing - (ofp.fuel.planLandingKg ?? 0))).toBeLessThan(1500);
  });

  it('ends parked near the destination with engines off', () => {
    const last = s.at(-1) as TelemetrySnapshot;
    expect(last).toMatchObject({ onGround: true, gsKt: 0, parkingBrake: true, beacon: false });
    expect(last.engRunning).toEqual([false, false]);
    expect(distanceNm(last, ofp.destination)).toBeLessThan(5);
  });

  it('supports four-engine aircraft', () => {
    const f = generateSyntheticFlight({ ofp, engineCount: 4 });
    const cruise = f.snapshots[f.stages.find((m) => m.stage === 'CRUISE')?.index ?? 0];
    expect(cruise?.engRunning).toEqual([true, true, true, true]);
  });
});
