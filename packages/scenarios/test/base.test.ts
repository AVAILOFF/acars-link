// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AcarsCore,
  B77X_PROFILE,
  B78X_PROFILE,
  type CompiledScenario,
  type CoreEvent,
  checkText,
  DEFAULT_PROFILE,
  type DisplayProfile,
  generateSyntheticFlight,
  MISSING,
  type Ofp,
  type OutboundMessage,
  parseSimbriefOfp,
  type SyntheticFlight,
  stageIndex,
  withGap,
  withPause,
  withSimRate,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../src/index.js';
import { standsFor } from './stands.js';

/**
 * T07: the 15 base scenarios (docs/02 MVP). docs/05 "Валидация контента": every scenario
 * runs on 3 synthetic flights; templates expand, lines fit the profile, no forbidden
 * characters, no missing values.
 */

const BASE = join(import.meta.dirname, '..', 'base');
const OFPS = join(import.meta.dirname, '../../core/test/fixtures/ofp');
const files = readdirSync(BASE)
  .filter((f) => f.endsWith('.yaml'))
  .sort()
  .map((file) => ({ file, source: readFileSync(join(BASE, file), 'utf8') }));
const base = loadScenarios(files);
const ofpOf = (name: string): Ofp =>
  parseSimbriefOfp(JSON.parse(readFileSync(join(OFPS, `${name}.json`), 'utf8')));

interface Case {
  readonly name: string;
  readonly ofp: Ofp;
  readonly flight: SyntheticFlight;
  readonly seed: string;
}

const kg = ofpOf('rctp-rjbb-a35k-kgs');
const lbs = ofpOf('rctp-rjbb-a35k-lbs-synthetic');
const normal = generateSyntheticFlight({ ofp: kg });
const goAround = generateSyntheticFlight({ ofp: kg, goAroundAglFt: 400 });
const lbsFlight = generateSyntheticFlight({ ofp: lbs, seed: 'lbs' });

const FLIGHTS: readonly Case[] = [
  { name: 'normal', ofp: kg, flight: normal, seed: 'normal' },
  {
    name: 'go-around, pause at gate, ×4 in cruise',
    ofp: kg,
    flight: withSimRate(
      withPause(goAround, { atIndex: stageIndex(goAround, 'GATE', 600), durationSec: 300 }),
      {
        fromIndex: stageIndex(goAround, 'CRUISE', 300),
        toIndex: stageIndex(goAround, 'CRUISE', 1500),
        rate: 4,
      },
    ),
    seed: 'go-around',
  },
  {
    name: 'lbs OFP, no flight number, telemetry gap in climb',
    ofp: lbs,
    flight: withGap(lbsFlight, { atIndex: stageIndex(lbsFlight, 'CLIMB', 120), durationSec: 90 }),
    seed: 'lbs',
  },
];

interface Run {
  readonly out: OutboundMessage[];
  readonly events: CoreEvent[];
}

function fly(
  c: Case,
  scenarios: readonly CompiledScenario[],
  profile: DisplayProfile = DEFAULT_PROFILE,
  seed: string = c.seed,
  stands = true,
): Run {
  const core = AcarsCore.create({ ofp: c.ofp, scenarios, seed, profile });
  core.startFlight();
  const out: OutboundMessage[] = [];
  const events: CoreEvent[] = [];
  c.flight.snapshots.forEach((s, i) => {
    const r = core.tick({
      now: s.t,
      telemetry: s,
      ...(i === 0 && stands ? { data: standsFor(c.ofp, s.t) } : {}),
    });
    out.push(...r.outbound);
    events.push(...r.events);
  });
  return { out, events };
}

const errors = (r: Run) => r.events.filter((e) => e.type === 'SCENARIO_ERROR');
const textOf = (r: Run, id: string) => r.out.find((m) => m.scenarioId === id)?.message.text ?? '';
// MISSING as a value, not inside a separator line of dashes.
const missing = new RegExp(`(^|[^-])${MISSING}($|[^-])`, 'm');
const num = (text: string, re: RegExp) => Number(re.exec(text)?.[1]);

describe('base scenario set', () => {
  it('has 17 scenarios, file name = id, all enabled by default', () => {
    expect(base).toHaveLength(17);
    expect(base.map((s) => `${s.id}.yaml`)).toEqual(files.map((f) => f.file));
    expect(base.every((s) => s.def.enabled_by_default)).toBe(true);
  });
});

