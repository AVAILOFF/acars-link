import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AcarsCore,
  B78X_PROFILE,
  type CoreOptions,
  checkText,
  compileScenario,
  DEFAULT_PROFILE,
  generateSyntheticFlight,
  type OutboundMessage,
  type PhaseEvent,
  parseSimbriefOfp,
  type ScenarioDef,
  ScenarioError,
  type ScenarioEvent,
  type SyntheticFlight,
  stageIndex,
  stationCallsign,
  withGap,
  withSimRate,
} from '../src/index.js';

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
  steps: [{ send: { body: `${d.id.toUpperCase()} {phase}` } }],
  ...d,
});

interface Result {
  readonly core: AcarsCore;
  readonly out: OutboundMessage[];
  readonly events: (PhaseEvent | ScenarioEvent)[];
}

function fly(
  defs: readonly ScenarioDef[],
  flight: SyntheticFlight = normal,
  opts: Partial<CoreOptions> = {},
  core = AcarsCore.create({ ofp, scenarios: defs.map(compileScenario), ...opts }),
  from = 0,
  to = flight.snapshots.length,
): Result {
  if (from === 0) core.startFlight();
  const out: OutboundMessage[] = [];
  const events: (PhaseEvent | ScenarioEvent)[] = [];
  for (const s of flight.snapshots.slice(from, to)) {
    const r = core.tick({ now: s.t, telemetry: s });
    out.push(...r.outbound);
    events.push(...r.events);
  }
  return { core, out, events };
}

const sent = (r: Result, id: string) => r.out.filter((m) => m.scenarioId === id);
const phaseAt = (r: Result, to: string) =>
  r.events.find((e) => e.type === 'PHASE_CHANGE' && e.to === to)?.t ?? Number.NaN;
const skipped = (r: Result, id: string) =>
  r.events.flatMap((e) => (e.type === 'SCENARIO_SKIPPED' && e.id === id ? [e.reason] : []));

describe('triggers', () => {
  const r = fly([
    def({
      id: 'prelim',
      trigger: { on: 'time', at: { rel: 'sched_out', offset_min: -25 } },
      conditions: ["phase in ['PREFLIGHT','BOARDING']"],
      steps: [
        {
          send: {
            header: 'Preliminary loadsheet',
            body: '{ofp.callsign} {ofp.orig}-{ofp.dest} {flight.date|ddmmm}\nZFW {ofp.zfw_kg|kg1}',
            footer: 'ops',
          },
        },
      ],
    }),
    def({ id: 'cruise_hello', trigger: { on: 'phase_enter', phase: 'CRUISE' } }),
    def({
      id: 'off_report',
      trigger: { on: 'event', event: 'OOOI_OFF' },
      steps: [{ send: { body: 'OUT {flight.out|hhmm} OFF {flight.off|hhmm}' } }],
    }),
    def({
      id: 'tod150',
      trigger: { on: 'distance', dist: { to: 'tod', lte_nm: 150 } },
      steps: [{ send: { body: 'TOD IN {flight.dist_to_tod_nm|int} NM' } }],
    }),
    def({
      id: 'arr10',
      trigger: { on: 'distance', dist: { to: 'dest', lte_nm: 10 } },
      conditions: ['not tm.on_ground'],
    }),
  ]);

  it('time: once, exactly at sched_out − 25 min, while conditions hold', () => {
    const m = sent(r, 'prelim');
    expect(m).toHaveLength(1);
    expect(m[0]?.t).toBe(ofp.times.schedOutMs - 25 * MIN);
    expect(m[0]?.message.lines[0]).toBe('PRELIMINARY LOADSHEET');
  });

  it('phase_enter: on the PHASE_CHANGE tick', () => {
    expect(sent(r, 'cruise_hello').map((m) => m.t)).toEqual([phaseAt(r, 'CRUISE')]);
    expect(sent(r, 'cruise_hello')[0]?.message.text).toBe('CRUISE-HELLO CRUISE'); // `_` is not allowed → `-`;
  });

  it('event: OOOI_OFF, with OOOI times in the text', () => {
    const m = sent(r, 'off_report');
    expect(m).toHaveLength(1);
    expect(m[0]?.message.text).toMatch(/^OUT \d{4} OFF \d{4}$/);
  });

  it('distance to TOD: once, when crossing 150 NM', () => {
    const m = sent(r, 'tod150');
    expect(m).toHaveLength(1);
    const nm = Number(/TOD IN (\d+) NM/.exec(m[0]?.message.text ?? '')?.[1]);
    expect(nm).toBeLessThanOrEqual(150);
    expect(nm).toBeGreaterThan(145);
    expect(m[0]?.t).toBeLessThan(phaseAt(r, 'DESCENT'));
  });

  it('distance to destination with a condition', () => {
    const m = sent(r, 'arr10');
    expect(m).toHaveLength(1);
    expect(m[0]?.t).toBeLessThan(phaseAt(r, 'LANDED'));
  });

  it('every message is formatted for the profile, from the station to the aircraft', () => {
    for (const m of r.out) {
      expect(checkText(m.message.text, DEFAULT_PROFILE)).toEqual([]);
      expect(m.from).toBe(stationCallsign('OPS{flight}', ofp));
      expect(m.to).toBe(ofp.callsign);
    }
    expect(r.out.map((m) => `${new Date(m.t).toISOString()} ${m.message.text}`)).toMatchSnapshot();
  });
});

