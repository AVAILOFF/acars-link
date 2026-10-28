// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AcarsCore,
  type CompiledScenario,
  compileScenario,
  compileTemplate,
  createRng,
  generateSyntheticFlight,
  type OutboundMessage,
  parseSimbriefOfp,
  type ScenarioDef,
  ScenarioError,
} from '../src/index.js';

/** T50: the `draw`, `loop`, `break` and `if` steps and `wait: reply` with `timeout_round`. */

const ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'ofp', 'rctp-rjbb-a35k-kgs.json'), 'utf8'),
  ),
);
const flight = generateSyntheticFlight({ ofp });
const MIN = 60_000;

const def = (d: Partial<ScenarioDef> & Pick<ScenarioDef, 'id' | 'steps'>): ScenarioDef => ({
  version: 1,
  category: 'ops',
  title: d.id,
  enabled_by_default: true,
  trigger: { on: 'phase_enter', phase: 'CRUISE' },
  ...d,
});

/** A loop that sends TICK at every round, ends after `n` minutes; A / B are the answers. */
const looper = (n: number | string): CompiledScenario =>
  compileScenario(
    def({
      id: 'looper',
      steps: [
        { draw: [{ set: { 'run.n': typeof n === 'number' ? [n, n] : n } }] },
        {
          loop: {
            until: 'loop.min >= run.n',
            stop: 'flight.divert != null',
            every_min: 1,
            steps: [
              { wait: { reply: { options: ['A', 'B'], timeout_round: true, default: 'A' } } },
              {
                branch: {
                  A: [{ if: 'reply.timeout', steps: [{ send: { body: 'TICK {loop.min}' } }] }],
                  B: [{ send: { body: 'BRK' } }, { break: true }],
                },
              },
            ],
          },
        },
        { branch: { MET: [{ send: { body: 'DONE' } }], B: [{ send: { body: 'AFTERB' } }] } },
        { send: { body: 'END {reply.option}' } },
      ],
    }),
  );

interface Answer {
  /** Minutes after the first question when the pilot answers. */
  readonly afterMin: number;
  readonly text: string;
}

function fly(sc: CompiledScenario, answers: readonly Answer[] = []) {
  const core = AcarsCore.create({ ofp, scenarios: [sc], seed: 'loop' });
  core.startFlight();
  const out: OutboundMessage[] = [];
  let asked: number | null = null;
  const done = new Set<Answer>();
  for (const s of flight.snapshots) {
    const inbound = answers
      .filter((a) => !done.has(a) && asked !== null && s.t >= asked + a.afterMin * MIN)
      .map((a) => {
        done.add(a);
        return { from: ofp.callsign, type: 'telex', text: a.text };
      });
    const r = core.tick({ now: s.t, telemetry: s, ...(inbound.length > 0 ? { inbound } : {}) });
    out.push(...r.outbound);
    if (asked === null && r.events.some((e) => e.type === 'REPLY_EXPECTED')) asked = s.t;
  }
  return { core, out, texts: out.map((m) => m.message.text) };
}

describe('loop with rounds', () => {
  it('repeats until the condition holds, then goes on with MET', () => {
    const r = fly(looper(3));
    // Rounds end at minutes 1 and 2; at minute 3 the loop ends instead of another round.
    expect(r.texts).toEqual(['TICK 1', 'TICK 2', 'DONE', 'END MET']);
  });

  it('an answer in between is no new round: the next one comes on the grid', () => {
    const r = fly(looper(3), [{ afterMin: 0.5, text: 'A' }]);
    expect(r.texts).toEqual(['TICK 1', 'TICK 2', 'DONE', 'END MET']);
    const at = r.out.map((m) => m.t);
    // The ticks are a minute apart, whatever the pilot said.
    expect((at[1] as number) - (at[0] as number)).toBeGreaterThanOrEqual(MIN);
    expect((at[1] as number) - (at[0] as number)).toBeLessThan(MIN + 30_000);
  });

  it('break leaves the loop with the last answer', () => {
    const r = fly(looper(30), [{ afterMin: 1.5, text: 'B' }]);
    expect(r.texts).toEqual(['TICK 1', 'BRK', 'AFTERB', 'END B']);
  });

  it('stop ends it without MET', () => {
    const sc = compileScenario(
      def({
        id: 'stopper',
        steps: [
          {
            loop: {
              until: 'loop.min >= 600',
              stop: "phase in ['DESCENT']",
              steps: [{ wait: { minutes: 1 } }],
            },
          },
          { branch: { STOP: [{ send: { body: 'STOPPED' } }], MET: [{ send: { body: 'MET' } }] } },
        ],
      }),
    );
    expect(fly(sc).texts).toEqual(['STOPPED']);
  });

  it('survives a serialized state in the middle of the loop', () => {
    const sc = looper(3);
    const a = AcarsCore.create({ ofp, scenarios: [sc], seed: 'loop' });
    a.startFlight();
    let b: AcarsCore | null = null;
    const texts: string[] = [];
    let n = 0;
    for (const s of flight.snapshots) {
      const core = b ?? a;
      const r = core.tick({ now: s.t, telemetry: s });
      texts.push(...r.outbound.map((m) => m.message.text));
      if (b === null && texts.length === 1 && ++n === 1) {
        b = AcarsCore.fromState(JSON.parse(JSON.stringify(a.getState())), {
          ofp,
          scenarios: [sc],
          seed: 'loop',
        });
      }
    }
    expect(texts).toEqual(['TICK 1', 'TICK 2', 'DONE', 'END MET']);
  });
});

