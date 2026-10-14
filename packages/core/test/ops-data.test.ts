import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  airlineType,
  buildFlightData,
  buildIrregularData,
  compileTemplate,
  createRng,
  type Lookup,
  type Ofp,
  parseSimbriefOfp,
  personName,
  regionOf,
} from '../src/index.js';

const ofpOf = (name: string): Ofp =>
  parseSimbriefOfp(
    JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'ofp', `${name}.json`), 'utf8')),
  );
const kg = ofpOf('rctp-rjbb-a35k-kgs');
const lbs = ofpOf('rctp-rjbb-a35k-lbs-synthetic');
const MIN = 60_000;
const seeds = Array.from({ length: 200 }, (_, i) => `seed-${i}`);

describe('buildFlightData', () => {
  it('is a pure function of OFP and seed', () => {
    expect(buildFlightData(kg, 'a')).toEqual(buildFlightData(kg, 'a'));
    const distinct = new Set(seeds.slice(0, 20).map((s) => JSON.stringify(buildFlightData(kg, s))));
    expect(distinct.size).toBeGreaterThan(15);
  });

  it('LMC: ±5 pax and ±200 kg cargo (docs/01), weights follow it', () => {
    const w = kg.weights;
    let withLmc = 0;
    for (const seed of seeds) {
      const { load } = buildFlightData(kg, seed);
      expect(Math.abs(load.paxLmc)).toBeLessThanOrEqual(5);
      expect(Math.abs(load.cargoLmcKg)).toBeLessThanOrEqual(200);
      expect(Math.abs(load.cargoLmcKg % 10)).toBe(0);
      expect(load.pax).toBe(w.paxCount + load.paxLmc);
      expect(load.lmcKg).toBe(load.paxLmc * (79 + 25) + load.cargoLmcKg);
      expect(load.zfwKg).toBe(w.estZfwKg + load.lmcKg);
      expect(load.towKg).toBe(w.estTowKg + load.lmcKg);
      expect(load.ldwKg).toBe((w.estLdwKg ?? 0) + load.lmcKg);
      const allowed = Math.min(
        w.maxTowKg,
        w.maxZfwKg + kg.fuel.planTakeoffKg,
        (w.maxLdwKg ?? Number.POSITIVE_INFINITY) + kg.fuel.enrouteBurnKg,
      );
      expect(load.underloadKg).toBe(allowed - load.towKg);
      expect(load.lmc).toBe(load.paxLmc !== 0 || load.cargoLmcKg !== 0);
      if (load.lmc) withLmc++;
    }
    // P(no change) = (0.5 + 0.5/11)·(0.5 + 0.5/41) ≈ 0.28
    expect(withLmc).toBeGreaterThan(110);
    expect(withLmc).toBeLessThan(180);
  });

  it('ops: CTOT after planned off, gate format, sane counts, next leg', () => {
    for (const seed of seeds) {
      const { ops, load } = buildFlightData(kg, seed);
      expect(ops.slotDelayMin).toBeGreaterThanOrEqual(5);
      expect(ops.slotDelayMin).toBeLessThanOrEqual(30);
      expect(ops.ctot).toBe((kg.times.schedOffMs ?? 0) + ops.slotDelayMin * MIN);
      expect(ops.arrGate).toBeNull(); // never invented (T43): the engine takes it from OSM stands
      expect(ops.transferPax).toBeLessThanOrEqual(load.pax);
      expect([75, 80, 85, 90, 95]).toContain(ops.turnaroundMin); // A35K: wake H
      expect(ops.nextStd % (5 * MIN)).toBe(0);
      expect(ops.nextFlight).toBe('SJX823');
    }
  });

  it('next leg without an airline flight number: callsign number + 1', () => {
    expect(lbs.flightNumber).toBeNull();
    expect(buildFlightData(lbs, 'x').ops.nextFlight).toBe(
      lbs.callsign.replace(/\d+$/, (n) => String(Number(n) + 1)),
    );
  });
});