describe('steps', () => {
  const twoPart = def({
    id: 'two_part',
    trigger: { on: 'event', event: 'OOOI_OFF' },
    steps: [{ send: { body: 'ONE' } }, { wait: { minutes: 10 } }, { send: { body: 'TWO' } }],
  });
  const atDescent = def({
    id: 'at_descent',
    trigger: { on: 'phase_enter', phase: 'CLIMB' },
    steps: [{ wait: { phase: 'DESCENT' } }, { send: { body: 'DESCENT NOW' } }],
  });

  it('wait.minutes counts flight time; wait.phase resumes on that phase', () => {
    const r = fly([twoPart, atDescent]);
    const [one, two] = sent(r, 'two_part');
    expect((two?.t ?? 0) - (one?.t ?? 0)).toBe(10 * MIN);
    expect(sent(r, 'at_descent').map((m) => m.t)).toEqual([phaseAt(r, 'DESCENT')]);
    expect(r.events.filter((e) => e.type === 'SCENARIO_DONE')).toHaveLength(2);
  });

  it('at ×4 a 10 min wait takes 2.5 min of wall time', () => {
    const fast = withSimRate(normal, {
      fromIndex: stageIndex(normal, 'CLIMB', 10),
      toIndex: stageIndex(normal, 'CRUISE', 600),
      rate: 4,
    });
    const [one, two] = sent(fly([twoPart], fast), 'two_part');
    expect((two?.t ?? 0) - (one?.t ?? 0)).toBe(2.5 * MIN);
  });

  it('wait.phase already reached does not wait', () => {
    const r = fly([
      def({
        id: 'late',
        trigger: { on: 'phase_enter', phase: 'CRUISE' },
        steps: [{ wait: { phase: 'CLIMB' } }, { send: { body: 'NOW' } }],
      }),
    ]);
    expect(sent(r, 'late').map((m) => m.t)).toEqual([phaseAt(r, 'CRUISE')]);
  });

  it('a template that fails at runtime ends the scenario with SCENARIO_ERROR', () => {
    const r = fly([
      def({
        id: 'broken',
        trigger: { on: 'phase_enter', phase: 'CRUISE' },
        steps: [{ send: { body: 'ZFW {phase|kg1}' } }],
      }),
    ]);
    expect(sent(r, 'broken')).toEqual([]);
    expect(r.events.filter((e) => e.type === 'SCENARIO_ERROR')).toEqual([
      expect.objectContaining({ id: 'broken', error: expect.stringMatching(/kg1/) }),
    ]);
  });
});

