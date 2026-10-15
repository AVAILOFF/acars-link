import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AcarsCore,
  type CompiledScenario,
  type CoreEvent,
  DIVERT_RESERVE_NM,
  type DivertAirport,
  distanceNm,
  type FirArea,
  generateSyntheticFlight,
  type Ofp,
  type OutboundMessage,
  ofpCandidates,
  type PilotMessage,
  parseSimbriefOfp,
  stageIndex,
  type TelemetrySnapshot,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../src/index.js';
import { withHoldMin } from './hold.js';

/**
 * T50 part A: how long an airline-announced holding lasts is drawn at the start; updates every
 * 20 min with a new time (and a new UM93 from the ROPS station); closed until further notice sends
 * the aircraft away at the first update; the fuel minimum sends it away early.
 */

const dir = (name: string) => join(import.meta.dirname, '..', name);
const read = (name: string) =>
  readdirSync(dir(name))
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(dir(name), file), 'utf8') }));
const everything = loadScenarios([...read('irregular')]);
const scenario = (id: string): CompiledScenario => {
  const s = everything.find((x) => x.id === id);
  if (s === undefined) throw new Error(`no scenario ${id}`);
  return { ...s, probability: 1 };
};

const ofp: Ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../core/test/fixtures/ofp/rctp-rjbb-a35k-kgs.json'),
      'utf8',
    ),
  ),
);
const flight = generateSyntheticFlight({ ofp });
const MIN = 60_000;
const WORLD: FirArea = {
  id: 'RCAA',
  name: 'Taipei',
  oceanic: false,
  polygons: [
    [
      [
        [100, 0],
        [160, 0],
        [160, 60],
        [100, 60],
        [100, 0],
      ],
    ],
  ],
};
const logon: PilotMessage = {
  from: ofp.callsign,
  type: 'cpdlc',
  text: '/data2/0//Y/REQUEST LOGON',
  to: 'XCAA',
};
const telex = (text: string): PilotMessage => ({ from: ofp.callsign, type: 'telex', text });

interface Hold {
  readonly out: OutboundMessage[];
  readonly events: CoreEvent[];
  readonly core: AcarsCore;
  /** Minutes (since the first message of `id`) of every message of `id`. */
  readonly at: (id: string) => number[];
}

/**
 * Flies to the first message of `id`, then keeps the aircraft where it is (a holding) for
 * `minutes` minutes of flight time. The pilot answers every question with `answer`, or not at all.
 */
function hold(
  scenarios: readonly CompiledScenario[],
  id: string,
  o: {
    minutes: number;
    /** Answers, once per question of the scenario (first question only); default HOLD for `id`. */
    answers?: Readonly<Record<string, string>>;
    rops?: boolean;
    fuelPerMin?: number;
    pilot?: (min: number) => string | null;
  },
): Hold {
  const core = AcarsCore.create({
    ofp,
    scenarios,
    seed: 't50',
    ...(o.rops === true ? { rops: { enabled: true, randomDirects: false } } : {}),
  });
  core.startFlight();
  const out: OutboundMessage[] = [];
  const events: CoreEvent[] = [];
  let first: number | null = null;
  let frozen: TelemetrySnapshot | null = null;
  let pending: PilotMessage[] = [];
  const answers: Record<string, string> = o.answers ?? { [id]: 'HOLD' };
  const answered = new Set<string>();
  const tickOnce = (s: TelemetrySnapshot, extra: PilotMessage[] = []) => {
    const inbound = [...pending, ...extra];
    pending = [];
    const r = core.tick({
      now: s.t,
      telemetry: s,
      ...(inbound.length > 0 ? { inbound } : {}),
      ...(s === flight.snapshots[0] ? { data: { t: s.t, firs: [WORLD] } } : {}),
    });
    out.push(...r.outbound);
    events.push(...r.events);
    for (const e of r.events) {
      if (e.type !== 'REPLY_EXPECTED' || answered.has(e.id)) continue;
      answered.add(e.id);
      const text = answers[e.id];
      if (text !== undefined) pending.push(telex(text));
    }
    if (first === null && r.outbound.some((m) => m.scenarioId === id)) first = s.t;
  };
  let i = 0;
  for (const s of flight.snapshots) {
    tickOnce(s, i === 5 && o.rops === true ? [logon] : []);
    i++;
    if (first !== null) {
      frozen = s;
      break;
    }
  }
  if (frozen === null) throw new Error(`${id} did not start`);
  const startFuel = frozen.fuelKg;
  for (let k = 1; k <= o.minutes * 2; k++) {
    const min = (k * 30_000) / MIN;
    const said = o.pilot?.(min) ?? null;
    tickOnce(
      {
        ...frozen,
        t: frozen.t + k * 30_000,
        fuelKg: startFuel - (o.fuelPerMin ?? 0) * min,
      },
      said === null ? [] : [telex(said)],
    );
  }
  return {
    out,
    events,
    core,
    at: (x) =>
      out.filter((m) => m.scenarioId === x).map((m) => Math.round((m.t - (first as number)) / MIN)),
  };
}
const texts = (h: Hold, id: string) =>
  h.out.filter((m) => m.scenarioId === id).map((m) => m.message.text.replaceAll('\n', ' '));