describe.each(FLIGHTS)('each scenario alone on $name', (c) => {
  // probability forced to 1: the content is checked, not the dice.
  it.each(base.map((s) => [s.id, s] as const))('%s', (_, s) => {
    for (const profile of [DEFAULT_PROFILE, B77X_PROFILE, B78X_PROFILE]) {
      const r = fly(c, [{ ...s, probability: 1 }], profile);
      expect(errors(r)).toEqual([]);
      // slot_missed needs a late take-off after a slot: its own test below. connex_list needs
      // AeroDataBox data: external.test.ts.
      if (s.id === 'slot_missed' || s.id === 'connex_list') continue;
      expect(r.out.length, `${s.id} sent nothing on ${profile.id}`).toBeGreaterThan(0);
      for (const m of r.out) {
        expect(checkText(m.message.text, profile)).toEqual([]);
        expect(m.message.text).not.toMatch(missing);
        expect(m.message.lines.every((l) => l.length <= profile.lineWidth)).toBe(true);
      }
    }
  });
});

describe('the whole set on one flight', () => {
  const all = base.map((s) => ({ ...s, probability: 1 }));
  const r = fly(FLIGHTS[0] as Case, all);

  it('runs without errors, in flight order', () => {
    expect(errors(r)).toEqual([]);
    expect(r.out.map((m) => m.scenarioId)).toEqual([
      'crew_info',
      'slot_ctot',
      'prelim_loadsheet',
      'takeoff_data',
      'fuel_slip',
      'final_loadsheet',
      'departure_report',
      'next_leg', // aircraft_change: excluded by next_leg
      'dest_weather',
      'landing_data',
      'gate_assignment',
      'arrival_info',
      'block_report',
      'welcome_turnaround',
    ]);
    expect(
      r.out.map((m) => `${new Date(m.t).toISOString()} ${m.scenarioId}\n${m.message.text}`),
    ).toMatchSnapshot();
  });

  it('final loadsheet = preliminary + LMC', () => {
    const prelim = textOf(r, 'prelim_loadsheet');
    const final = textOf(r, 'final_loadsheet');
    const paxLmc = num(final, /LMC PAX ([+-]?\d+)/);
    expect(num(final, /\nPAX (\d+)/)).toBe(num(prelim, /\nPAX (\d+)/) + paxLmc);
    const cgoLmc = num(final, /CGO ([+-]?\d+) KG/);
    const zfw = (t: string) => num(t, /ZFW (\d+\.\d)/) * 1000;
    // kg1 rounds to 100 kg; the LMC mass includes the passengers' standard mass.
    expect(Math.abs(zfw(final) - zfw(prelim) - (cgoLmc + paxLmc * 104))).toBeLessThanOrEqual(100);
  });

  it('expected gate and arrival info name the same gate', () => {
    const gate = /EXPECTED GATE (\w+)/.exec(textOf(r, 'gate_assignment'))?.[1];
    expect(gate).toMatch(/^[A-E]\d{1,2}$/);
    expect(textOf(r, 'arrival_info')).toContain(`GATE ${gate} CONFIRMED`);
  });

  it('slot_missed: only when airborne later than CTOT + 10 min (window −5/+10, T43)', () => {
    const set = base
      .filter((x) => x.id === 'slot_ctot' || x.id === 'slot_missed')
      .map((x) => ({ ...x, probability: 1 }));
    // On time: took off before the CTOT, nothing to report.
    expect(fly(FLIGHTS[0] as Case, set).out.map((m) => m.scenarioId)).toEqual(['slot_ctot']);
    // The crew sits at the gate for an hour (no DELAY sent): far outside the slot.
    const lateFlight = withPause(normal, {
      atIndex: stageIndex(normal, 'GATE', 600),
      durationSec: 3600,
    });
    const r = fly({ name: 'late', ofp: kg, flight: lateFlight, seed: 'late' }, set);
    expect(errors(r)).toEqual([]);
    expect(r.out.map((m) => m.scenarioId)).toEqual(['slot_ctot', 'slot_missed']);
    const text = textOf(r, 'slot_missed');
    expect(text).toContain('DEPARTED OUTSIDE SLOT');
    expect(text).toContain(`CTOT ${/CTOT (\d{4})Z/.exec(textOf(r, 'slot_ctot'))?.[1]}Z`);
  });

  it('no stands known: no invented gate in any message (T43)', () => {
    const none = fly(FLIGHTS[0] as Case, all, DEFAULT_PROFILE, 'normal', false);
    expect(errors(none)).toEqual([]);
    expect(none.out.map((m) => m.scenarioId)).not.toContain('gate_assignment');
    const arrival = textOf(none, 'arrival_info');
    expect(arrival).toContain('GATE WILL BE ADVISED');
    expect(arrival).toContain('GROUND SUPPORT TBA');
    for (const m of none.out) expect(m.message.text).not.toMatch(/\bGATE [A-E]\d{1,2}\b/);
  });

  it('a parking position is a STAND without a bridge: bus and stairs (T43)', () => {
    const c = FLIGHTS[0] as Case;
    const core = AcarsCore.create({ ofp: c.ofp, scenarios: all, seed: 'normal' });
    core.startFlight();
    const out: OutboundMessage[] = [];
    c.flight.snapshots.forEach((s, i) => {
      const data =
        i === 0
          ? {
              t: s.t,
              stands: {
                icao: c.ofp.destination.icao,
                list: ['12', '13'].map((ref) => ({ ref, kind: 'stand' as const })),
              },
            }
          : undefined;
      out.push(...core.tick({ now: s.t, telemetry: s, ...(data ? { data } : {}) }).outbound);
    });
    const text = out.find((m) => m.scenarioId === 'arrival_info')?.message.text ?? '';
    expect(text).toMatch(/STAND 1[23] CONFIRMED/);
    expect(text).toContain('REMOTE STAND');
    expect(text).not.toContain('GPU AND PCA');
  });

  it('fuel_slip waits for the refuelling to settle; UPLIFT = FOB − first reading (T43)', () => {
    const MIN = 60_000;
    const t0 = normal.snapshots[0]?.t ?? 0;
    const ra = t0 + 16 * MIN;
    const rb = t0 + 19 * MIN;
    const fuelAt = (t: number) =>
      t <= ra ? 6000 : t >= rb ? 20000 : 6000 + (14000 * (t - ra)) / (rb - ra);
    const flight = {
      ...normal,
      snapshots: normal.snapshots.map((x) => ({ ...x, fuelKg: fuelAt(x.t) })),
    };
    const slip = base.filter((x) => x.id === 'fuel_slip').map((x) => ({ ...x, probability: 1 }));
    const run = fly({ name: 'refuel', ofp: kg, flight, seed: 'refuel' }, slip);
    expect(errors(run)).toEqual([]);
    const sent = run.out.find((m) => m.scenarioId === 'fuel_slip');
    // Level reached at rb, stable one minute later.
    expect(sent?.t).toBeGreaterThanOrEqual(rb + MIN);
    expect(sent?.t).toBeLessThanOrEqual(rb + 2 * MIN);
    const text = sent?.message.text ?? '';
    expect(num(text, /UPLIFT (\d+\.\d)/)).toBeCloseTo(14.0, 0);
    expect(num(text, /FOB (\d+\.\d)/)).toBeCloseTo(20.0, 0);
    // No refuelling at all: the slip still goes out, UPLIFT 0.
    const flat = fly(
      {
        name: 'flat',
        ofp: kg,
        flight: { ...normal, snapshots: normal.snapshots.map((x) => ({ ...x, fuelKg: 9000 })) },
        seed: 'flat',
      },
      slip,
    );
    expect(num(textOf(flat, 'fuel_slip'), /UPLIFT (\d+\.\d)/)).toBe(0);
    expect(flat.out.find((m) => m.scenarioId === 'fuel_slip')?.t).toBe(
      (kg.times.schedOutMs ?? 0) - 12 * MIN,
    );
  });

  it('slot moves the schedule: delay = CTOT − planned OFF (T43)', () => {
    const set = r.events.find((e) => e.type === 'SET' && e.name === 'flight.delay_min');
    expect(set).toMatchObject({ id: 'slot_ctot', applied: true });
    const planned =
      kg.times.schedOffMs ?? kg.times.schedOutMs + (kg.times.taxiOutSec ?? 600) * 1000;
    const ctot = /CTOT (\d{4})Z/.exec(textOf(r, 'slot_ctot'))?.[1] ?? '';
    const slotMin = num(textOf(r, 'slot_ctot'), /DELAY (\d+) MIN/);
    expect(new Date(planned + slotMin * 60_000).toISOString().slice(11, 16).replace(':', '')).toBe(
      ctot,
    );
    expect((set as { value: unknown }).value).toBe(slotMin);
  });

  it('next_leg and aircraft_change never both; each happens for some seeds', () => {
    const counts = { next_leg: 0, aircraft_change: 0 };
    for (let seed = 1; seed <= 30; seed++) {
      const ids = fly(FLIGHTS[0] as Case, base, DEFAULT_PROFILE, String(seed)).out.map(
        (m) => m.scenarioId,
      );
      const n = ids.includes('next_leg');
      const a = ids.includes('aircraft_change');
      expect(n && a).toBe(false);
      if (n) counts.next_leg++;
      if (a) counts.aircraft_change++;
    }
    expect(counts.next_leg).toBeGreaterThan(0);
    expect(counts.aircraft_change).toBeGreaterThan(0);
  }, 20_000); // 30 whole flights

  it('same seed → same messages', () => {
    const again = fly(FLIGHTS[0] as Case, all);
    expect(again.out).toEqual(r.out);
  });
});

