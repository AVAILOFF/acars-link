// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AcarsCore,
  B73X_PROFILE,
  B75X_PROFILE,
  B77X_PROFILE,
  B78X_PROFILE,
  type CoreEvent,
  checkText,
  DEFAULT_PROFILE,
  type GroundServices,
  generateSyntheticFlight,
  isTelemetrySnapshot,
  type OutboundMessage,
  parseSimbriefOfp,
  type TelemetrySnapshot,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../src/index.js';

/** T98: ground services by the real state of GSX Pro. */

const BASE = join(import.meta.dirname, '..', 'base');
const base = loadScenarios(
  readdirSync(BASE)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(BASE, file), 'utf8') })),
);
const ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../core/test/fixtures/ofp/rctp-rjbb-a35k-kgs.json'),
      'utf8',
    ),
  ),
);
const MIN = 60_000;
const STD = ofp.times.schedOutMs;
const flight = generateSyntheticFlight({ ofp });
const docs = base
  .filter((s) =>
    ['prelim_loadsheet', 'fuel_slip', 'final_loadsheet', 'boarding_completed'].includes(s.id),
  )
  .map((s) => ({ ...s, probability: 1 }));

const IDLE: GroundServices = {
  boarding: 1,
  deboarding: 1,
  refuel: 1,
  catering: 1,
  departure: 1,
  cargo: false,
};

/** The synthetic flight with GSX states from `at(t)` (undefined = no GSX on that sample). */
function fly(
  at: (t: number) => GroundServices | undefined,
  o: { lateStartVersion?: 4 } = {},
): { out: OutboundMessage[]; events: CoreEvent[] } {
  const core = AcarsCore.create({ ofp, scenarios: docs, seed: 't98', ...o });
  core.startFlight();
  const out: OutboundMessage[] = [];
  const events: CoreEvent[] = [];
  for (const s of flight.snapshots) {
    if (s.t > STD + 30 * MIN) break;
    const g = at(s.t);
    const snap: TelemetrySnapshot = g === undefined ? s : { ...s, ground: g };
    const r = core.tick({ now: s.t, telemetry: snap });
    out.push(...r.outbound);
    events.push(...r.events);
  }
  return { out, events };
}

const timeOf = (r: { out: OutboundMessage[] }, id: string) =>
  r.out.find((m) => m.scenarioId === id)?.t;
const textOf = (r: { out: OutboundMessage[] }, id: string) =>
  r.out.find((m) => m.scenarioId === id)?.message.text ?? '';

/** Boarding requested at STD − 30, performed, completed at `doneAt` (null = never). */
const boarding =
  (doneAt: number | null) =>
  (t: number): GroundServices => ({
    ...IDLE,
    boarding: t < STD - 30 * MIN ? 1 : doneAt !== null && t >= doneAt ? 6 : 5,
  });

describe('telemetry: the ground field (T98)', () => {
  const s = flight.snapshots[0] as TelemetrySnapshot;

  it('optional: present, absent, malformed', () => {
    expect(isTelemetrySnapshot(s)).toBe(true);
    expect(isTelemetrySnapshot({ ...s, ground: IDLE })).toBe(true);
    expect(isTelemetrySnapshot({ ...s, ground: { ...IDLE, boarding: 7 } })).toBe(false);
    expect(isTelemetrySnapshot({ ...s, ground: { ...IDLE, cargo: 1 } })).toBe(false);
    expect(isTelemetrySnapshot({ ...s, ground: null })).toBe(false);
  });
});

