// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AcarsCore,
  buildIrregularData,
  type CoreEvent,
  compileScenario,
  generateSyntheticFlight,
  metarTempC,
  metarWind,
  type OutboundMessage,
  parseSimbriefOfp,
  reassignedGate,
  type ScenarioDef,
  ScenarioError,
  type ScenarioEvent,
  smokeDrift,
  type Value,
} from '../src/index.js';

/** T14: `set` (flags across flights, diversion, arrival gate) and the irregular data. */

const ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'ofp', 'rctp-rjbb-a35k-kgs.json'), 'utf8'),
  ),
);
const flight = generateSyntheticFlight({ ofp });

const def = (d: Partial<ScenarioDef> & Pick<ScenarioDef, 'id' | 'trigger'>): ScenarioDef => ({
  version: 1,
  category: 'irregular',
  title: d.id,
  enabled_by_default: true,
  steps: [{ send: { body: d.id.toUpperCase() } }],
  ...d,
});

interface Run {
  readonly core: AcarsCore;
  readonly out: OutboundMessage[];
  readonly events: CoreEvent[];
}

function fly(
  defs: readonly ScenarioDef[],
  flags?: Readonly<Record<string, Value>>,
  resumeAt?: number,
): Run {
  const options = {
    ofp,
    scenarios: defs.map(compileScenario),
    seed: 'flags',
    ...(flags === undefined ? {} : { flags }),
  };
  let core = AcarsCore.create(options);
  core.startFlight();
  const out: OutboundMessage[] = [];
  const events: CoreEvent[] = [];
  flight.snapshots.forEach((s, i) => {
    if (i === resumeAt) {
      core = AcarsCore.fromState(JSON.parse(JSON.stringify(core.getState())), options);
    }
    const r = core.tick({
      now: s.t,
      telemetry: s,
      ...(i === 0
        ? {
            data: {
              t: s.t,
              stands: {
                icao: ofp.destination.icao,
                list: ['A1', 'A2', 'A3', 'B1'].map((ref) => ({ ref, kind: 'gate' as const })),
              },
            },
          }
        : {}),
    });
    out.push(...r.outbound);
    events.push(...r.events);
  });
  return { core, out, events };
}

const texts = (r: Run) => r.out.map((m) => m.message.text.replaceAll('\n', ' '));
const sets = (r: Run) => r.events.flatMap((e) => (e.type === 'SET' ? [e] : []));

describe('set: compile', () => {
  const step = (set: Record<string, unknown>) =>
    def({ id: 's', trigger: { on: 'phase_enter', phase: 'CRUISE' }, steps: [{ set } as never] });

  it('accepts flags.*, flight.divert, ops.arr_gate; literals and templates', () => {
    const c = compileScenario(
      step({
        'flags.a': 1,
        'flags.b': 'X {ofp.dest}',
        'flags.c': '{ofp.pax}',
        'flags.d': null,
        'flight.divert': '{ofp.altn}',
        'ops.arr_gate': 'B12',
      }),
    );
    const s = c.steps[0];
    if (s?.kind !== 'set') throw new Error('not a set step');
    expect(s.assigns.map((a) => [a.target, a.value.k])).toEqual([
      ['flags.a', 'lit'],
      ['flags.b', 'tpl'],
      ['flags.c', 'var'],
      ['flags.d', 'lit'],
      ['flight.divert', 'var'],
      ['ops.arr_gate', 'tpl'],
    ]);
  });

  it('rejects other targets, unknown variables, a numeric diversion', () => {
    for (const bad of [
      { 'flight.pax': 1 },
      { 'ofp.dest': 'X' },
      { 'flags.Bad': 1 },
      { 'flags.a': '{calc.x}' },
      { 'flight.divert': 5 },
      {},
    ]) {
      expect(() => compileScenario(step(bad)), JSON.stringify(bad)).toThrow(ScenarioError);
    }
  });

  it('flags.* is a known variable in conditions and templates', () => {
    expect(() =>
      compileScenario(
        def({
          id: 'c',
          trigger: { on: 'phase', phase: 'CRUISE' },
          conditions: ['flags.mel_item != null'],
          steps: [{ send: { body: '{flags.mel_item}' } }],
        }),
      ),
    ).not.toThrow();
  });
});

