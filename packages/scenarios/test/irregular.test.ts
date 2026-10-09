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
  type ExtDataUpdate,
  generateSyntheticFlight,
  MISSING,
  type Ofp,
  type OutboundMessage,
  type PilotMessage,
  parseSimbriefOfp,
  type SyntheticFlight,
  stageIndex,
  type Value,
  withGap,
  withPause,
  withSimRate,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../src/index.js';

/**
 * T14: the irregular scenarios (`irregular/*.yaml`, docs/02 "Нестандартные"). Each alone on 3
 * synthetic flights × 3 profiles, once per answer the pilot can give; the chains inside a
 * flight (diversion, gate change, connection outcome) and between flights (flags: MEL item,
 * disruptive passenger, commander's discretion, rush bags).
 */

const dir = (name: string) => join(import.meta.dirname, '..', name);
const read = (name: string) =>
  readdirSync(dir(name))
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(dir(name), file), 'utf8') }));
const irregularFiles = read('irregular');
const all = loadScenarios([...read('base'), ...read('commands'), ...irregularFiles]);
const irregular = loadScenarios(irregularFiles);
const byId = (id: string) => {
  const s = all.find((x) => x.id === id);
  if (s === undefined) throw new Error(`no scenario ${id}`);
  return { ...s, probability: 1 };
};

const OFPS = join(import.meta.dirname, '../../core/test/fixtures/ofp');
const ofpOf = (name: string): Ofp =>
  parseSimbriefOfp(JSON.parse(readFileSync(join(OFPS, `${name}.json`), 'utf8')));
const kg = ofpOf('rctp-rjbb-a35k-kgs');
const lbs = ofpOf('rctp-rjbb-a35k-lbs-synthetic');

/** The same OFP a day later (the next flight of the chains). */
function nextDay(ofp: Ofp, days = 1): Ofp {
  const d = days * 86_400_000;
  const t = ofp.times;
  const add = (x: number | null) => (x === null ? null : x + d);
  return {
    ...ofp,
    times: {
      ...t,
      schedOutMs: t.schedOutMs + d,
      schedOffMs: add(t.schedOffMs),
      schedOnMs: add(t.schedOnMs),
      schedInMs: t.schedInMs + d,
      estOutMs: t.estOutMs + d,
      estOffMs: add(t.estOffMs),
      estOnMs: add(t.estOnMs),
      estInMs: t.estInMs + d,
    },
  };
}

interface Case {
  readonly name: string;
  readonly ofp: Ofp;
  readonly flight: SyntheticFlight;
}
const normal = generateSyntheticFlight({ ofp: kg });
const goAround = generateSyntheticFlight({ ofp: kg, goAroundAglFt: 400 });
const lbsFlight = generateSyntheticFlight({ ofp: lbs, seed: 'lbs' });
const FLIGHTS: readonly Case[] = [
  { name: 'normal', ofp: kg, flight: normal },
  {
    name: 'go-around, pause, ×4',
    ofp: kg,
    flight: withSimRate(
      withPause(goAround, { atIndex: stageIndex(goAround, 'GATE', 600), durationSec: 300 }),
      {
        fromIndex: stageIndex(goAround, 'CRUISE', 300),
        toIndex: stageIndex(goAround, 'CRUISE', 1500),
        rate: 4,
      },
    ),
  },
  {
    name: 'lbs OFP, telemetry gap',
    ofp: lbs,
    flight: withGap(lbsFlight, { atIndex: stageIndex(lbsFlight, 'CLIMB', 120), durationSec: 90 }),
  },
];

interface Setup {
  /** Other scenarios a chain needs (probability 1). */
  readonly with?: readonly string[];
  /** Flags left by an earlier flight. */
  readonly flags?: (ofp: Ofp) => Readonly<Record<string, Value>>;
  /** A pilot `DELAY <min>` at the gate. */
  readonly delayMin?: number;
  /** The flight really starts this late (the synthetic flight ignores DELAY). */
  readonly lateMin?: number;
  /** Cold weather at the origin. */
  readonly cold?: boolean;
  /** The answers to try, one flight each; empty = no question. */
  readonly answers?: readonly string[];
}

