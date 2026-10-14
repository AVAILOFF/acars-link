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
  type ScenarioGroups,
  type SyntheticFlight,
  stageIndex,
  withGap,
  withGroups,
  withPause,
  withSimRate,
} from '../src/index.js';

/** T39: `wait: until` (with `branch` on MET / TIMEOUT) and scenario groups. */

const ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'ofp', 'rctp-rjbb-a35k-kgs.json'), 'utf8'),
  ),
);
const normal = generateSyntheticFlight({ ofp });
const MIN = 60_000;

const def = (d: Partial<ScenarioDef> & Pick<ScenarioDef, 'id' | 'trigger'>): ScenarioDef => ({
  version: 1,
  category: 'ops',
  title: d.id,
  enabled_by_default: true,
  steps: [{ send: { body: d.id.toUpperCase() } }],
  ...d,
});

interface Result {
  readonly core: AcarsCore;
  readonly out: OutboundMessage[];
  readonly events: CoreEvent[];
}

function fly(
  scenarios: readonly CompiledScenario[],
  flight: SyntheticFlight = normal,
  from = 0,
  to = flight.snapshots.length,
  core = AcarsCore.create({ ofp, scenarios, seed: 'until' }),
  force: { readonly at: number; readonly ids: readonly string[] } | null = null,
): Result {
  if (from === 0) core.startFlight();
  const out: OutboundMessage[] = [];
  const events: CoreEvent[] = [];
  flight.snapshots.slice(from, to).forEach((s, i) => {
    const forced = force !== null && from + i === force.at ? { force: force.ids } : {};
    const r = core.tick({ now: s.t, telemetry: s, ...forced });
    out.push(...r.outbound);
    events.push(...r.events);
  });
  return { core, out, events };
}

const texts = (r: Result) => r.out.map((m) => m.message.text.replaceAll('\n', ' '));
const timeOf = (r: Result, text: string) =>
  r.out.find((m) => m.message.text === text)?.t ?? Number.NaN;
const phaseAt = (r: Result, to: string) =>
  r.events.find((e) => e.type === 'PHASE_CHANGE' && e.to === to)?.t ?? Number.NaN;

/** Starts at the beginning of the cruise, waits for `until`, tells the outcome. */
const waiting = (until: string, timeoutMin: number): CompiledScenario =>
  compileScenario(
    def({
      id: 'wait',
      trigger: { on: 'phase_enter', phase: 'CRUISE' },
      steps: [
        { send: { body: 'START' } },
        { wait: { until, timeout_min: timeoutMin } },
        {
          branch: {
            MET: [{ send: { body: 'MET {reply.timeout}' } }],
            TIMEOUT: [{ send: { body: 'TIMEOUT {reply.timeout}' } }],
          },
        },
        { send: { body: 'END {reply.option}' } },
      ],
    }),
  );
const NEVER = 'tm.alt_ft > 100000';