describe('set: run', () => {
  const setter = def({
    id: 'setter',
    trigger: { on: 'phase_enter', phase: 'CLIMB' },
    steps: [
      { set: { 'flags.n': '{ofp.pax}', 'flags.s': 'PAX {ofp.pax}', 'flags.gone': null } },
      { send: { body: 'N {flags.n} S {flags.s}' } },
    ],
  });
  const reader = def({
    id: 'reader',
    trigger: { on: 'phase', phase: 'CRUISE' },
    conditions: ['flags.n == ofp.pax'],
    steps: [{ send: { body: 'SEEN {flags.n}' } }],
  });

  it('flags are visible at once to the same and to other scenarios; raw values stay typed', () => {
    const r = fly([setter, reader], { gone: 'old', kept: true });
    expect(texts(r)).toEqual([
      `N ${ofp.weights.paxCount} S PAX ${ofp.weights.paxCount}`,
      `SEEN ${ofp.weights.paxCount}`,
    ]);
    expect(r.core.flags).toEqual({
      kept: true,
      n: ofp.weights.paxCount,
      s: `PAX ${ofp.weights.paxCount}`,
    });
    expect(sets(r).map((e) => [e.name, e.value, e.applied])).toEqual([
      ['flags.n', ofp.weights.paxCount, true],
      ['flags.s', `PAX ${ofp.weights.paxCount}`, true],
      ['flags.gone', null, true],
    ]);
  });

  it('the flags option is not changed by the flight; a state round trip keeps them', () => {
    const initial = { kept: true };
    const r = fly([setter, reader], initial, 2_000);
    expect(initial).toEqual({ kept: true });
    expect(r.core.flags['n']).toBe(ofp.weights.paxCount);
    expect(texts(r)).toHaveLength(2);
  });

  it('a diversion applies only in the air and not to the destination', () => {
    const ground = def({
      id: 'ground',
      trigger: { on: 'phase_enter', phase: 'BOARDING' },
      steps: [
        { set: { 'flight.divert': 'RJGG' } },
        { send: { body: 'D {flight.divert|or:NONE}' } },
      ],
    });
    const dest = def({
      id: 'dest',
      trigger: { on: 'phase_enter', phase: 'CRUISE' },
      steps: [{ set: { 'flight.divert': '{ofp.dest}' } }],
    });
    const air = def({
      id: 'air',
      trigger: { on: 'phase_enter', phase: 'DESCENT' },
      steps: [{ set: { 'flight.divert': 'rjgg' } }, { send: { body: 'D {flight.divert}' } }],
    });
    const r = fly([ground, dest, air]);
    expect(sets(r).map((e) => [e.id, e.applied])).toEqual([
      ['ground', false],
      ['dest', false],
      ['air', true],
    ]);
    expect(texts(r)).toEqual(['D NONE', 'D RJGG']);
  });

  it('ops.arr_gate changes the gate for the rest of the flight', () => {
    const move = def({
      id: 'move',
      trigger: { on: 'phase_enter', phase: 'CRUISE' },
      steps: [
        { send: { body: 'OLD {ops.arr_gate} NEW {irr.new_gate}' } },
        { set: { 'ops.arr_gate': '{irr.new_gate}' } },
      ],
    });
    const later = def({
      id: 'later',
      trigger: { on: 'phase_enter', phase: 'DESCENT' },
      steps: [{ send: { body: 'GATE {ops.arr_gate}' } }],
    });
    const bad = def({
      id: 'bad',
      trigger: { on: 'phase_enter', phase: 'CLIMB' },
      steps: [{ set: { 'ops.arr_gate': 'GATE 12' } }],
    });
    const r = fly([move, later, bad], undefined, 4_000);
    const [, oldGate, newGate] = /OLD (\w+) NEW (\w+)/.exec(texts(r)[0] ?? '') ?? [];
    expect(newGate).not.toBe(oldGate);
    expect(texts(r)[1]).toBe(`GATE ${newGate}`);
    expect(sets(r).find((e) => e.id === 'bad')?.applied).toBe(false);
  });

  it('at most 64 flags; longer texts are cut to 80 characters', () => {
    const many = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`f${i}`, i]));
    const add = def({
      id: 'add',
      trigger: { on: 'phase_enter', phase: 'CLIMB' },
      steps: [{ set: { 'flags.extra': 1, 'flags.f0': 'X'.repeat(100) } }],
    });
    const r = fly([add], many);
    expect(sets(r).map((e) => e.applied)).toEqual([false, true]);
    expect(r.core.flags['extra']).toBeUndefined();
    expect(r.core.flags['f0']).toBe('X'.repeat(80));
  });
});