describe('names', () => {
  it.each([
    ['RJBB', 'jp'],
    ['RCTP', 'tw'],
    ['RKSI', 'kr'],
    ['ZBAA', 'cn'],
    ['VHHH', 'cn'],
    ['UUEE', 'ru'],
    ['EDDF', 'de'],
    ['LOWW', 'de'],
    ['LFPG', 'fr'],
    ['LEMD', 'es'],
    ['LIRF', 'it'],
    ['EGLL', 'en'],
    ['KJFK', 'en'],
    ['', 'en'],
  ])('%s → %s', (icao, region) => {
    expect(regionOf(icao)).toBe(region);
  });

  it('formats as initial and surname, deterministically', () => {
    const a = createRng('n');
    const b = createRng('n');
    for (let i = 0; i < 50; i++) {
      const n = personName('crew', 'RJBB', a);
      expect(n).toMatch(/^[A-Z]\. [A-Z]+$/);
      expect(personName('crew', 'RJBB', b)).toBe(n);
    }
  });

  it('{name:crew} in a template: version 1 (no names.*) uses the origin region', () => {
    const look: Lookup = (p) => (p === 'ofp.orig' ? 'RJBB' : undefined);
    const t = compileTemplate('CPT {name:crew}');
    expect(t.vars).toEqual(['ofp.orig', 'names.region', 'names.mix']);
    const jp = new Set(['SATO', 'SUZUKI', 'TAKAHASHI', 'TANAKA', 'WATANABE', 'ITO']);
    const all = new Set<string>();
    for (let i = 0; i < 100; i++) all.add(t.render(look, createRng(i)).split(' ').at(-1) ?? '');
    expect([...jp].some((s) => all.has(s))).toBe(true);
    expect(all.has('SMITH')).toBe(false);
  });
});

describe('|sign', () => {
  const look: Lookup = (p) => ({ a: 3, b: -120, c: 0, d: null })[p.slice(2)];
  it.each([
    ['{x.a|sign}', '+3'],
    ['{x.b|sign}', '-120'],
    ['{x.c|sign}', '0'],
    ['{x.d|sign}', '----'],
  ])('%s → %s', (src, out) => {
    expect(compileTemplate(src).render(look, createRng(1))).toBe(out);
  });
});

describe('airline type: turnaround and onward connection (T43)', () => {
  const as = (airline: string): Ofp => ({ ...kg, airlineIcao: airline });
  const range = (xs: readonly number[]) => [Math.min(...xs), Math.max(...xs)];
  const turn = (o: Ofp) => range(seeds.map((s) => buildFlightData(o, s).ops.turnaroundMin));
  const conn = (o: Ofp) =>
    range(seeds.map((s) => (buildIrregularData(o, s, 20).connectStd - o.times.schedInMs) / MIN));

  it('classifies by ICAO code', () => {
    expect(airlineType('RYR')).toBe('LCC');
    expect(airlineType('EJU')).toBe('LCC');
    expect(airlineType('UAE')).toBe('HUB');
    expect(airlineType('SIA')).toBe('HUB');
    expect(airlineType('FIN')).toBe('OTHER');
    expect(airlineType(null)).toBe('OTHER');
  });

  it('low-cost: short turnaround and connection', () => {
    expect(turn(as('RYR'))).toEqual([25, 35]);
    const [lo, hi] = conn(as('EZY'));
    expect(lo).toBeGreaterThanOrEqual(30);
    expect(hi).toBeLessThanOrEqual(55); // rounded up to 5 min
  });

  it('hub carriers: about two hours', () => {
    expect(turn(as('UAE'))).toEqual([105, 135]);
    const [lo, hi] = conn(as('ETD'));
    expect(lo).toBeGreaterThanOrEqual(100);
    expect(hi).toBeLessThanOrEqual(145);
  });

  it('others as before (heavy A35K: 75–95, connection 50–95)', () => {
    expect(turn(kg)).toEqual([75, 95]);
    const [lo, hi] = conn(kg);
    expect(lo).toBeGreaterThanOrEqual(50);
    expect(hi).toBeLessThanOrEqual(100);
  });
});