const SETUP: Readonly<Record<string, Setup>> = {
  medical_onboard: { answers: ['CONTINUE', 'DIVERT'] },
  unruly_passenger: { answers: ['RESTRAIN', 'DIVERT', 'CONTINUE'] },
  unruly_followup: {
    flags: () => ({ unruly_seat: '23C', unruly_flight: 'SJX821', unruly_date: 1 }),
  },
  tech_defect_mel: { answers: ['CONFIRM', 'NEGATIVE'] },
  mel_carry_over: {
    flags: (o) => ({ mel_item: '21-52-01 PACK 2 INOP', mel_reg: o.aircraft.reg, mel_date: 1 }),
  },
  deicing_holdover: { cold: true, answers: ['READY'] },
  curfew_dest: { delayMin: 90, answers: ['ABLE', 'UNABLE'] },
  tankering: { answers: ['ACCEPT', 'DECLINE'] },
  short_connection: { delayMin: 30 },
  connection_made: { with: ['short_connection'] },
  connection_missed: { with: ['short_connection'], lateMin: 90 },
  dg_notoc: { answers: ['ACK'] },
  runway_closure_dest: { answers: ['HOLD', 'DIVERT'] },
  altn_wx_deterioration: { answers: ['OK', 'LOW'] },
  crew_duty_limit: { delayMin: 45, answers: ['EXTEND', 'NO'] },
  discretion_followup: { flags: () => ({ crew_discretion: 'SJX821', crew_discretion_date: 1 }) },
  drone_activity: { answers: ['HOLD', 'DIVERT'] },
  rush_bags_followup: {
    flags: () => ({ rush_bags: 4, rush_from: 'RCTP', rush_to: 'RJBB', rush_date: 1 }),
  },
  gate_reassignment: { with: ['gate_assignment'] },
};

interface Run {
  readonly core: AcarsCore;
  readonly out: OutboundMessage[];
  readonly events: CoreEvent[];
}

/**
 * Flies `c`; the pilot answers every question with `answer` on the next tick (or not at all),
 * sends `DELAY` at boarding, the origin is cold when asked.
 */
function fly(
  c: Case,
  scenarios: readonly CompiledScenario[],
  o: {
    profile?: DisplayProfile;
    answer?: string;
    delayMin?: number;
    cold?: boolean;
    flags?: Readonly<Record<string, Value>>;
    seed?: string;
  } = {},
): Run {
  const core = AcarsCore.create({
    ofp: c.ofp,
    scenarios,
    seed: o.seed ?? 'irregular',
    profile: o.profile ?? DEFAULT_PROFILE,
    ...(o.flags === undefined ? {} : { flags: o.flags }),
  });
  core.startFlight();
  const out: OutboundMessage[] = [];
  const events: CoreEvent[] = [];
  let pending: PilotMessage[] = [];
  const pilot = (text: string): PilotMessage => ({ from: c.ofp.callsign, type: 'telex', text });
  const board = c.flight.snapshots.findIndex((s) => s.t >= c.ofp.times.schedOutMs - 60 * 60_000);
  c.flight.snapshots.forEach((s, i) => {
    const inbound = pending;
    pending = [];
    if (i === Math.max(1, board) && o.delayMin !== undefined)
      inbound.push(pilot(`DELAY ${o.delayMin}`));
    const data: ExtDataUpdate | undefined =
      o.cold === true && i === 0
        ? {
            t: s.t,
            wx: {
              [c.ofp.origin.icao]: {
                metar: `${c.ofp.origin.icao} 080600Z 36010KT 2000 -SN BKN008 M02/M04 Q1002`,
                taf: null,
                obsTime: s.t,
              },
            },
          }
        : undefined;
    const r = core.tick({
      now: s.t,
      telemetry: s,
      ...(inbound.length > 0 ? { inbound } : {}),
      ...(data === undefined ? {} : { data }),
    });
    out.push(...r.outbound);
    events.push(...r.events);
    if (o.answer !== undefined && r.events.some((e) => e.type === 'REPLY_EXPECTED'))
      pending.push(pilot(o.answer));
  });
  return { core, out, events };
}

