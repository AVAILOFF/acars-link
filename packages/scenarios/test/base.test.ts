import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AcarsCore,
  B77X_PROFILE,
  B78X_PROFILE,
  type CompiledScenario,
  checkText,
  DEFAULT_PROFILE,
  type DisplayProfile,
  generateSyntheticFlight,
  MISSING,
  type Ofp,
  type OutboundMessage,
  type PhaseEvent,
  parseSimbriefOfp,
  type ScenarioEvent,
  type SyntheticFlight,
  stageIndex,
  withGap,
  withPause,
  withSimRate,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../src/index.js';

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
  readonly events: (PhaseEvent | ScenarioEvent)[];
}

function fly(
  c: Case,
  scenarios: readonly CompiledScenario[],
  profile: DisplayProfile = DEFAULT_PROFILE,
  seed: string = c.seed,
): Run {
  const core = AcarsCore.create({ ofp: c.ofp, scenarios, seed, profile });
  core.startFlight();
  const out: OutboundMessage[] = [];
  const events: (PhaseEvent | ScenarioEvent)[] = [];
  for (const s of c.flight.snapshots) {
    const r = core.tick({ now: s.t, telemetry: s });
    out.push(...r.outbound);
    events.push(...r.events);
  }
  return { out, events };
}

const errors = (r: Run) => r.events.filter((e) => e.type === 'SCENARIO_ERROR');
const textOf = (r: Run, id: string) => r.out.find((m) => m.scenarioId === id)?.message.text ?? '';
// MISSING as a value, not inside a separator line of dashes.
const missing = new RegExp(`(^|[^-])${MISSING}($|[^-])`, 'm');
const num = (text: string, re: RegExp) => Number(re.exec(text)?.[1]);

describe('base scenario set', () => {
  it('has 15 scenarios, file name = id, all enabled by default', () => {
    expect(base).toHaveLength(15);
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
  });

  it('same seed → same messages', () => {
    const again = fly(FLIGHTS[0] as Case, all);
    expect(again.out).toEqual(r.out);
  });
});