describe('irregular data', () => {
  it('is deterministic per seed and computed from the published schedule', () => {
    expect(buildIrregularData(ofp, 's', 40)).toEqual(buildIrregularData(ofp, 's', 40));
    const d = buildIrregularData(ofp, 's', 40);
    // RJBB has no night curfew (T42: real curfews only).
    expect(d.curfew).toBeNull();
    expect(d.connectStd).toBeGreaterThan(ofp.times.schedInMs);
    expect(d.connectFlight).toMatch(/^SJX\d{3}$/);
    expect(d.tankerKg % 100).toBe(0);
  });

  it('a reassigned gate is never the current one', () => {
    for (let i = 0; i < 50; i++) {
      // No stands, no new gate: nothing is invented (T43).
      expect(reassignedGate('A12', null, i)).toBeNull();
      expect(reassignedGate('2', [{ ref: '2', kind: 'stand' }], i)).toBeNull();
      expect(
        reassignedGate(
          '2',
          [
            { ref: '2', kind: 'stand' },
            { ref: '7', kind: 'stand' },
          ],
          i,
        ),
      ).toBe('7');
    }
  });

  it('METAR temperature', () => {
    expect(metarTempC('EDDF 081350Z 32012KT 9999 16/09 Q1013')).toBe(16);
    expect(metarTempC('UUEE 081350Z 36010KT 2000 -SN M02/M04 Q1002')).toBe(-2);
    expect(metarTempC('XXXX 081350Z 36010KT 9999 Q1002 RMK 10/05')).toBeNull();
    expect(metarTempC(null)).toBeNull();
  });

  it('METAR wind and the direction smoke drifts to (T33)', () => {
    expect(metarWind('EDDF 081350Z 32012KT 9999 16/09 Q1013')).toEqual({ from: 320, kt: 12 });
    expect(metarWind('EDDF 081350Z 27015G25KT 9999 16/09 Q1013')).toEqual({ from: 270, kt: 15 });
    expect(metarWind('ULLI 081350Z 18005MPS 9999 16/09 Q1013')).toEqual({ from: 180, kt: 10 });
    expect(metarWind('LSZH 081350Z 00000KT CAVOK 16/09 Q1013')).toBeNull();
    expect(metarWind('LSZH 081350Z VRB02KT CAVOK 16/09 Q1013')).toBeNull();
    expect(metarWind('XXXX 081350Z 9999 Q1002 RMK 27015KT')).toBeNull();
    expect(metarWind(null)).toBeNull();
    // Wind from the west carries smoke east; from 320 (NW) to SE; from 010 to S.
    expect(smokeDrift('EDDF 081350Z 27015KT 9999 16/09 Q1013')).toBe('E');
    expect(smokeDrift('EDDF 081350Z 32012KT 9999 16/09 Q1013')).toBe('SE');
    expect(smokeDrift('EDDF 081350Z 01012KT 9999 16/09 Q1013')).toBe('S');
    expect(smokeDrift('EDDF 081350Z 18012KT 9999 16/09 Q1013')).toBe('N');
    expect(smokeDrift(null)).toBeNull();
  });
});

describe('forced start (run now)', () => {
  const evt = def({
    id: 'evt',
    trigger: { on: 'phase_enter', phase: 'DESCENT' },
    conditions: ["phase in ['CLIMB','CRUISE']"],
    probability: 0,
    steps: [
      { send: { body: 'EVT {phase}' } },
      { wait: { minutes: 30 } },
      { send: { body: 'END' } },
    ],
  });

  function run(forceAt: readonly number[], lostFrom?: number) {
    const core = AcarsCore.create({ ofp, scenarios: [compileScenario(evt)], seed: 'f' });
    core.startFlight();
    const out: OutboundMessage[] = [];
    const events: ScenarioEvent[] = [];
    flight.snapshots.forEach((s, i) => {
      const lost = lostFrom !== undefined && i >= lostFrom && i < lostFrom + 120;
      const force = forceAt.filter((x) => x === i).map(() => 'evt');
      const r = core.tick({
        now: s.t,
        telemetry: lost ? null : s,
        ...(force.length > 0 ? { force } : {}),
      });
      out.push(...r.outbound);
      for (const e of r.events) if (e.type === 'FORCED') events.push(e);
    });
    return { out, events };
  }
  const cruise = flight.snapshots.findIndex((s) => s.altFt > 30_000) + 60;

  it('starts without trigger and probability when the conditions hold', () => {
    const r = run([cruise]);
    expect(r.out.map((m) => m.message.text)).toEqual(['EVT CLIMB', 'END']);
    expect(r.events).toEqual([
      expect.objectContaining({ id: 'evt', result: 'started', detail: null }),
    ]);
  });

  it('refuses on failed conditions, while running, for unknown ids', () => {
    const atGate = run([5]);
    expect(atGate.out).toEqual([]);
    expect(atGate.events[0]).toMatchObject({
      result: 'conditions',
      detail: "phase in ['CLIMB','CRUISE']",
    });
    const twice = run([cruise, cruise + 10]);
    expect(twice.events.map((e) => (e as { result: string }).result)).toEqual([
      'started',
      'running',
    ]);
    const core = AcarsCore.create({ ofp, scenarios: [], seed: 'f' });
    core.startFlight();
    const s = flight.snapshots[0] as (typeof flight.snapshots)[number];
    expect(core.tick({ now: s.t, telemetry: s, force: ['ghost'] }).events).toContainEqual(
      expect.objectContaining({ type: 'FORCED', id: 'ghost', result: 'unknown' }),
    );
  });

  it('waits while telemetry is lost', () => {
    const r = run([cruise + 30], cruise);
    expect(r.events).toEqual([expect.objectContaining({ result: 'started' })]);
    expect(r.out[0]?.t).toBeGreaterThan((flight.snapshots[cruise + 30] as { t: number }).t);
  });
});