describe('final loadsheet after the GSX boarding (T98)', () => {
  it('without GSX: at its time, as before (STD − 7)', () => {
    const r = fly(() => undefined);
    expect(timeOf(r, 'final_loadsheet')).toBe(STD - 7 * MIN);
    expect(timeOf(r, 'boarding_completed')).toBeUndefined();
    expect(r.events.some((e) => e.type === 'GROUND')).toBe(false);
  });

  it('GSX running but nothing requested (Д1): at its time, as without GSX', () => {
    const r = fly(() => IDLE);
    expect(timeOf(r, 'final_loadsheet')).toBe(STD - 7 * MIN);
    expect(textOf(r, 'final_loadsheet')).toBe(
      textOf(
        fly(() => undefined),
        'final_loadsheet',
      ),
    );
  });

  it('boarding ends after the loadsheet time: BOARDING COMPLETED, then the loadsheet a minute later', () => {
    const done = STD - 3 * MIN;
    const r = fly(boarding(done));
    const gate = timeOf(r, 'boarding_completed') ?? 0;
    expect(gate).toBeGreaterThanOrEqual(done);
    expect(gate).toBeLessThan(done + 2000);
    expect(timeOf(r, 'final_loadsheet')).toBeGreaterThanOrEqual(gate + MIN);
    expect(timeOf(r, 'final_loadsheet')).toBeLessThan(gate + MIN + 2000);
    expect(r.events).toContainEqual(
      expect.objectContaining({ type: 'GROUND', event: 'GSX_BOARDING_DONE' }),
    );
    // Д3: the passengers of the loadsheet (OFP with the LMC), not a GSX count.
    const pax = /\nPAX (\d+)\n/.exec(textOf(r, 'boarding_completed'))?.[1];
    expect(pax, textOf(r, 'boarding_completed') + textOf(r, 'final_loadsheet')).toBeDefined();
    expect(textOf(r, 'final_loadsheet')).toMatch(new RegExp(`PAX ${pax} CGO`));
  });

  it('boarding ended before the loadsheet time: the loadsheet at its time', () => {
    const r = fly(boarding(STD - 15 * MIN));
    expect(timeOf(r, 'boarding_completed')).toBeLessThan(STD - 14 * MIN);
    expect(timeOf(r, 'final_loadsheet')).toBe(STD - 7 * MIN);
  });

  it('boarding never ends: the loadsheet 10 min after its time (+1 min), then as without GSX', () => {
    const r = fly(boarding(null));
    const t = timeOf(r, 'final_loadsheet') ?? 0;
    expect(t).toBeGreaterThanOrEqual(STD + 4 * MIN - 2000);
    expect(t).toBeLessThanOrEqual(STD + 4 * MIN + 2000);
    expect(timeOf(r, 'boarding_completed')).toBeUndefined();
  });

  it('late start version 4 (T61): pushback ends the wait, the loadsheet is sent at once', () => {
    const r = fly(boarding(null), { lateStartVersion: 4 });
    const out = r.events.find((e) => e.type === 'OOOI_OUT' || e.type === 'PHASE_CHANGE');
    const push = r.events.find((e) => e.type === 'PHASE_CHANGE' && e.to === 'PUSHBACK')?.t ?? 0;
    expect(out).toBeDefined();
    const t = timeOf(r, 'final_loadsheet') ?? 0;
    expect(t).toBeGreaterThanOrEqual(push - 5000);
    expect(t).toBeLessThan(push + 2 * MIN);
  });

  it('state saved while the loadsheet waits for GSX: the same messages', () => {
    const at = boarding(STD - 3 * MIN);
    const whole = fly(at);
    const core0 = AcarsCore.create({ ofp, scenarios: docs, seed: 't98' });
    core0.startFlight();
    let core = core0;
    const out: OutboundMessage[] = [];
    let resumed = false;
    for (const s of flight.snapshots) {
      if (s.t > STD + 30 * MIN) break;
      if (!resumed && s.t >= STD - 5 * MIN) {
        core = AcarsCore.fromState(JSON.parse(JSON.stringify(core.getState())), {
          ofp,
          scenarios: docs,
          seed: 't98',
        });
        resumed = true;
      }
      out.push(...core.tick({ now: s.t, telemetry: { ...s, ground: at(s.t) } }).outbound);
    }
    expect(out.map((m) => [m.t, m.scenarioId, m.message.text])).toEqual(
      whole.out.map((m) => [m.t, m.scenarioId, m.message.text]),
    );
  });
});

describe('fuel slip after the GSX refuelling (T98)', () => {
  it('the slip waits while GSX refuels, then comes with the fuel stable', () => {
    const without =
      timeOf(
        fly(() => undefined),
        'fuel_slip',
      ) ?? 0;
    const end = STD - 10 * MIN;
    const r = fly((t) => ({ ...IDLE, refuel: t < STD - 30 * MIN ? 4 : t < end ? 5 : 6 }));
    expect(without).toBeLessThan(end);
    const t = timeOf(r, 'fuel_slip') ?? 0;
    expect(t).toBeGreaterThanOrEqual(end);
    expect(t).toBeLessThan(end + 2000);
    expect(r.events).toContainEqual(
      expect.objectContaining({ type: 'GROUND', event: 'GSX_REFUEL_DONE' }),
    );
  });
});

describe('BOARDING COMPLETED on every display profile (T98)', () => {
  it('fits each profile', () => {
    for (const profile of [
      DEFAULT_PROFILE,
      B73X_PROFILE,
      B75X_PROFILE,
      B77X_PROFILE,
      B78X_PROFILE,
    ]) {
      const core = AcarsCore.create({ ofp, scenarios: docs, seed: 't98', profile });
      core.startFlight();
      const at = boarding(STD - 3 * MIN);
      const out: OutboundMessage[] = [];
      for (const s of flight.snapshots) {
        if (s.t > STD) break;
        out.push(...core.tick({ now: s.t, telemetry: { ...s, ground: at(s.t) } }).outbound);
      }
      const m = out.find((x) => x.scenarioId === 'boarding_completed');
      expect(m, profile.id).toBeDefined();
      expect(checkText(m?.message.text ?? '', profile)).toEqual([]);
      expect(m?.message.lines.every((l) => l.length <= profile.lineWidth)).toBe(true);
    }
  });
});