describe('TLR and crew from the OFP (T43)', () => {
  const tlr = ofpOf('rctp-rjbb-a35k-kgs-tlr');
  const all = base.map((s) => ({ ...s, probability: 1 }));
  const c: Case = {
    name: 'tlr',
    ofp: tlr,
    flight: generateSyntheticFlight({ ofp: tlr }),
    seed: 'tlr',
  };
  const r = fly(c, all);

  it('runs without errors, every line fits every profile', () => {
    expect(errors(r)).toEqual([]);
    for (const profile of [DEFAULT_PROFILE, B77X_PROFILE, B78X_PROFILE]) {
      for (const m of fly(c, all, profile).out) {
        expect(checkText(m.message.text, profile)).toEqual([]);
        expect(m.message.text).not.toMatch(missing);
      }
    }
  });

  it('takeoff data: flaps, FLEX and V-speeds of the planned runway', () => {
    const text = textOf(r, 'takeoff_data');
    expect(text).toContain('RWY 05R');
    expect(text).toContain('FLAPS 1 FLEX 71');
    expect(text).toContain('V1 139 VR 139 V2 146');
  });

  it('landing data: flaps and VREF', () => {
    expect(textOf(r, 'landing_data')).toContain('FLAPS FULL VREF 131');
  });

  it('final loadsheet: crew 2/16 and OEW; crew info counts the same cabin crew', () => {
    const final = textOf(r, 'final_loadsheet');
    expect(final).toContain('CREW 2/16');
    expect(final).toContain('OEW 155.0');
    expect(textOf(r, 'crew_info')).toContain('CABIN CREW 16');
  });

  it('without TLR and crew: no performance or CREW line, nothing invented', () => {
    const plain = fly(FLIGHTS[0] as Case, all);
    expect(textOf(plain, 'takeoff_data')).not.toMatch(/FLAPS|V1/);
    expect(textOf(plain, 'landing_data')).not.toContain('VREF');
    expect(textOf(plain, 'final_loadsheet')).not.toContain('CREW');
  });

  it('TLR for another runway than planned is not used', () => {
    const moved: Ofp = { ...tlr, origin: { ...tlr.origin, planRwy: '05L' } };
    const run = fly(
      { ...c, ofp: moved },
      all.filter((s) => s.id === 'takeoff_data'),
    );
    expect(textOf(run, 'takeoff_data')).not.toContain('V1');
  });
});

