// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import {
  B77X_PROFILE,
  B78X_PROFILE,
  checkText,
  DEFAULT_PROFILE,
  type FlightKind,
  type MassUnitOption,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../src/index.js';
import { type Case, errors, FLIGHTS, fly, kg, lbs, missing, read } from './irregular-fixture.js';

/**
 * T105: weights of the messages in the unit of the setting — `ofp` (the OFP's), `kg`, `lb`. Big
 * figures in tonnes / 1000 LB with one decimal, small ones in whole KG / LB.
 */

const all = loadScenarios([
  ...read('base'),
  ...read('commands'),
  ...read('irregular'),
  ...read('cargo'),
  ...read('charter'),
  ...read('ferry'),
  ...read('bizav'),
]);
const byId = (id: string) => {
  const s = all.find((x) => x.id === id);
  if (s === undefined) throw new Error(`no scenario ${id}`);
  return { ...s, probability: 1 };
};

const KG_PER_LB = 0.45359237;
const lbsFlight = (FLIGHTS[2] as Case).flight;
const kgFlight = (FLIGHTS[0] as Case).flight;
const on = (ofp: 'kg' | 'lbs', massUnit: MassUnitOption): Case =>
  ofp === 'lbs'
    ? { name: `lbs/${massUnit}`, ofp: lbs, flight: lbsFlight, massUnit }
    : { name: `kg/${massUnit}`, ofp: kg, flight: kgFlight, massUnit };
const textOf = (c: Case, id: string, kind?: FlightKind) => {
  const r = fly(c, [byId(id)], kind === undefined ? {} : { flightKind: kind });
  expect(errors(r)).toEqual([]);
  return r.out.find((m) => m.scenarioId === id)?.message.text ?? '';
};
const zfw = (t: string) => Number(/ZFW (\d+\.\d)/.exec(t)?.[1]);

describe('T105: mass units of the messages', () => {
  it('final loadsheet: an lbs OFP in LB with the setting "as in the OFP"', () => {
    const t = textOf(on('lbs', 'ofp'), 'final_loadsheet');
    expect(t).toContain('ALL WEIGHTS IN 1000 LBS');
    expect(t).toMatch(/LMC PAX [+-]?\d+ CGO [+-]?\d+ LB$/m);
    expect(t).not.toMatch(/\bKG\b|TONNES/);
    // MAX ZFW of the OFP back in pounds, to 100 lb.
    const maxZfw = Number(/ZFW \d+\.\d MAX (\d+\.\d)/.exec(t)?.[1]);
    expect(Math.abs(maxZfw * 1000 - lbs.weights.maxZfwKg / KG_PER_LB)).toBeLessThanOrEqual(50);
  });

  it('the same flight in KG: tonnes, as before T105 (the default of recordings)', () => {
    const inKg = textOf(on('lbs', 'kg'), 'final_loadsheet');
    expect(inKg).toContain('ALL WEIGHTS IN TONNES');
    expect(inKg).toMatch(/CGO [+-]?\d+ KG$/m);
    const lb = textOf(on('lbs', 'ofp'), 'final_loadsheet');
    expect(zfw(lb) / zfw(inKg)).toBeCloseTo(1 / KG_PER_LB, 1);
    // No option at all = kg.
    const none: Case = { name: 'lbs', ofp: lbs, flight: lbsFlight };
    expect(textOf(none, 'final_loadsheet')).toBe(inKg);
  });

  it('a kg OFP forced to LB; "as in the OFP" keeps it in KG', () => {
    expect(textOf(on('kg', 'lb'), 'prelim_loadsheet')).toContain('ALL WEIGHTS IN 1000 LBS');
    expect(textOf(on('kg', 'ofp'), 'prelim_loadsheet')).toContain('ALL WEIGHTS IN TONNES');
  });

  it('fuel slip: 1000 LBS and the difference in LB', () => {
    const t = textOf(on('lbs', 'ofp'), 'fuel_slip');
    expect(t).toContain('FUEL IN 1000 LBS');
    expect(t).toMatch(/^DIFF [+-]?\d+ LB$/m);
  });

  it.each([
    ['cargo_final_loadsheet', 'cargo', /ALL WEIGHTS IN 1000 LBS/],
    ['ferry_loadsheet', 'ferry', /ALL WEIGHTS IN 1000 LBS/],
    ['bizav_fuel_release', 'bizav', /OFP BLOCK FUEL \d+00 LB$/m],
  ] as const)('%s (%s) in LB, fits every display', (id, kind, re) => {
    for (const profile of [DEFAULT_PROFILE, B77X_PROFILE, B78X_PROFILE]) {
      const r = fly(on('lbs', 'ofp'), [byId(id)], { flightKind: kind, profile });
      expect(errors(r)).toEqual([]);
      const out = r.out.filter((m) => m.scenarioId === id);
      expect(out.length, `${id} on ${profile.id}`).toBeGreaterThan(0);
      for (const m of out) {
        expect(m.message.text).toMatch(re);
        expect(m.message.text).not.toMatch(/\bKG\b|TONNES|\d T$/m);
        expect(m.message.text).not.toMatch(missing);
        expect(checkText(m.message.text, profile)).toEqual([]);
        expect(m.message.lines.every((l) => l.length <= profile.lineWidth)).toBe(true);
      }
    }
  });
});
