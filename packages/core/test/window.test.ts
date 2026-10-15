import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AcarsCore,
  type CompiledScenario,
  type CoreEvent,
  compileScenario,
  generateSyntheticFlight,
  type OutboundMessage,
  parseSimbriefOfp,
  type ScenarioDef,
  ScenarioError,
  type SyntheticFlight,
  stageIndex,
  withPause,
  withSimRate,
} from '../src/index.js';

/** T51: the random start inside a phase (`trigger.window`). */

const ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'ofp', 'rctp-rjbb-a35k-kgs.json'), 'utf8'),
  ),
);
const normal = generateSyntheticFlight({ ofp });

const def = (d: Partial<ScenarioDef> & Pick<ScenarioDef, 'id'>): ScenarioDef => ({
  version: 1,
  category: 'irregular',
  title: d.id,
  enabled_by_default: true,
  trigger: { on: 'phase', phase: 'CRUISE', window: { after_min: 10, before_tod_min: 30 } },
  steps: [{ send: { body: 'GO {flight.minutes_to_tod}' } }],
  ...d,
});

/** Tells `flight.minutes_to_tod` at the tick the trigger fires (no window). */
const probe = compileScenario(
  def({
    id: 'zz_probe',
    trigger: { on: 'phase', phase: 'CRUISE' },
    steps: [{ send: { body: 'T0 {flight.minutes_to_tod}' } }],
  }),
);

interface Result {
  readonly out: OutboundMessage[];
  readonly events: CoreEvent[];
  readonly core: AcarsCore;
}

function fly(
  scenarios: readonly CompiledScenario[],
  o: { seed?: string; flight?: SyntheticFlight; force?: { at: number; ids: string[] } } = {},
): Result {
  const flight = o.flight ?? normal;
  const core = AcarsCore.create({ ofp, scenarios, seed: o.seed ?? 'win' });
  core.startFlight();
  const out: OutboundMessage[] = [];
  const events: CoreEvent[] = [];
  flight.snapshots.forEach((s, i) => {
    const forced = o.force !== undefined && i === o.force.at ? { force: o.force.ids } : {};
    const r = core.tick({ now: s.t, telemetry: s, ...forced });
    out.push(...r.outbound);
    events.push(...r.events);
  });
  return { out, events, core };
}

const num = (r: Result, prefix: string): number =>
  Number(
    r.out
      .find((m) => m.message.text.startsWith(prefix))
      ?.message.text.slice(prefix.length)
      .trim(),
  );