describe('crew names by the airline (T43 item 10)', () => {
  const crewInfo = base.filter((s) => s.id === 'crew_info').map((s) => ({ ...s, probability: 1 }));
  const FI = new Set([
    'KORHONEN',
    'VIRTANEN',
    'MAKINEN',
    'NIEMINEN',
    'MAKELA',
    'HAMALAINEN',
    'LAINE',
    'HEIKKINEN',
    'KOSKINEN',
    'JARVINEN',
    'LEHTONEN',
    'LEHTINEN',
  ]);
  const airport = (icao: string) => ({ ...kg.origin, icao });
  /** Surnames of crew_info on `n` seeds. */
  function surnames(ofp: Ofp, n = 20, namesVersion?: 1 | 2): string[] {
    const flight = generateSyntheticFlight({ ofp });
    const out: string[] = [];
    for (let seed = 0; seed < n; seed++) {
      const core = AcarsCore.create({
        ofp,
        scenarios: crewInfo,
        seed: String(seed),
        ...(namesVersion === undefined ? {} : { namesVersion }),
      });
      core.startFlight();
      for (const snap of flight.snapshots.slice(0, 3)) {
        for (const m of core.tick({ now: snap.t, telemetry: snap }).outbound) {
          for (const line of m.message.lines) {
            const name = /^(?:CPT|FO|SCCM|CREW CONTROL) [A-Z]. (.+)$/.exec(line)?.[1];
            if (name !== undefined) out.push(name);
          }
        }
      }
    }
    return out;
  }
  const share = (names: readonly string[], set: ReadonlySet<string>) =>
    names.filter((x) => set.has(x)).length / names.length;
  const fin = (orig: string): Ofp => ({
    ...kg,
    airlineIcao: 'FIN',
    callsign: 'FIN4E',
    origin: airport(orig),
  });

  it('FIN from EFHK: Finnish surnames, about one in ten from elsewhere', () => {
    const names = surnames(fin('EFHK'));
    // 4 names a flight; a long one (VAN DEN BERG) may wrap and be missed here.
    expect(names.length).toBeGreaterThanOrEqual(75);
    expect(share(names, FI)).toBeGreaterThan(0.75);
    expect(share(names, FI)).toBeLessThan(1);
  });

  it('FIN from ENGM: still Finnish (by the airline, not the airport)', () => {
    expect(share(surnames(fin('ENGM')), FI)).toBeGreaterThan(0.75);
  });

  it('UAE from OMDB: a mixed crew from many regions', () => {
    const names = surnames({
      ...kg,
      airlineIcao: 'UAE',
      callsign: 'UAE5',
      origin: airport('OMDB'),
    });
    expect(new Set(names).size).toBeGreaterThan(20);
    expect(share(names, FI)).toBeLessThan(0.3);
  });

  it('airline not in OpenFlights: the origin (SJX from RCTP → Taiwan)', () => {
    const TW = new Set([
      'CHEN',
      'LIN',
      'HUANG',
      'CHANG',
      'LI',
      'WANG',
      'WU',
      'LIU',
      'TSAI',
      'YANG',
      'HSU',
      'CHENG',
    ]);
    expect(share(surnames(kg), TW)).toBeGreaterThan(0.75);
  });

  it('version 1 (old recordings): by the origin only, no mix', () => {
    const names = surnames(fin('ENGM'), 10, 1);
    expect(share(names, FI)).toBe(0);
    expect(names.every((x) => !FI.has(x))).toBe(true);
  });
});