describe('probability, cooldown, excludes, priority', () => {
  it('probability is rolled once per candidacy, deterministically per seed', () => {
    const coin = def({
      id: 'coin',
      trigger: { on: 'event', event: 'PHASE_CHANGE' },
      probability: 0.5,
      cooldown: { minutes: 0.001 },
    });
    const counts = [1, 2, 3, 4, 5, 6].map(
      (seed) => sent(fly([coin], normal, { seed }), 'coin').length,
    );
    expect(counts).toEqual(
      [1, 2, 3, 4, 5, 6].map((seed) => sent(fly([coin], normal, { seed }), 'coin').length),
    );
    const total = counts.reduce((a, b) => a + b, 0);
    // 11 phase changes × 6 flights × 0.5
    expect(total).toBeGreaterThan(15);
    expect(total).toBeLessThan(51);
  });

  it("another scenario does not change a scenario's dice", () => {
    const coin = def({
      id: 'coin',
      trigger: { on: 'phase_enter', phase: 'CRUISE' },
      probability: 0.5,
    });
    const other = def({
      id: 'aaa',
      trigger: { on: 'phase_enter', phase: 'CRUISE' },
      probability: 0.5,
    });
    for (const seed of [1, 2, 3, 4]) {
      const alone = sent(fly([coin], normal, { seed }), 'coin').length;
      expect(sent(fly([other, coin], normal, { seed }), 'coin').length).toBe(alone);
    }
  });

  it('probability 0 never fires and reports why', () => {
    const r = fly([
      def({ id: 'never', trigger: { on: 'phase_enter', phase: 'CRUISE' }, probability: 0 }),
    ]);
    expect(sent(r, 'never')).toEqual([]);
    expect(skipped(r, 'never')).toEqual(['probability']);
  });

  it('per_flight: once; {minutes}: not again within the window', () => {
    const each = (cooldown: ScenarioDef['cooldown']) =>
      fly([
        def({
          id: 'pc',
          trigger: { on: 'event', event: 'PHASE_CHANGE' },
          ...(cooldown ? { cooldown } : {}),
        }),
      ]);
    expect(sent(each(undefined), 'pc')).toHaveLength(1);
    const r = each({ minutes: 30 });
    const times = sent(r, 'pc').map((m) => m.t);
    for (let i = 1; i < times.length; i++) {
      expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(30 * MIN);
    }
    expect(times.length).toBeGreaterThan(2);
    expect(skipped(r, 'pc')).toContain('cooldown');
  });

  it('per_session: skipped when the session already ran it', () => {
    const s = def({
      id: 'once',
      trigger: { on: 'phase_enter', phase: 'CRUISE' },
      cooldown: 'per_session',
    });
    const first = fly([s]);
    expect(sent(first, 'once')).toHaveLength(1);
    expect(first.core.sessionFired).toEqual(['once']);
    const second = fly([s], normal, { sessionFired: first.core.sessionFired });
    expect(sent(second, 'once')).toEqual([]);
    expect(skipped(second, 'once')).toEqual(['cooldown']);
  });

  it('excludes works both ways; priority decides who goes first on one tick', () => {
    const a = def({
      id: 'a_low',
      trigger: { on: 'phase_enter', phase: 'CRUISE' },
      excludes: ['b_high'],
    });
    const b = def({ id: 'b_high', trigger: { on: 'phase_enter', phase: 'CRUISE' }, priority: 5 });
    const r = fly([a, b]);
    expect(r.out.map((m) => m.scenarioId)).toEqual(['b_high']);
    expect(skipped(r, 'a_low')).toEqual(['excluded']);
    const r2 = fly([{ ...a, priority: 9 }, b]);
    expect(r2.out.map((m) => m.scenarioId)).toEqual(['a_low']);
  });

  it('same priority: id order', () => {
    const r = fly(
      ['zz', 'mm', 'aa'].map((id) => def({ id, trigger: { on: 'phase_enter', phase: 'CRUISE' } })),
    );
    expect(r.out.map((m) => m.scenarioId)).toEqual(['aa', 'mm', 'zz']);
  });
});