/** A plain synthetic flight of `ofp` that starts boarding `min` minutes late. */
function late(ofp: Ofp, min: number): Case {
  const startMs = ofp.times.schedOutMs - 35 * 60_000 + min * 60_000;
  return { name: `late ${min}`, ofp, flight: generateSyntheticFlight({ ofp, startMs }) };
}

const errors = (r: Run) => r.events.filter((e) => e.type === 'SCENARIO_ERROR');
const ids = (r: Run) => r.out.map((m) => m.scenarioId);
const missing = new RegExp(`(^|[^-])${MISSING}($|[^-])`, 'm');
const textsOf = (r: Run, id: string) =>
  r.out.filter((m) => m.scenarioId === id).map((m) => m.message.text.replaceAll('\n', ' '));

describe('irregular scenario files', () => {
  it('15+ scenarios, file name = id, category irregular, each with a test setup', () => {
    expect(irregular.length).toBeGreaterThanOrEqual(15);
    expect(irregular.map((s) => `${s.id}.yaml`)).toEqual(irregularFiles.map((f) => f.file));
    expect(irregular.every((s) => s.def.category === 'irregular')).toBe(true);
    // UI texts in both app languages (the telexes stay English).
    for (const s of irregular) {
      expect(s.def.title_ru, s.id).toMatch(/[А-Яа-яЁё]/);
      expect(s.def.description, s.id).toMatch(/^[ -~]+$/);
      expect(s.def.description_ru, s.id).toMatch(/[А-Яа-яЁё]/);
    }
    // Questions are tested answer by answer: every scenario that asks lists its answers.
    for (const s of irregular) {
      const asks = s.steps.some((x) => x.kind === 'wait_reply');
      expect(asks, s.id).toBe((SETUP[s.id]?.answers?.length ?? 0) > 0);
    }
  });
});

describe.each(FLIGHTS)('each irregular scenario alone on $name', (c) => {
  const cases = irregular.flatMap((s) => {
    const setup = SETUP[s.id] ?? {};
    const answers = setup.answers ?? [undefined];
    return answers.map((a) => [`${s.id}${a === undefined ? '' : ` ${a}`}`, s.id, a] as const);
  });
  it.each(cases)('%s', (_, id, answer) => {
    const setup = SETUP[id] ?? {};
    const set = [byId(id), ...(setup.with ?? []).map(byId)];
    const cc = setup.lateMin === undefined ? c : late(c.ofp, setup.lateMin);
    for (const profile of [DEFAULT_PROFILE, B77X_PROFILE, B78X_PROFILE]) {
      const r = fly(cc, set, {
        profile,
        ...(answer === undefined ? {} : { answer }),
        ...(setup.delayMin === undefined ? {} : { delayMin: setup.delayMin }),
        ...(setup.cold === undefined ? {} : { cold: setup.cold }),
        ...(setup.flags === undefined ? {} : { flags: setup.flags(c.ofp) }),
      });
      expect(errors(r)).toEqual([]);
      expect(ids(r).filter((x) => x === id).length, `${id} on ${profile.id}`).toBeGreaterThan(0);
      for (const m of r.out) {
        expect(checkText(m.message.text, profile)).toEqual([]);
        expect(m.message.text, m.message.text).not.toMatch(missing);
        expect(m.message.lines.every((l) => l.length <= profile.lineWidth)).toBe(true);
      }
      // An answer from the options was taken, not the timeout.
      if (answer !== undefined) {
        expect(r.events.some((e) => e.type === 'REPLY_TIMEOUT' && e.id === id)).toBe(false);
      }
    }
  });
});