describe('wait: until', () => {
  it('goes on with MET when the condition holds, at the tick it turns true', () => {
    const r = fly([waiting("phase in ['DESCENT']", 600)]);
    expect(texts(r)).toEqual(['START', 'MET FALSE', 'END MET']);
    expect(timeOf(r, 'MET FALSE')).toBe(phaseAt(r, 'DESCENT'));
    expect(r.events).toContainEqual({
      type: 'WAIT_UNTIL',
      id: 'wait',
      t: phaseAt(r, 'DESCENT'),
      result: 'MET',
    });
  });

  it('a condition that already holds does not wait', () => {
    const r = fly([waiting("phase in ['CRUISE']", 600)]);
    expect(texts(r)).toEqual(['START', 'MET FALSE', 'END MET']);
    expect(timeOf(r, 'MET FALSE')).toBe(timeOf(r, 'START'));
  });

  it('takes TIMEOUT after timeout_min of flight time, like wait: minutes', () => {
    const r = fly([waiting(NEVER, 30)]);
    expect(texts(r)).toEqual(['START', 'TIMEOUT TRUE', 'END TIMEOUT']);
    const plain = fly([
      compileScenario(
        def({
          id: 'wait',
          trigger: { on: 'phase_enter', phase: 'CRUISE' },
          steps: [{ send: { body: 'START' } }, { wait: { minutes: 30 } }, { send: { body: 'GO' } }],
        }),
      ),
    ]);
    expect(timeOf(r, 'TIMEOUT TRUE')).toBe(timeOf(plain, 'GO'));
    expect(r.events.filter((e) => e.type === 'WAIT_UNTIL')).toEqual([
      expect.objectContaining({ result: 'TIMEOUT' }),
    ]);
  });

  it('a condition met on the last tick wins over the timeout', () => {
    // The condition turns true when the flight enters DESCENT; the timeout is set just after it.
    const base = fly([waiting("phase in ['DESCENT']", 600)]);
    const gap = (phaseAt(base, 'DESCENT') - timeOf(base, 'START')) / MIN;
    const r = fly([waiting("phase in ['DESCENT']", gap + 0.5)]);
    expect(texts(r)[1]).toBe('MET FALSE');
  });

  it('a pause does not count: the timeout moves by the length of the pause', () => {
    const at = stageIndex(normal, 'CRUISE', 600);
    const paused = withPause(normal, { atIndex: at, durationSec: 20 * 60 });
    const a = fly([waiting(NEVER, 30)]);
    const b = fly([waiting(NEVER, 30)], paused);
    expect(timeOf(b, 'TIMEOUT TRUE') - timeOf(a, 'TIMEOUT TRUE')).toBe(20 * MIN);
  });

  it('×4 sim rate: the timeout comes after a quarter of the wall-clock time', () => {
    const from = stageIndex(normal, 'CRUISE', -120);
    const fast = withSimRate(normal, { fromIndex: from, toIndex: from + 3600, rate: 4 });
    const r = fly([waiting(NEVER, 30)], fast);
    const took = timeOf(r, 'TIMEOUT TRUE') - timeOf(r, 'START');
    expect(Math.abs(took - 7.5 * MIN)).toBeLessThanOrEqual(MIN);
  });

  it('is not evaluated while telemetry is lost; resolves when it is back', () => {
    const i = stageIndex(normal, 'CRUISE', 1800);
    const at = normal.snapshots[i + 60]?.t ?? 0;
    const gapped = withGap(normal, { atIndex: i, durationSec: 300 });
    const r = fly([waiting(`flight.now >= ${at}`, 600)], gapped);
    const restored = r.events.find((e) => e.type === 'TELEMETRY_RESTORED');
    expect(restored).toBeDefined();
    expect(texts(r)).toEqual(['START', 'MET FALSE', 'END MET']);
    expect(timeOf(r, 'MET FALSE')).toBe(restored?.t);
  });

  it('serializes in the middle of the wait', () => {
    const c = waiting("phase in ['DESCENT']", 600);
    const full = fly([c]);
    const cut = stageIndex(normal, 'CRUISE', 900);
    const first = fly([c], normal, 0, cut);
    const run = first.core.getState().engine.runs[0];
    expect(run?.until).not.toBeNull();
    const resumed = AcarsCore.fromState(JSON.parse(JSON.stringify(first.core.getState())), {
      ofp,
      scenarios: [c],
      seed: 'until',
    });
    const second = fly([c], normal, cut, normal.snapshots.length, resumed);
    expect([...first.out, ...second.out]).toEqual(full.out);
    expect([...first.events, ...second.events]).toEqual(full.events);
  });

  it('serializes in the middle of a timeout wait too', () => {
    const c = waiting(NEVER, 30);
    const full = fly([c]);
    const cut = stageIndex(normal, 'CRUISE', 900);
    const first = fly([c], normal, 0, cut);
    const resumed = AcarsCore.fromState(JSON.parse(JSON.stringify(first.core.getState())), {
      ofp,
      scenarios: [c],
      seed: 'until',
    });
    const second = fly([c], normal, cut, normal.snapshots.length, resumed);
    expect([...first.out, ...second.out]).toEqual(full.out);
  });

  it('a state saved before wait: until (runs without `until`) still loads', () => {
    const c = waiting(NEVER, 30);
    const core = AcarsCore.create({ ofp, scenarios: [c], seed: 'until' });
    const state = JSON.parse(JSON.stringify(core.getState()));
    expect(() => AcarsCore.fromState(state, { ofp, scenarios: [c], seed: 'until' })).not.toThrow();
  });

  it('a branch can follow wait: until with a third step that waits again', () => {
    const c = compileScenario(
      def({
        id: 'two',
        trigger: { on: 'phase_enter', phase: 'CRUISE' },
        steps: [
          { wait: { until: "phase in ['DESCENT']", timeout_min: 600 } },
          { branch: { MET: [{ send: { body: 'DOWN' } }] } },
          { wait: { until: "phase in ['LANDED']", timeout_min: 600 } },
          {
            branch: { MET: [{ send: { body: 'LANDED' } }], TIMEOUT: [{ send: { body: 'LOST' } }] },
          },
        ],
      }),
    );
    expect(texts(fly([c]))).toEqual(['DOWN', 'LANDED']);
  });

  describe('compile', () => {
    const base = def({ id: 'x', trigger: { on: 'phase_enter', phase: 'CRUISE' } });
    const steps = (s: ScenarioDef['steps']) => () => compileScenario({ ...base, steps: s });

    it('accepts MET / TIMEOUT arms', () => {
      expect(
        steps([
          { wait: { until: 'tm.alt_ft > 1', timeout_min: 5 } },
          { branch: { MET: [{ send: { body: 'A' } }], TIMEOUT: [{ send: { body: 'B' } }] } },
        ]),
      ).not.toThrow();
    });

    it.each<[string, ScenarioDef['steps']]>([
      [
        'an arm that is not an outcome',
        [
          { wait: { until: 'tm.alt_ft > 1', timeout_min: 5 } },
          { branch: { YES: [{ send: { body: 'A' } }] } },
        ],
      ],
      ['zero timeout', [{ wait: { until: 'tm.alt_ft > 1', timeout_min: 0 } }]],
      ['bad expression', [{ wait: { until: 'tm.alt_ft >', timeout_min: 5 } }]],
      ['unknown variable', [{ wait: { until: 'tm.nope > 1', timeout_min: 5 } }]],
    ])('rejects %s', (_, s) => {
      expect(steps(s)).toThrow(ScenarioError);
    });

    it('a branch on a reply arm does not accept MET after a wait: reply', () => {
      expect(
        steps([
          { wait: { reply: { options: ['YES'], timeout_min: 5, default: 'YES' } } },
          { branch: { MET: [{ send: { body: 'A' } }] } },
        ]),
      ).toThrow(ScenarioError);
    });
  });
});