describe('telemetry loss, resume, profile', () => {
  it('scenarios pause while telemetry is lost and catch up after it', () => {
    const at = ofp.times.schedOutMs + 60 * MIN;
    const s = def({
      id: 'clock',
      trigger: { on: 'time', at: { rel: 'sched_out', offset_min: 60 } },
    });
    const i = normal.snapshots.findIndex((x) => x.t === at);
    const gapped = withGap(normal, { atIndex: i - 30, durationSec: 120 });
    const r = fly([s], gapped);
    const restored = r.events.find((e) => e.type === 'TELEMETRY_RESTORED');
    expect(sent(r, 'clock').map((m) => m.t)).toEqual([restored?.t]);
  });

  it('getState → JSON → fromState continues identically (also mid-wait)', () => {
    const defs = [
      def({
        id: 'chain',
        trigger: { on: 'event', event: 'OOOI_OFF' },
        steps: [
          { send: { body: '{rand:1-999}' } },
          { wait: { minutes: 30 } },
          { send: { body: '{seat} {pick:[A,B,C]}' } },
        ],
      }),
      def({
        id: 'coin',
        trigger: { on: 'event', event: 'PHASE_CHANGE' },
        probability: 0.5,
        cooldown: { minutes: 1 },
      }),
    ];
    const opts: CoreOptions = { ofp, scenarios: defs.map(compileScenario) };
    const full = fly(defs);
    const cut = stageIndex(normal, 'CLIMB', 600);
    const first = fly(defs, normal, {}, AcarsCore.create(opts), 0, cut);
    const state = JSON.parse(JSON.stringify(first.core.getState()));
    const resumed = AcarsCore.fromState(state, opts);
    const second = fly(defs, normal, {}, resumed, cut);
    expect([...first.out, ...second.out]).toEqual(full.out);
    expect([...first.events, ...second.events]).toEqual(full.events);
  });

  it('formats with the given profile and station', () => {
    const long = def({
      id: 'long',
      trigger: { on: 'phase_enter', phase: 'CRUISE' },
      steps: [{ send: { body: 'A VERY LONG LINE THAT DOES NOT FIT INTO THIRTY CHARACTERS' } }],
    });
    const r = fly([long], normal, { profile: B78X_PROFILE, station: '{airline}OPS' });
    const m = sent(r, 'long')[0];
    expect(m?.message.profileId).toBe('b78x');
    expect(m?.message.lines.every((l) => l.length <= 30)).toBe(true);
    expect(m?.from).toBe(`${ofp.airlineIcao}OPS`);
  });
});

describe('compileScenario', () => {
  const ok = def({ id: 'ok', trigger: { on: 'phase_enter', phase: 'CRUISE' } });
  it.each<[string, Partial<ScenarioDef>]>([
    ['bad id', { id: 'Bad-Id' }],
    ['unknown phase', { trigger: { on: 'phase', phase: 'TAXI' as 'TAXI_IN' } }],
    ['unknown event', { trigger: { on: 'event', event: 'TELEMETRY_LOST' as 'SIM_PAUSED' } }],
    ['distance without bound', { trigger: { on: 'distance', dist: { to: 'tod' } } }],
    ['probability > 1', { probability: 1.5 }],
    ['zero cooldown', { cooldown: { minutes: 0 } }],
    ['self exclusion', { excludes: ['ok'] }],
    ['bad condition', { conditions: ['phase =='] }],
    ['unknown variable in condition', { conditions: ['flight.nope > 1'] }],
    ['unknown variable in template', { steps: [{ send: { body: '{ofp.nope}' } }] }],
    ['bad formatter', { steps: [{ send: { body: '{ofp.zfw_kg|kg9}' } }] }],
    ['no steps', { steps: [] }],
    ['zero wait', { steps: [{ wait: { minutes: 0 } }] }],
    ['v0 step', { steps: [{ set: { x: 1 } } as never] }],
  ])('rejects %s', (_, patch) => {
    expect(() => compileScenario({ ...ok, ...patch })).toThrow(ScenarioError);
  });

  it('accepts the valid one', () => {
    expect(compileScenario(ok).id).toBe('ok');
  });
});

describe('AcarsCore.endFlight (user decision at ON_BLOCK)', () => {
  const defs = [def({ id: 'bye', trigger: { on: 'phase_enter', phase: 'TURNAROUND' } })];

  it('enters TURNAROUND and runs the scenarios in the same call', () => {
    const r = fly(defs);
    expect(r.core.phase).toBe('ON_BLOCK');
    const now = (normal.snapshots.at(-1)?.t ?? 0) + MIN;
    const out = r.core.endFlight('TURNAROUND', now);
    expect(out.phase).toBe('TURNAROUND');
    expect(out.events).toContainEqual({
      type: 'PHASE_CHANGE',
      t: now,
      from: 'ON_BLOCK',
      to: 'TURNAROUND',
    });
    expect(out.outbound.map((m) => m.scenarioId)).toEqual(['bye']);
  });

  it('throws outside ON_BLOCK', () => {
    const core = AcarsCore.create({ ofp, scenarios: defs.map(compileScenario) });
    expect(() => core.endFlight('DONE', 0)).toThrow(/ON_BLOCK/);
  });
});
