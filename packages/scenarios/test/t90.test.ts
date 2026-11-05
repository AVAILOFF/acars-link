// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  aircraftInfo,
  B77X_PROFILE,
  B78X_PROFILE,
  buildFlightData,
  checkText,
  DEFAULT_PROFILE,
  generateSyntheticFlight,
  type Ofp,
  parseSimbriefOfp,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../src/index.js';
import { type Case, errors, fly, ids, missing, read, textsOf } from './irregular-fixture.js';

/** T90: the cargo pack, the passenger lines of shared scenarios, the freighter families. */

const cargoFiles = read('cargo');
const all = loadScenarios([
  ...read('base'),
  ...read('commands'),
  ...read('irregular'),
  ...cargoFiles,
]);
const cargoPack = loadScenarios(cargoFiles);
const byId = (id: string) => {
  const s = all.find((x) => x.id === id);
  if (s === undefined) throw new Error(`no scenario ${id}`);
  return { ...s, probability: 1 };
};

// biome-ignore lint/suspicious/noExplicitAny: tests mutate raw JSON freely
const raw = (): any =>
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../core/test/fixtures/ofp/rctp-rjbb-a35k-kgs.json'),
      'utf8',
    ),
  );
const cargoRaw = raw();
cargoRaw.weights.pax_count = '0';
cargoRaw.weights.pax_count_actual = '0';
cargoRaw.weights.bag_count = '0';
cargoRaw.weights.freight_added = '30000';
cargoRaw.weights.cargo = '30000';
const cargo: Ofp = parseSimbriefOfp(cargoRaw);
const paxOfp: Ofp = parseSimbriefOfp(raw());
const cargoCase: Case = {
  name: 'cargo',
  ofp: cargo,
  flight: generateSyntheticFlight({ ofp: cargo }),
};
const paxCase: Case = {
  name: 'pax',
  ofp: paxOfp,
  flight: generateSyntheticFlight({ ofp: paxOfp }),
};

/** A seed whose LMC of the freight has the sign `sign` (the scenarios depend on it). */
const seedWith = (sign: 1 | -1): string => {
  for (let i = 0; i < 200; i++) {
    const seed = `t90-${i}`;
    const lmc = buildFlightData(cargo, seed, undefined, 'cargo').load.cargoLmcKg;
    if (Math.sign(lmc) === sign) return seed;
  }
  throw new Error('no seed');
};

describe('cargo pack (T90)', () => {
  it('every scenario of the pack is for cargo flights only', () => {
    expect(cargoPack.length).toBe(10);
    for (const s of cargoPack) expect(s.def.operations, s.id).toEqual(['cargo']);
  });

  const cases = cargoPack.filter((s) => s.def.trigger.on !== 'command').map((s) => s.id);
  it.each(cases)('%s alone on a cargo flight, 3 profiles', (id) => {
    const seed =
      id === 'cargo_uld_damaged' ? seedWith(-1) : id === 'cargo_weight_error' ? seedWith(1) : 't90';
    for (const profile of [DEFAULT_PROFILE, B77X_PROFILE, B78X_PROFILE]) {
      const r = fly(cargoCase, [byId(id)], { profile, answer: 'ACK', flightKind: null, seed });
      expect(errors(r)).toEqual([]);
      expect(ids(r).filter((x) => x === id).length, `${id} on ${profile.id}`).toBeGreaterThan(0);
      for (const m of r.out) {
        expect(checkText(m.message.text, profile)).toEqual([]);
        expect(m.message.text, m.message.text).not.toMatch(missing);
        expect(m.message.text).not.toMatch(/\bPAX\b/);
      }
    }
  });

  it('a cargo flight gets the cargo loadsheets, not the passenger ones; scheduled the other way', () => {
    const set = [
      'prelim_loadsheet',
      'final_loadsheet',
      'cargo_prelim_loadsheet',
      'cargo_final_loadsheet',
    ].map(byId);
    const asCargo = fly(cargoCase, set, { flightKind: null });
    expect(ids(asCargo)).toEqual(['cargo_prelim_loadsheet', 'cargo_final_loadsheet']);
    const asPax = fly(cargoCase, set, { flightKind: 'sched_pax' });
    expect(ids(asPax)).toEqual(['prelim_loadsheet', 'final_loadsheet']);
    // Without the filter (recordings before T89) the kinds are not looked at: the passenger
    // ones run as before (an old recording lists only the scenarios it had).
    expect(ids(fly(cargoCase, set))).toEqual(
      expect.arrayContaining(['prelim_loadsheet', 'final_loadsheet']),
    );
  });

  it('the damaged ULD and the weight correction name the LMC of the final loadsheet', () => {
    for (const [id, sign] of [
      ['cargo_uld_damaged', -1],
      ['cargo_weight_error', 1],
    ] as const) {
      const seed = seedWith(sign);
      const r = fly(cargoCase, [byId(id), byId('cargo_final_loadsheet')], {
        flightKind: null,
        seed,
      });
      const lmc = buildFlightData(cargo, seed, undefined, 'cargo').load.cargoLmcKg;
      const kg = `LMC CGO ${lmc > 0 ? '+' : ''}${lmc} KG`;
      expect(textsOf(r, id).join(' ')).toContain(kg);
      expect(textsOf(r, 'cargo_final_loadsheet').join(' ')).toContain(kg);
    }
  });

  it('NOTOC: CAO YES only with UN3480 / UN3090', () => {
    for (let i = 0; i < 30; i++) {
      const r = fly(cargoCase, [byId('cargo_notoc')], {
        flightKind: null,
        answer: 'ACK',
        seed: `notoc-${i}`,
      });
      const text = textsOf(r, 'cargo_notoc')[0] as string;
      expect(text.includes('CAO YES')).toBe(/UN3480|UN3090/.test(text));
    }
  });

  it('REQ LOADSHEET on a cargo flight repeats the cargo loadsheet', () => {
    const set = [
      'cargo_final_loadsheet',
      'cmd_req_loadsheet',
      'cmd_req_loadsheet_cargo',
      'cmd_req_loadsheet_none',
    ].map(byId);
    const r = fly(cargoCase, set, {
      flightKind: null,
      until: (x) => x.out.some((m) => m.scenarioId === 'cargo_final_loadsheet'),
    });
    expect(ids(r)).toEqual(['cargo_final_loadsheet']);
    const again = r.core.tick({
      now: r.out[0]?.t ?? 0,
      telemetry: null,
      inbound: [{ from: cargo.callsign, type: 'telex', text: 'REQ LOADSHEET' }],
    });
    expect(again.outbound.map((m) => m.scenarioId)).toEqual(['cmd_req_loadsheet_cargo']);
    expect(again.outbound[0]?.message.text).toContain('FINAL LOADSHEET');
  });
});