describe('scenario groups', () => {
  const groups: ScenarioGroups = { news: { max_per_flight: 1 }, pair: { max_per_flight: 2 } };
  const member = (id: string, group: string, extra: Partial<ScenarioDef> = {}) =>
    withGroups(
      compileScenario(
        def({ id, group, trigger: { on: 'phase_enter', phase: 'CRUISE' }, ...extra }),
      ),
      groups,
    );
  const skipped = (r: Result, id: string) =>
    r.events.flatMap((e) => (e.type === 'SCENARIO_SKIPPED' && e.id === id ? [e.reason] : []));

  it('one message per flight from a group of 1; the rest are skipped like excluded', () => {
    const r = fly([member('b', 'news'), member('a', 'news'), member('c', 'news')]);
    expect(r.out.map((m) => m.scenarioId)).toEqual(['a']);
    expect(skipped(r, 'b')).toEqual(['excluded']);
    expect(skipped(r, 'c')).toEqual(['excluded']);
  });

  it('priority decides who of the group goes', () => {
    const r = fly([member('a', 'news'), member('b', 'news', { priority: 3 })]);
    expect(r.out.map((m) => m.scenarioId)).toEqual(['b']);
  });

  it('a later member does not start either, after the first one is done', () => {
    const r = fly([
      member('a', 'news'),
      member('late', 'news', { trigger: { on: 'phase_enter', phase: 'DESCENT' } }),
    ]);
    expect(r.out.map((m) => m.scenarioId)).toEqual(['a']);
    expect(skipped(r, 'late')).toEqual(['excluded']);
  });

  it('max_per_flight 2 lets two start', () => {
    const r = fly([member('a', 'pair'), member('b', 'pair'), member('c', 'pair')]);
    expect(r.out.map((m) => m.scenarioId)).toEqual(['a', 'b']);
  });

  it('a force start passes the limit', () => {
    const r = fly(
      [
        member('a', 'news'),
        member('b', 'news', { trigger: { on: 'phase_enter', phase: 'DESCENT' } }),
      ],
      normal,
      0,
      normal.snapshots.length,
      undefined,
      { at: stageIndex(normal, 'CRUISE', 1800), ids: ['b'] },
    );
    expect(r.out.map((m) => m.scenarioId)).toEqual(['a', 'b']);
  });

  it('groups are independent of each other and of scenarios without one', () => {
    const r = fly([
      member('a', 'news'),
      member('b', 'pair'),
      compileScenario(def({ id: 'solo', trigger: { on: 'phase_enter', phase: 'CRUISE' } })),
    ]);
    expect(r.out.map((m) => m.scenarioId)).toEqual(['a', 'b', 'solo']);
  });

  it('the count survives getState → fromState', () => {
    const a = member('a', 'news');
    const late = member('late', 'news', { trigger: { on: 'phase_enter', phase: 'DESCENT' } });
    const cut = stageIndex(normal, 'CRUISE', 600);
    const first = fly([a, late], normal, 0, cut);
    const resumed = AcarsCore.fromState(JSON.parse(JSON.stringify(first.core.getState())), {
      ofp,
      scenarios: [a, late],
      seed: 'until',
    });
    const second = fly([a, late], normal, cut, normal.snapshots.length, resumed);
    expect(second.out).toEqual([]);
    expect(skipped(second, 'late')).toEqual(['excluded']);
  });

  it('rejects a group that is not described', () => {
    expect(() =>
      withGroups(
        compileScenario(
          def({ id: 'x', group: 'nope', trigger: { on: 'phase_enter', phase: 'CRUISE' } }),
        ),
        groups,
      ),
    ).toThrow(ScenarioError);
  });

  it('without a table of groups the name is only checked for its form (no limit)', () => {
    const c = compileScenario(
      def({ id: 'x', group: 'news', trigger: { on: 'phase_enter', phase: 'CRUISE' } }),
    );
    expect(c.groupMax).toBeNull();
    expect(() =>
      compileScenario(
        def({ id: 'x', group: 'Bad Name', trigger: { on: 'phase_enter', phase: 'CRUISE' } }),
      ),
    ).toThrow(ScenarioError);
  });
});