describe('late start (docs/05 "Поздний старт")', () => {
  const MIN = 60_000;
  const STD = kg.times.schedOutMs;
  const all = base.map((s) => ({ ...s, probability: 1 }));
  const PRE = ['crew_info', 'slot_ctot', 'prelim_loadsheet', 'takeoff_data', 'fuel_slip'];

  /** Started `minBefore` minutes before STD; boarding then takes the usual 35 min. */
  const lateRun = (minBefore: number) =>
    fly(
      {
        name: 'late',
        ofp: kg,
        flight: generateSyntheticFlight({ ofp: kg, startMs: STD - minBefore * MIN }),
        seed: 'late',
      },
      all,
    );

  it('started 5 min before STD: delayed 30 min, documents in order with their spacing', () => {
    const r = lateRun(5);
    const start = STD - 5 * MIN;
    const at = (id: string) => r.out.find((m) => m.scenarioId === id)?.t;
    // Only crew info (−45 min, already past for the delayed flight) goes out at the start.
    expect(r.out.filter((m) => m.t === start).map((m) => m.scenarioId)).toEqual(['crew_info']);
    const newStd = STD + 30 * MIN;
    expect(at('slot_ctot')).toBe(newStd - 30 * MIN);
    expect(at('prelim_loadsheet')).toBe(newStd - 25 * MIN);
    expect(at('takeoff_data')).toBe(newStd - 20 * MIN);
    // The synthetic flight refuels in the first 60 % of boarding: the slip follows the end of it
    // by a minute, between its trigger (STD−18) and its deadline (STD−12).
    expect(at('fuel_slip')).toBeGreaterThanOrEqual(newStd - 18 * MIN);
    expect(at('fuel_slip')).toBeLessThanOrEqual(newStd - 12 * MIN);
    expect(at('final_loadsheet')).toBe(newStd - 7 * MIN);
    const order = r.out
      .map((m) => m.scenarioId)
      .filter((id) => [...PRE, 'final_loadsheet'].includes(id));
    expect(order).toEqual([...PRE, 'final_loadsheet']);
    expect(errors(r)).toEqual([]);
  });

  it('STD/STA stay as published; the CTOT is after the new off-block time', () => {
    const r = lateRun(5);
    expect(textOf(r, 'crew_info')).toContain(`STD ${hhmm(STD)}Z`);
    const ctot = /CTOT (\d{4})Z/.exec(textOf(r, 'slot_ctot'))?.[1] ?? '';
    const offMs = (kg.times.schedOffMs ?? STD) + 30 * MIN;
    expect(ctot > hhmm(offMs) || ctot < hhmm(STD)).toBe(true);
  });

  it('late arrival: welcome_turnaround shortens the turn to the time left (T43)', () => {
    const r = lateRun(5);
    const welcome = textOf(r, 'welcome_turnaround');
    const target = /QUICK TURN, TARGET (\d+)\s+MIN/.exec(welcome);
    expect(target, welcome).not.toBeNull();
    // The message goes 2 min after IN.
    const inMs = (r.out.find((m) => m.scenarioId === 'welcome_turnaround')?.t ?? 0) - 2 * MIN;
    const std = /STD (\d{4})Z/.exec(welcome)?.[1] ?? '';
    expect(Number(target?.[1])).toBeGreaterThan(0);
    expect(Number(target?.[1])).toBeLessThan(75);
    expect(hhmm(inMs + Number(target?.[1]) * MIN)).toBe(std);
    // On time the turn is the usual one.
    expect(textOf(fly(FLIGHTS[0] as Case, all), 'welcome_turnaround')).toMatch(
      /TURNAROUND \d+ MIN|QUICK/,
    );
  });

  it('late start: the reports carry delay code 63 (T43)', () => {
    const r = lateRun(5);
    const dep = textOf(r, 'departure_report');
    expect(dep).toMatch(/\nDL63\/(\d\d\/)?\d{4}(\/\d{4})?$/m);
    const line = /DL\S+/.exec(dep)?.[0];
    expect(textOf(r, 'block_report')).toContain(line);
    // On time: no delay line.
    expect(textOf(fly(FLIGHTS[0] as Case, all), 'departure_report')).not.toContain('DL');
  });

  it('pilot DELAY with a reason: its IATA code in the departure report (T43)', () => {
    const flight = withPause(normal, {
      atIndex: stageIndex(normal, 'GATE', 600),
      durationSec: 1200,
    });
    const set = all.filter((s) => s.id === 'departure_report' || s.id === 'cmd_delay');
    const core = AcarsCore.create({ ofp: kg, scenarios: set, seed: 'dly' });
    core.startFlight();
    const out: OutboundMessage[] = [];
    flight.snapshots.forEach((s, i) => {
      const inbound =
        i === 1
          ? [{ from: kg.callsign, type: 'telex' as const, text: 'DELAY 20 TECH BRAKES' }]
          : [];
      out.push(...core.tick({ now: s.t, telemetry: s, inbound }).outbound);
    });
    const dep = out.find((m) => m.scenarioId === 'departure_report')?.message.text ?? '';
    expect(dep).toMatch(/\nDL41\//);
  });

  it('started in time (35 min or more before STD): no delay, as before', () => {
    const core = AcarsCore.create({ ofp: kg, scenarios: all, seed: 'x' });
    core.startFlight();
    core.tick({ now: STD - 35 * MIN, telemetry: null });
    expect(core.getState().engine.delayMs).toBe(0);
    const late = AcarsCore.create({ ofp: kg, scenarios: all, seed: 'x' });
    late.tick({ now: STD - 33 * MIN, telemetry: null });
    expect(late.getState().engine.delayMs).toBe(5 * MIN); // 2 min late → rounded up to 5
    expect(
      AcarsCore.fromState(late.getState(), { ofp: kg, scenarios: all, seed: 'x' }).getState().engine
        .delayMs,
    ).toBe(5 * MIN);
  });
});

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