describe('chains inside a flight', () => {
  const c = FLIGHTS[0] as Case;
  const withBase = (id: string) => [
    byId(id),
    ...all.filter((s) => s.def.category !== 'irregular' && s.def.trigger.on !== 'command'),
  ];

  it('DIVERT of a medical case sets the diversion: no arrival messages for the destination', () => {
    const r = fly(c, withBase('medical_onboard'), { answer: 'DIVERT' });
    expect(errors(r)).toEqual([]);
    const set = r.events.find((e) => e.type === 'SET');
    // The nearest of the origin and the alternate at that moment.
    expect(set).toMatchObject({ name: 'flight.divert', applied: true });
    const icao = (set as { value: string }).value;
    expect(['RCTP', 'RJGG']).toContain(icao);
    expect(textsOf(r, 'medical_onboard')[1]).toMatch(
      new RegExp(`ROGER DIVERT ${icao} [0-9]+ NM FROM PRESENT POS`),
    );
    for (const id of ['arrival_info', 'welcome_turnaround']) expect(ids(r)).not.toContain(id);
    const cont = fly(c, withBase('medical_onboard'), { answer: 'CONTINUE' });
    expect(ids(cont)).toContain('arrival_info');
  });

  it('a gate change moves the gate of arrival_info and REQ GATE', () => {
    const scenarios = [...withBase('gate_reassignment'), byId('cmd_req_gate')];
    const r = fly(c, scenarios);
    const before = /EXPECTED GATE (\w+)/.exec(textsOf(r, 'gate_assignment')[0] ?? '')?.[1];
    const after = /NEW GATE (\w+)/.exec(textsOf(r, 'gate_reassignment')[0] ?? '')?.[1];
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect(textsOf(r, 'gate_reassignment')[0]).toContain(`GATE ${before} OCCUPIED`);
    expect(textsOf(r, 'arrival_info')[0]).toContain(`GATE ${after} CONFIRMED`);
  });

  it('a short connection ends made or missed, never both', () => {
    const set = ['short_connection', 'connection_made', 'connection_missed'].map(byId);
    const made = fly(c, set, { delayMin: 30 });
    const missed = fly(late(kg, 90), set);
    expect(ids(made).filter((x) => x !== '#ops')).toEqual(['short_connection', 'connection_made']);
    expect(ids(missed).filter((x) => x !== '#ops')).toEqual([
      'short_connection',
      'connection_missed',
    ]);
  });

  it('the curfew needs a delay; UNABLE diverts to the alternate', () => {
    expect(ids(fly(c, [byId('curfew_dest')]))).toEqual([]);
    const r = fly(c, [byId('curfew_dest')], { delayMin: 90, answer: 'UNABLE' });
    expect(textsOf(r, 'curfew_dest')[1]).toContain('PLAN DIVERT RJGG');
    expect(r.events).toContainEqual(
      expect.objectContaining({ type: 'SET', name: 'flight.divert', value: 'RJGG' }),
    );
  });

  it('de-icing only at a cold origin', () => {
    expect(ids(fly(c, [byId('deicing_holdover')]))).toEqual([]);
    const r = fly(c, [byId('deicing_holdover')], { cold: true, answer: 'READY' });
    expect(textsOf(r, 'deicing_holdover')[0]).toContain('OAT -2 C');
    // The pad of both messages is the same; the scratch flags are gone after.
    const pad = /PAD (\d)/.exec(textsOf(r, 'deicing_holdover')[0] ?? '')?.[1];
    expect(textsOf(r, 'deicing_holdover')[1]).toContain(`PAD ${pad}`);
    expect(r.core.flags).toEqual({});
  });
});