describe('drawn length of the holding (T50)', () => {
  const holdMinutes = (id: string, seed: string): number => {
    const core = AcarsCore.create({ ofp, scenarios: [scenario(id)], seed });
    core.startFlight();
    for (const s of flight.snapshots) {
      core.tick({ now: s.t, telemetry: s });
      const run = core.getState().engine.runs.find((r) => r.id === id);
      if (run !== undefined) return run.vars['run.hold_min'] as number;
    }
    return Number.NaN;
  };

  it.each([
    ['drone_activity', 30, 180],
    ['dest_fire', 20, 120],
  ])('%s: %i..%i min, by seed, not always the same', (id, lo, hi) => {
    const v = Array.from({ length: 12 }, (_, i) => holdMinutes(id, `seed${i}`));
    for (const m of v) {
      expect(m).toBeGreaterThanOrEqual(lo);
      expect(m).toBeLessThanOrEqual(hi);
    }
    expect(new Set(v).size).toBeGreaterThan(3);
    expect(holdMinutes(id, 'seed3')).toBe(v[3]);
  });

  it('runway_closure_dest: length by reason, one in ten until further notice', () => {
    const core = (seed: string) => {
      const c = AcarsCore.create({ ofp, scenarios: [scenario('runway_closure_dest')], seed });
      c.startFlight();
      for (const s of flight.snapshots) {
        c.tick({ now: s.t, telemetry: s });
        const run = c.getState().engine.runs.find((r) => r.id === 'runway_closure_dest');
        if (run !== undefined) return run.vars;
      }
      return {};
    };
    let ufn = 0;
    const n = 60;
    for (let i = 0; i < n; i++) {
      const v = core(`rwy${i}`);
      const min = v['run.hold_min'] as number | null;
      if (v['run.ufn'] === true) {
        ufn++;
        expect(v['run.reason']).toBe('DISABLED ACFT');
        expect(min).toBeNull();
      } else if (v['run.reason'] === 'DISABLED ACFT') {
        expect(min).toBeGreaterThanOrEqual(60);
        expect(min).toBeLessThanOrEqual(180);
      } else {
        expect(['FOD INSPECTION', 'BIRD STRIKE CHECK']).toContain(v['run.reason']);
        expect(min).toBeGreaterThanOrEqual(30);
        expect(min).toBeLessThanOrEqual(60);
      }
    }
    // 3 of 30 by weight: about 6 of 60.
    expect(ufn).toBeGreaterThan(0);
    expect(ufn).toBeLessThan(18);
  }, 60_000);
});