describe('passenger lines of shared scenarios (T90)', () => {
  const arrival = [byId('arrival_info')];
  it('a cargo flight has no baggage belt and no transfer passengers', () => {
    const text = textsOf(fly(cargoCase, arrival, { flightKind: null }), 'arrival_info').join(' ');
    expect(text).not.toMatch(/BAGGAGE BELT|TRANSFER PAX/);
  });
  it('a scheduled flight keeps them, with the filter and without', () => {
    for (const k of [undefined, 'sched_pax'] as const) {
      const text = textsOf(
        fly(paxCase, arrival, k === undefined ? {} : { flightKind: k }),
        'arrival_info',
      ).join(' ');
      expect(text).toMatch(/BAGGAGE BELT \d+ TRANSFER PAX \d+/);
    }
  });
  it('without the filter a cargo OFP reads as before T90', () => {
    const text = textsOf(fly(cargoCase, arrival), 'arrival_info').join(' ');
    expect(text).toMatch(/BAGGAGE BELT \d+ TRANSFER PAX 0/);
  });
});

describe('load data by kind (T90)', () => {
  it('cargo: no passenger LMC; ferry: no LMC; the other draws stay', () => {
    const plain = buildFlightData(cargo, 'x');
    for (let i = 0; i < 50; i++) {
      const seed = `lmc-${i}`;
      const c = buildFlightData(cargo, seed, undefined, 'cargo');
      const f = buildFlightData(cargo, seed, undefined, 'ferry');
      const none = buildFlightData(cargo, seed);
      expect(c.load.paxLmc).toBe(0);
      expect(c.load.pax).toBe(0);
      expect(c.load.cargoLmcKg).toBe(none.load.cargoLmcKg);
      expect(f.load.lmc).toBe(false);
      expect(f.load.lmcKg).toBe(0);
      // The transfer passengers follow the passengers; everything else is the same draw.
      const same = (o: typeof none.ops) => ({ ...o, transferPax: 0 });
      expect(same(c.ops)).toEqual(same(none.ops));
      expect(same(f.ops)).toEqual(same(none.ops));
    }
    expect(plain.load.pax).toBeGreaterThanOrEqual(0);
  });
});

describe('freighter families (T90, ICAO Doc 8643)', () => {
  it.each([
    ['A306', 'A300'],
    ['A30B', 'A300'],
    ['B762', 'B767'],
    ['B763', 'B767'],
    ['B764', 'B767'],
    ['MD11', 'MD-11'],
  ])('%s → %s', (code, family) => {
    const a = aircraftInfo(code);
    expect(a?.family).toBe(family);
    expect(a?.body).toBe('WIDE');
  });
  it('alerting system: EICAS on the 767, none named on the A300 and MD-11', () => {
    expect(aircraftInfo('B763')?.alertSys).toBe('EICAS');
    expect(aircraftInfo('A306')?.alertSys).toBeNull();
    expect(aircraftInfo('MD11')?.alertSys).toBeNull();
  });
});