describe('draw', () => {
  const drawn = (seed: string) => {
    const sc = compileScenario(
      def({
        id: 'dice',
        trigger: { on: 'phase', phase: 'BOARDING' },
        steps: [
          {
            draw: [
              { weight: 3, set: { 'run.kind': 'SHORT', 'run.len': [5, 9] } },
              { weight: 1, set: { 'run.kind': 'LONG', 'run.len': [100, 120], 'run.flag': true } },
            ],
          },
          { send: { body: '{run.kind} {run.len} {run.flag|or:NO}' } },
        ],
      }),
    );
    const core = AcarsCore.create({ ofp, scenarios: [sc], seed });
    core.startFlight();
    for (const s of flight.snapshots) {
      const r = core.tick({ now: s.t, telemetry: s });
      if (r.outbound.length > 0) return (r.outbound[0] as OutboundMessage).message.text;
    }
    return '';
  };

  it('is the same for the same seed, in range, by weight, null for a name not drawn', () => {
    const all = Array.from({ length: 120 }, (_, i) => drawn(`s${i}`));
    expect(drawn('s7')).toBe(drawn('s7'));
    let long = 0;
    for (const t of all) {
      const m = /^(SHORT|LONG) (\d+) (\w+)$/.exec(t.replaceAll('\n', ' '));
      expect(m, t).not.toBeNull();
      const len = Number(m?.[2]);
      if (m?.[1] === 'SHORT') {
        expect(len).toBeGreaterThanOrEqual(5);
        expect(len).toBeLessThanOrEqual(9);
        expect(m?.[3]).toBe('NO');
      } else {
        long++;
        expect(len).toBeGreaterThanOrEqual(100);
        expect(len).toBeLessThanOrEqual(120);
        expect(m?.[3]).toBe('TRUE');
      }
    }
    // One in four (30 of 120), give or take.
    expect(long).toBeGreaterThan(12);
    expect(long).toBeLessThan(55);
  });
});

describe('compile errors', () => {
  const bad = (steps: ScenarioDef['steps']) => () => compileScenario(def({ id: 'bad', steps }));

  it('break only inside a loop', () => {
    expect(bad([{ break: true }])).toThrow(ScenarioError);
  });

  it('no loop inside a loop', () => {
    const inner = { loop: { until: 'true', steps: [{ wait: { minutes: 1 } }] } };
    expect(bad([{ loop: { until: 'false', steps: [inner] } }])).toThrow(/inside a loop/);
  });

  it('a loop needs a wait or it would spin', () => {
    expect(bad([{ loop: { until: 'false', steps: [{ send: { body: 'X' } }] } }])).toThrow(
      /needs a wait/,
    );
  });

  it('timeout_round needs a loop with every_min', () => {
    const wait = {
      wait: { reply: { options: ['A'], timeout_round: true as const, default: 'A' } },
    };
    expect(bad([wait])).toThrow(/every_min/);
    expect(bad([{ loop: { until: 'false', steps: [wait] } }])).toThrow(/every_min/);
  });

  it('draw names are run.<name>, ranges are integers min <= max', () => {
    expect(bad([{ draw: [{ set: { 'flags.x': 1 } }] }, { send: { body: 'X' } }])).toThrow(/run\./);
    expect(bad([{ draw: [{ set: { 'run.x': [5, 1] } }] }, { send: { body: 'X' } }])).toThrow(
      /range/,
    );
  });
});

describe('template additions (T50, T51)', () => {
  const look = (vars: Record<string, string | number | null>) => (path: string) =>
    path in vars ? vars[path] : undefined;
  const rng = createRng('t');

  it('|else:var takes the other variable when the value is missing', () => {
    const t = compileTemplate('{a.x|else:a.y}');
    expect([...t.vars].sort()).toEqual(['a.x', 'a.y']);
    expect(t.render(look({ 'a.x': null, 'a.y': 'B' }), rng)).toBe('B');
    expect(t.render(look({ 'a.x': 'A', 'a.y': 'B' }), rng)).toBe('A');
    expect(() => compileTemplate('{a.x|else:nope}')).toThrow(/variable/);
    expect(() => compileTemplate('{a.x|else}')).toThrow(/argument/);
  });

  it('a line that starts with ~ is left out when it has a missing value', () => {
    const t = compileTemplate('ONE\n~{a.n} NM FROM POS\nTWO');
    expect(t.render(look({ 'a.n': 12 }), rng)).toBe('ONE\n12 NM FROM POS\nTWO');
    expect(t.render(look({ 'a.n': null }), rng)).toBe('ONE\nTWO');
    // A source without ~ lines is rendered as before, a missing value is ----.
    expect(compileTemplate('{a.n} NM').render(look({ 'a.n': null }), rng)).toBe('---- NM');
  });

  it('|plusmin:N moves a time by minutes', () => {
    const t = compileTemplate('{a.t|plusmin:20|hhmm}');
    expect(t.render(look({ 'a.t': Date.UTC(2026, 9, 15, 10, 50) }), rng)).toBe('1110');
    expect(t.render(look({ 'a.t': null }), rng)).toBe('----');
  });
});