describe('updates and the end of the holding (T50)', () => {
  const drone = (min: number) => withHoldMin(scenario('drone_activity'), min);

  it('an update every 20 min, the end when the drawn time is over, not on the grid', () => {
    const h = hold([drone(50)], 'drone_activity', { minutes: 70 });
    const t = texts(h, 'drone_activity');
    expect(t[0]).toMatch(/NO ESTIMATE, NEXT UPDATE \d{4}Z/);
    expect(t[1]).toMatch(/^OPS MSG.*NOTED, NEXT UPDATE \d{4}Z/);
    const at = h.at('drone_activity');
    // The first message, the answer, updates at 20 and 40 min after the answer, the end at 50.
    expect(t).toHaveLength(5);
    expect(t[2]).toMatch(/ARRIVALS STILL SUSPENDED AT RJBB NEXT UPDATE \d{4}Z/);
    expect(t[3]).toMatch(/ARRIVALS STILL SUSPENDED/);
    expect(t[4]).toContain('ARRIVALS RESUMED');
    const answered = at[1] as number;
    expect((at[2] as number) - answered).toBe(20);
    expect((at[3] as number) - answered).toBe(40);
    expect((at[4] as number) - answered).toBe(50);
    expect(h.core.getState().engine.hold).toBeNull();
  });

  it('the announced time is the next update', () => {
    const h = hold([drone(50)], 'drone_activity', { minutes: 25 });
    const hhmm = (ms: number) => {
      const d = new Date(ms);
      return `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`;
    };
    const msgs = h.out.filter((m) => m.scenarioId === 'drone_activity');
    const upd = msgs[2] as OutboundMessage;
    expect(upd.message.text).toContain(`NEXT UPDATE ${hhmm(upd.t + 20 * MIN)}Z`);
  });

  it('the pilot HOLD at any time confirms: no extra update, the grid stays', () => {
    const a = hold([drone(50)], 'drone_activity', { minutes: 70 });
    const b = hold([drone(50)], 'drone_activity', {
      minutes: 70,
      pilot: (m) => (m === 7 || m === 30 ? 'HOLD' : null),
    });
    expect(b.at('drone_activity')).toEqual(a.at('drone_activity'));
  });

  it('DIVERT at an update: the alternate, no end message', () => {
    const h = hold([drone(120)], 'drone_activity', {
      minutes: 60,
      pilot: (m) => (m === 25 ? 'DIVERT' : null),
    });
    const t = texts(h, 'drone_activity');
    expect(t.at(-1)).toContain('DIVERT RJGG NOTED');
    expect(t.some((x) => x.includes('RESUMED'))).toBe(false);
    expect(h.core.getState().engine.divert).toBe('RJGG');
    // Nothing more after the diversion.
    expect(h.out.filter((m) => m.scenarioId === 'drone_activity')).toHaveLength(4);
  });

  it('a diversion from outside (the pilot command) stops the loop silently', () => {
    const h = hold([drone(120), scenario('hold_fuel_watch')], 'drone_activity', {
      minutes: 60,
      pilot: (m) => (m === 25 ? 'DIVERT RJGG' : null),
    });
    expect(h.core.getState().engine.divert).toBe('RJGG');
    expect(texts(h, 'drone_activity').some((x) => x.includes('RESUMED'))).toBe(false);
  });

  it('runway closed until further notice: the alternate at the first update', () => {
    const rwy = withHoldMin(scenario('runway_closure_dest'), null, true, 'DISABLED ACFT');
    const h = hold([rwy], 'runway_closure_dest', { minutes: 40 });
    const t = texts(h, 'runway_closure_dest');
    expect(t[0]).toContain('DISABLED ACFT');
    expect(t[2]).toContain('RJBB AD CLSD UFN');
    expect(t[2]).toContain('DIVERT RJGG');
    expect(t).toHaveLength(3);
    const at = h.at('runway_closure_dest');
    expect((at[2] as number) - (at[1] as number)).toBe(20);
    expect(h.core.getState().engine.divert).toBe('RJGG');
  });

  it('runway closed for a while: updates, then reopened', () => {
    const h = hold([withHoldMin(scenario('runway_closure_dest'), 45)], 'runway_closure_dest', {
      minutes: 60,
    });
    const t = texts(h, 'runway_closure_dest');
    expect(t[0]).toContain('FOD INSPECTION');
    expect(t.filter((x) => x.includes('STILL CLOSED'))).toHaveLength(2);
    expect(t.at(-1)).toContain('REOPENED');
  });
});