describe('chains between flights (flags)', () => {
  const day1: Case = FLIGHTS[0] as Case;
  const ofp2 = nextDay(kg);
  const day2: Case = {
    name: 'next day',
    ofp: ofp2,
    flight: generateSyntheticFlight({ ofp: ofp2 }),
  };
  const ofp3 = { ...nextDay(kg, 2), aircraft: { ...kg.aircraft, reg: 'JA01XJ' } };
  const otherAc: Case = {
    name: 'other aircraft',
    ofp: ofp3,
    flight: generateSyntheticFlight({ ofp: ofp3 }),
  };

  it('a deferred MEL item comes back on the same aircraft and is closed after arrival', () => {
    const set = ['tech_defect_mel', 'mel_carry_over'].map(byId);
    const first = fly(day1, set, { answer: 'CONFIRM' });
    expect(ids(first)).toEqual(['tech_defect_mel', 'tech_defect_mel']);
    const flags = first.core.flags;
    expect(flags).toMatchObject({ mel_reg: kg.aircraft.reg, mel_date: kg.times.schedOutMs });
    const item = flags['mel_item'] as string;

    // Another aircraft: nothing, the item stays open.
    const other = fly(otherAc, set, { flags });
    expect(ids(other)).toEqual([]);
    expect(other.core.flags).toEqual(flags);

    const second = fly(day2, set, { flags });
    expect(ids(second)).toEqual(['mel_carry_over', 'mel_carry_over']);
    expect(textsOf(second, 'mel_carry_over')[0]).toContain(item);
    expect(textsOf(second, 'mel_carry_over')[1]).toContain('MEL ITEM CLOSED');
    expect(second.core.flags).toEqual({});
    // While an item is open on the aircraft, no new defect is raised.
    expect(ids(fly(day2, set, { flags, answer: 'CONFIRM' }))).not.toContain('tech_defect_mel');
  });

  it('NEGATIVE clears the defect: nothing carries over', () => {
    const set = ['tech_defect_mel', 'mel_carry_over'].map(byId);
    const first = fly(day1, set, { answer: 'NEGATIVE' });
    expect(first.core.flags).toEqual({});
  });

  it('a restrained passenger is reported on the next flight once', () => {
    const set = ['unruly_passenger', 'unruly_followup'].map(byId);
    const first = fly(day1, set, { answer: 'RESTRAIN' });
    const seat = /SEAT (\d+[A-K])/.exec(textsOf(first, 'unruly_passenger')[0] ?? '')?.[1];
    expect(first.core.flags['unruly_seat']).toBe(seat);
    const second = fly(day2, set, { flags: first.core.flags });
    expect(textsOf(second, 'unruly_followup')[0]).toContain(`SEAT ${seat}`);
    expect(second.core.flags).toEqual({});
    // CONTINUE: nothing for the next flight.
    expect(fly(day1, set, { answer: 'CONTINUE' }).core.flags).toEqual({});
  });

  it("commander's discretion: extended rest on the next flight", () => {
    const set = ['crew_duty_limit', 'discretion_followup'].map(byId);
    const first = fly(day1, set, { delayMin: 45, answer: 'EXTEND' });
    expect(first.core.flags['crew_discretion']).toBe(kg.callsign);
    expect(ids(first)).not.toContain('discretion_followup');
    const second = fly(day2, set, { flags: first.core.flags });
    expect(textsOf(second, 'discretion_followup')[0]).toContain(
      `AFTER DISCRETION ON ${kg.callsign}`,
    );
    expect(second.core.flags).toEqual({});
  });

  it('bags left behind: case closed on the next flight', () => {
    const first = fly(day1, [byId('lost_baggage'), byId('rush_bags_followup')]);
    const n = first.core.flags['rush_bags'];
    expect(ids(first)).toEqual(['lost_baggage']);
    expect(textsOf(first, 'lost_baggage')[0]).toContain(`${String(n)} BAGS NOT LOADED AT RCTP`);
    const second = fly(day2, [byId('rush_bags_followup')], { flags: first.core.flags });
    expect(textsOf(second, 'rush_bags_followup')[0]).toContain(`${String(n)} RUSH BAGS RCTP-RJBB`);
    expect(second.core.flags).toEqual({});
  });
});

describe('the whole set', () => {
  const c = FLIGHTS[0] as Case;
  const set = all.filter((s) => s.def.trigger.on !== 'command');

  it('with their own probabilities: a few irregular events per flight, no errors', () => {
    let total = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const r = fly(c, set, { seed: String(seed) });
      expect(errors(r)).toEqual([]);
      total += ids(r).filter((id) => irregular.some((s) => s.id === id)).length;
    }
    // ~0.3–2 irregular messages a flight on average: rare, but not never.
    expect(total).toBeGreaterThan(3);
    expect(total).toBeLessThan(60);
  }, 30_000); // 20 whole flights

  it('same seed and flags → same messages', () => {
    const forced = set.map((s) => ({ ...s, probability: 1 }));
    const flags = { mel_item: '49-11-01 APU INOP', mel_reg: kg.aircraft.reg, mel_date: 1 };
    const a = fly(c, forced, { flags, answer: 'CONTINUE' });
    const b = fly(c, forced, { flags, answer: 'CONTINUE' });
    expect(b.out).toEqual(a.out);
    expect(b.core.flags).toEqual(a.core.flags);
  });
});