describe('random start in the cruise', () => {
  const win = compileScenario(def({ id: 'win' }));

  it('starts between 10 min after the trigger and 30 min before the top of descent', () => {
    const t0 = num(fly([win, probe]), 'T0');
    expect(t0).toBeGreaterThan(60);
    const starts: number[] = [];
    for (let i = 0; i < 12; i++) starts.push(num(fly([win], { seed: `s${i}` }), 'GO'));
    for (const m of starts) {
      expect(m).toBeLessThanOrEqual(t0 - 10);
      expect(m).toBeGreaterThanOrEqual(29);
    }
    // Spread over the window, not at one end.
    expect(Math.max(...starts) - Math.min(...starts)).toBeGreaterThan((t0 - 40) / 3);
  });

  it('is deterministic by seed', () => {
    expect(fly([win], { seed: 'x' }).out.map((m) => m.t)).toEqual(
      fly([win], { seed: 'x' }).out.map((m) => m.t),
    );
  });

  it('the same place on the route with a pause and ×4: it counts the way, not the clock', () => {
    const slow = withSimRate(
      withPause(normal, { atIndex: stageIndex(normal, 'CRUISE', 600), durationSec: 600 }),
      {
        fromIndex: stageIndex(normal, 'CRUISE', 900),
        toIndex: stageIndex(normal, 'CRUISE', 2400),
        rate: 4,
      },
    );
    for (const seed of ['a', 'b', 'c']) {
      const a = num(fly([win], { seed }), 'GO');
      const b = num(fly([win], { seed, flight: slow }), 'GO');
      expect(Math.abs(a - b), seed).toBeLessThanOrEqual(2);
    }
  });

  it('a probability of 0 never waits; the dice are the ones of a plain start', () => {
    const none = compileScenario(def({ id: 'win', probability: 0 }));
    const r = fly([none]);
    expect(r.out).toEqual([]);
    expect(r.events).toContainEqual(
      expect.objectContaining({ type: 'SCENARIO_SKIPPED', reason: 'probability' }),
    );
  });

  it('a cruise shorter than the window starts nothing', () => {
    const long = compileScenario(
      def({
        id: 'win',
        trigger: { on: 'phase', phase: 'CRUISE', window: { after_min: 10, before_tod_min: 500 } },
      }),
    );
    const r = fly([long]);
    expect(r.out).toEqual([]);
    expect(r.events).toContainEqual(
      expect.objectContaining({ type: 'SCENARIO_SKIPPED', id: 'win', reason: 'window' }),
    );
  });

  it('the conditions are looked at again at the moment', () => {
    // `a_win` waits; `b_set` sets a flag on the same tick that its own condition forbids.
    const a = compileScenario(def({ id: 'a_win', conditions: ['flags.blocked == null'] }));
    const b = compileScenario(
      def({
        id: 'b_set',
        trigger: { on: 'phase', phase: 'CRUISE' },
        steps: [{ set: { 'flags.blocked': 1 } }],
      }),
    );
    const r = fly([a, b]);
    expect(r.out.filter((m) => m.scenarioId === 'a_win')).toEqual([]);
    expect(r.events).toContainEqual(
      expect.objectContaining({ type: 'SCENARIO_SKIPPED', id: 'a_win', reason: 'conditions' }),
    );
  });

  it('exclusions are looked at again: the one whose moment comes first wins', () => {
    const a = compileScenario(def({ id: 'a_win', excludes: ['b_win'] }));
    const b = compileScenario(def({ id: 'b_win', excludes: ['a_win'] }));
    for (const seed of ['p', 'q', 'r', 's']) {
      const r = fly([a, b], { seed });
      expect(new Set(r.out.map((m) => m.scenarioId)).size, seed).toBe(1);
      expect(r.events).toContainEqual(
        expect.objectContaining({ type: 'SCENARIO_SKIPPED', reason: 'excluded' }),
      );
    }
  });

  it('survives a saved state in the middle of the wait', () => {
    const base = fly([win], { seed: 'save' });
    const first = base.out[0] as OutboundMessage;
    const mid = stageIndex(normal, 'CRUISE', 120);
    const core = AcarsCore.create({ ofp, scenarios: [win], seed: 'save' });
    core.startFlight();
    const out: OutboundMessage[] = [];
    let live = core;
    normal.snapshots.forEach((s, i) => {
      if (i === mid) {
        live = AcarsCore.fromState(JSON.parse(JSON.stringify(live.getState())), {
          ofp,
          scenarios: [win],
          seed: 'save',
        });
      }
      out.push(...live.tick({ now: s.t, telemetry: s }).outbound);
    });
    expect(out.map((m) => m.t)).toEqual([first.t]);
  });

  it('the run-now request starts at once, without the window', () => {
    const idx = stageIndex(normal, 'CRUISE', 30);
    const r = fly([win], { force: { at: idx, ids: ['win'] } });
    const at = (normal.snapshots[idx] as { t: number }).t;
    expect(r.out[0]?.t).toBe(at);
    expect(r.events).toContainEqual(expect.objectContaining({ type: 'FORCED', result: 'started' }));
  });

  it('only for on: phase, with non-negative numbers', () => {
    expect(() =>
      compileScenario(
        def({
          id: 'bad',
          trigger: {
            on: 'phase_enter',
            phase: 'CRUISE',
            window: { after_min: 1, before_tod_min: 1 },
          } as never,
        }),
      ),
    ).toThrow(ScenarioError);
    expect(() =>
      compileScenario(
        def({
          id: 'bad',
          trigger: { on: 'phase', phase: 'CRUISE', window: { after_min: -1, before_tod_min: 1 } },
        }),
      ),
    ).toThrow(/window/);
  });
});