describe('minimum diversion fuel (T50)', () => {
  const both = [withHoldMin(scenario('drone_activity'), 180), scenario('hold_fuel_watch')];

  it('fuel at the minimum: DIVERT is recommended and, unanswered, taken after 5 min', () => {
    // From about 11 t at a hundred kg a minute: the minimum (alternate burn + reserve + 10 %).
    const h = hold(both, 'drone_activity', { minutes: 90, fuelPerMin: 100 });
    const w = texts(h, 'hold_fuel_watch');
    expect(w[0]).toContain('MIN DIVERSION FUEL RECOMMEND DIVERT RJGG');
    expect(w[1]).toContain('DIVERT RJGG NOTED');
    const at = h.at('hold_fuel_watch');
    expect((at[1] as number) - (at[0] as number)).toBe(5);
    expect(h.core.getState().engine.divert).toBe('RJGG');
    // The drone chain does not go on after the diversion.
    expect(texts(h, 'drone_activity').some((x) => x.includes('RESUMED'))).toBe(false);
    const stillAfter = h.out
      .filter((m) => m.scenarioId === 'drone_activity')
      .filter((m) => m.message.text.includes('STILL SUSPENDED'));
    for (const m of stillAfter) expect(m.t).toBeLessThan((h.out.at(-1) as OutboundMessage).t);
  });

  it('HOLD keeps the holding', () => {
    const h = hold(both, 'drone_activity', {
      minutes: 90,
      fuelPerMin: 100,
      answers: { drone_activity: 'HOLD', hold_fuel_watch: 'STAY' },
    });
    expect(h.core.getState().engine.divert).toBeNull();
    expect(texts(h, 'hold_fuel_watch')).toHaveLength(2);
    expect(texts(h, 'hold_fuel_watch')[1]).toContain('HOLD NOTED');
  });

  it('enough fuel: nothing', () => {
    const h = hold(both, 'drone_activity', { minutes: 90, fuelPerMin: 0 });
    expect(texts(h, 'hold_fuel_watch')).toEqual([]);
  });

  it('without a fuel reading: the plan margin for the holding', () => {
    // Extra 2400 + contingency 1440 kg at 11944 kg in 2.07 h: about 40 minutes.
    const h = hold(both, 'drone_activity', {
      minutes: 90,
      fuelPerMin: 0,
      pilot: () => null,
    });
    expect(texts(h, 'hold_fuel_watch')).toEqual([]);
    const noFuel = (s: TelemetrySnapshot): TelemetrySnapshot => ({ ...s, fuelKg: 0 });
    const core = AcarsCore.create({ ofp, scenarios: both, seed: 't50' });
    core.startFlight();
    const out: OutboundMessage[] = [];
    let pending: PilotMessage[] = [];
    let first: number | null = null;
    let frozen: TelemetrySnapshot | null = null;
    for (const s of flight.snapshots) {
      const r = core.tick({ now: s.t, telemetry: noFuel(s), inbound: pending });
      pending = r.events.some((e) => e.type === 'REPLY_EXPECTED' && e.id === 'drone_activity')
        ? [telex('HOLD')]
        : [];
      out.push(...r.outbound);
      if (first === null && r.outbound.some((m) => m.scenarioId === 'drone_activity')) {
        first = s.t;
        frozen = s;
      }
      if (frozen !== null) break;
    }
    const base = frozen as TelemetrySnapshot;
    for (let k = 1; k <= 160; k++) {
      const r = core.tick({
        now: base.t + k * 30_000,
        telemetry: noFuel({ ...base, t: base.t + k * 30_000 }),
        inbound: pending,
      });
      pending = r.events.some((e) => e.type === 'REPLY_EXPECTED' && e.id === 'drone_activity')
        ? [telex('HOLD')]
        : [];
      out.push(...r.outbound);
    }
    const w = out.filter((m) => m.scenarioId === 'hold_fuel_watch');
    expect(w.length).toBeGreaterThan(0);
    // After the margin (about 40 min of holding), not at once.
    const minutesIn = ((w[0] as OutboundMessage).t - (first as number)) / MIN;
    expect(minutesIn).toBeGreaterThan(30);
    expect(minutesIn).toBeLessThan(50);
  });
});

describe('ROPS follows the updates (T50)', () => {
  it('a new EXPECT FURTHER CLEARANCE AT at every update, HOLD AT only once', () => {
    const h = hold([withHoldMin(scenario('drone_activity'), 50)], 'drone_activity', {
      minutes: 70,
      rops: true,
    });
    const cp = h.out.filter((m) => m.kind === 'cpdlc').map((m) => m.message.text);
    expect(cp.filter((x) => x.includes('HOLD AT @'))).toHaveLength(1);
    // Once with the holding, once at each of the two updates.
    expect(cp.filter((x) => x.includes('EXPECT FURTHER CLEARANCE AT @'))).toHaveLength(3);
    // The holding is over: a direct to the next fix.
    expect(cp.some((x) => x.includes('PROCEED DIRECT TO @'))).toBe(true);
  });
});

describe('where the aircraft is sent (T50 part B)', () => {
  const NEEDS = { A350: { lengthM: 2500, widthM: 45 } } as const;
  const atCruise = flight.snapshots[stageIndex(flight, 'CRUISE', 90)] as TelemetrySnapshot;
  // A reserve airport 5 NM from where the aircraft is when the cabin scenarios start.
  const reserve: DivertAirport = {
    icao: 'ZZAA',
    lat: atCruise.lat + 5 / 60,
    lon: atCruise.lon,
    rwyM: 3500,
    widthM: 60,
    large: true,
  };
  const nearestOfp = Math.min(...ofpCandidates(ofp).map((a) => distanceNm(atCruise, a)));

  const diverted = (id: string, answer: string, needs: boolean) => {
    const core = AcarsCore.create({
      ofp,
      // Without the random start of T51: the aircraft is where the reserve airport was put.
      scenarios: [
        {
          ...scenario(id),
          def: { ...scenario(id).def, trigger: { on: 'phase', phase: 'CRUISE' } },
        },
      ],
      seed: 't50b',
      ...(needs ? { runwayNeeds: NEEDS } : {}),
    });
    core.startFlight();
    let pending: PilotMessage[] = [];
    const events: CoreEvent[] = [];
    flight.snapshots.forEach((s, i) => {
      const r = core.tick({
        now: s.t,
        telemetry: s,
        ...(pending.length > 0 ? { inbound: pending } : {}),
        ...(i === 0 ? { data: { t: s.t, divertApts: [reserve] } } : {}),
      });
      events.push(...r.events);
      pending = r.events.some((e) => e.type === 'REPLY_EXPECTED') ? [telex(answer)] : [];
    });
    return events.find((e) => e.type === 'SET' && e.name === 'flight.divert');
  };

  it('the precondition: an OFP airport is within the reserve distance', () => {
    expect(nearestOfp).toBeLessThan(DIVERT_RESERVE_NM);
  });

  it('fire in the cabin takes the nearest of all: the reserve airport', () => {
    expect(diverted('ped_fire_cabin', 'DIVERT', true)).toMatchObject({ value: 'ZZAA' });
  });

  it('a medical case takes the OFP airport while one is near', () => {
    const set = diverted('medical_onboard', 'DIVERT', true);
    expect(set).toMatchObject({ applied: true });
    expect(['RCTP', 'RJGG']).toContain((set as { value: string }).value);
  });

  it('without a runway need for the type nothing changes', () => {
    const set = diverted('ped_fire_cabin', 'DIVERT', false);
    expect(['RCTP', 'RJGG']).toContain((set as { value: string }).value);
  });

  it('the ROPS station sends the direct and the descent to a reserve airport', () => {
    const core = AcarsCore.create({
      ofp,
      scenarios: [],
      seed: 't50b',
      rops: { enabled: true, randomDirects: false },
    });
    core.startFlight();
    const out: OutboundMessage[] = [];
    const at = stageIndex(flight, 'CRUISE', 600);
    flight.snapshots.forEach((s, i) => {
      const inbound = [...(i === 5 ? [logon] : []), ...(i === at ? [telex('DIVERT ZZAA')] : [])];
      const r = core.tick({
        now: s.t,
        telemetry: s,
        ...(inbound.length > 0 ? { inbound } : {}),
        ...(i === 0 ? { data: { t: s.t, firs: [WORLD], divertApts: [reserve] } } : {}),
      });
      out.push(...r.outbound);
    });
    const cp = out.filter((m) => m.kind === 'cpdlc').map((m) => m.message.text);
    expect(cp.some((x) => x.includes('PROCEED DIRECT TO @ZZAA@'))).toBe(true);
    expect(cp.some((x) => x.includes('DESCEND TO @'))).toBe(true);
  });
});
