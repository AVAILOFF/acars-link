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
  type ExtDataUpdate,
  generateSyntheticFlight,
  latestLanding,
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
  withTouchdown,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../src/index.js';
import { standsFor } from './stands.js';

/**
 * T14: the flights, the setups and the pilot of the irregular scenario tests
 * (`irregular*.test.ts`). Each scenario alone on one of the 3 synthetic flights is a file of its
 * own (`irregular-alone-*.test.ts`, T76): a file is what Vitest runs in parallel and shards.
 */

const dir = (name: string) => join(import.meta.dirname, '..', name);
const read = (name: string) =>
  readdirSync(dir(name))
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(dir(name), file), 'utf8') }));
export const irregularFiles = read('irregular');
export const all = loadScenarios([...read('base'), ...read('commands'), ...irregularFiles]);
export const irregular = loadScenarios(irregularFiles);
export const byId = (id: string) => {
  const s = all.find((x) => x.id === id);
  if (s === undefined) throw new Error(`no scenario ${id}`);
  return { ...s, probability: 1 };
};

const OFPS = join(import.meta.dirname, '../../core/test/fixtures/ofp');
const ofpOf = (name: string): Ofp =>
  parseSimbriefOfp(JSON.parse(readFileSync(join(OFPS, `${name}.json`), 'utf8')));
export const kg = ofpOf('rctp-rjbb-a35k-kgs');
export const lbs = ofpOf('rctp-rjbb-a35k-lbs-synthetic');

/** The same OFP a day later (the next flight of the chains). */
export const nextDay = (ofp: Ofp, days = 1): Ofp => shifted(ofp, days * 86_400_000);

/** The OFP with every time `d` ms later. */
function shifted(ofp: Ofp, d: number): Ofp {
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

export interface Case {
  readonly name: string;
  readonly ofp: Ofp;
  readonly flight: SyntheticFlight;
}
export const normal = generateSyntheticFlight({ ofp: kg });
const goAround = generateSyntheticFlight({ ofp: kg, goAroundAglFt: 400 });
const lbsFlight = generateSyntheticFlight({ ofp: lbs, seed: 'lbs' });
export const FLIGHTS: readonly Case[] = [
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

export interface Setup {
  /** Other scenarios a chain needs (probability 1). */
  readonly with?: readonly string[];
  /** Flags left by an earlier flight. */
  readonly flags?: (ofp: Ofp) => Readonly<Record<string, Value>>;
  /** A pilot `DELAY <min>` at the gate. */
  readonly delayMin?: number;
  /** The flight really starts this late (the synthetic flight ignores DELAY). */
  readonly lateMin?: number;
  /** The flight goes to an airport with a night curfew, the estimated landing 45 min before it. */
  readonly curfew?: boolean;
  /** Cold weather at the origin. */
  readonly cold?: boolean;
  /** The pilot declares a diversion to the first alternate in cruise. */
  readonly divert?: boolean;
  /** The sim keeps this touchdown rate (ft/min) after landing (bridge field, T46). */
  readonly touchdownFpm?: number;
  /** The fuel on board is this much lower in flight than the synthetic burn (T46). */
  readonly fuelDropKg?: number;
  /** The same in every airborne sample, also below 20000 ft (T50: fuel low in a holding). */
  readonly fuelDropLowKg?: number;
  /** The answers to try, one flight each; empty = no question. */
  readonly answers?: readonly string[];
}

/** Scheduled OUT of `ofp` `days` days earlier: the date a flag of a flight before it carries. */
export const daysBefore = (ofp: Ofp, days: number) => ofp.times.schedOutMs - days * 86_400_000;

export const SETUP: Readonly<Record<string, Setup>> = {
  medical_onboard: { answers: ['CONTINUE', 'DIVERT'] },
  emergency_mayday: { answers: ['DIVERT', 'CONTINUE'] },
  emergency_pan: { answers: ['DIVERT', 'CONTINUE'] },
  unruly_passenger: { answers: ['RESTRAIN', 'DIVERT', 'CONTINUE'] },
  unruly_followup: {
    flags: (o) => ({ unruly_seat: '23C', unruly_flight: 'SJX821', unruly_date: daysBefore(o, 1) }),
  },
  tech_defect_mel: { answers: ['CONFIRM', 'NEGATIVE'] },
  mel_carry_over: {
    flags: (o) => ({
      mel_item: '21-52-01 PACK 2 INOP',
      mel_reg: o.aircraft.reg,
      mel_date: daysBefore(o, 1),
    }),
  },
  deicing_holdover: { cold: true, answers: ['READY'] },
  curfew_dest: { curfew: true, delayMin: 90, answers: ['ABLE', 'UNABLE'] },
  tankering: { answers: ['ACCEPT', 'DECLINE'] },
  short_connection: { delayMin: 30 },
  atc_flow_delay: { with: ['slot_ctot'] },
  connection_made: { with: ['short_connection'] },
  connection_held: { with: ['short_connection'], lateMin: 30 },
  connection_missed: { with: ['short_connection'], lateMin: 90 },
  dg_notoc: { answers: ['ACK'] },
  runway_closure_dest: { answers: ['HOLD', 'DIVERT'] },
  dest_fire: { answers: ['HOLD', 'DIVERT'] },
  dep_fire: {},
  altn_wx_deterioration: { answers: ['OK', 'LOW'] },
  crew_duty_limit: { delayMin: 45, answers: ['EXTEND', 'NO'] },
  discretion_followup: {
    flags: (o) => ({ crew_discretion: 'SJX821', crew_discretion_date: daysBefore(o, 1) }),
  },
  drone_activity: { answers: ['HOLD', 'DIVERT'] },
  // Needs a holding of drone_activity (answered HOLD) and fuel down to the minimum.
  hold_fuel_watch: { with: ['drone_activity'], fuelDropLowKg: 6000, answers: ['STAY'] },
  rush_bags_followup: {
    flags: (o) => ({
      rush_bags: 4,
      rush_from: 'RCTP',
      rush_to: 'RJBB',
      rush_date: daysBefore(o, 1),
    }),
  },
  gate_reassignment: { with: ['gate_assignment'] },
  divert_arrival: { divert: true },
  hard_landing_check: { touchdownFpm: 450, answers: ['CONFIRM', 'NEGATIVE'] },
  hard_landing_followup: {
    flags: (o) => ({ hardland_reg: o.aircraft.reg, hardland_date: daysBefore(o, 1) }),
  },
  fuel_monitoring: { fuelDropKg: 6000, answers: ['WX', 'ATC', 'LEAK', 'NORMAL'] },
  ped_fire_cabin: { answers: ['CONTINUE', 'DIVERT'] },
  recovery_followup: {
    flags: (o) => ({
      recovery_airport: o.origin.icao,
      recovery_flight: 'SJX821',
      recovery_date: daysBefore(o, 1),
    }),
  },
};

export interface Run {
  readonly core: AcarsCore;
  readonly out: OutboundMessage[];
  readonly events: CoreEvent[];
}

/**
 * Flies `c`; the pilot answers every question with `answer` on the next tick (or not at all),
 * sends `DELAY` at boarding, the origin is cold when asked.
 */
export function fly(
  c: Case,
  scenarios: readonly CompiledScenario[],
  o: {
    profile?: DisplayProfile;
    answer?: string;
    delayMin?: number;
    cold?: boolean;
    divert?: boolean;
    flags?: Readonly<Record<string, Value>>;
    seed?: string;
    /** The synthetic onward flight (test hook); default on. */
    synthetic?: boolean;
    /** AeroDataBox departures of the destination (T30), passed at start. */
    connex?: ExtDataUpdate['connex'];
    /** AeroDataBox route statistics of the destination (T55), passed at start. */
    routes?: ExtDataUpdate['routes'];
    /** Core `nextLegVersion` (T55: 3 reads `onwardRoute` from the AeroDataBox data). */
    nextLegVersion?: 1 | 2 | 3;
    /** Stop the flight once this holds (after a tick): what the test reads is already there. */
    until?: (r: Run) => boolean;
  } = {},
): Run {
  const core = AcarsCore.create({
    ofp: c.ofp,
    scenarios,
    seed: o.seed ?? 'irregular',
    profile: o.profile ?? DEFAULT_PROFILE,
    // The synthetic onward flight with a number is a test hook; real flights: OpenFlights routes.
    syntheticConnections: o.synthetic ?? true,
    ...(o.flags === undefined ? {} : { flags: o.flags }),
    ...(o.nextLegVersion === undefined ? {} : { nextLegVersion: o.nextLegVersion }),
  });
  core.startFlight();
  const out: OutboundMessage[] = [];
  const events: CoreEvent[] = [];
  let pending: PilotMessage[] = [];
  const pilot = (text: string): PilotMessage => ({ from: c.ofp.callsign, type: 'telex', text });
  const divertAt = stageIndex(c.flight, 'CRUISE', 120);
  const board = c.flight.snapshots.findIndex((s) => s.t >= c.ofp.times.schedOutMs - 60 * 60_000);
  for (const [i, s] of c.flight.snapshots.entries()) {
    const inbound = pending;
    pending = [];
    if (i === Math.max(1, board) && o.delayMin !== undefined)
      inbound.push(pilot(`DELAY ${o.delayMin}`));
    if (o.divert === true && i === divertAt)
      inbound.push(pilot(`DIVERT ${c.ofp.alternates[0]?.icao ?? 'RJGG'}`));
    const cold = {
      wx: {
        [c.ofp.origin.icao]: {
          metar: `${c.ofp.origin.icao} 080600Z 36010KT 2000 -SN BKN008 M02/M04 Q1002`,
          taf: null,
          obsTime: s.t,
        },
      },
    };
    const gates = i === 0 ? standsFor(c.ofp, s.t).stands : undefined;
    const data: ExtDataUpdate | undefined =
      i === 0
        ? {
            t: s.t,
            ...(gates === undefined ? {} : { stands: gates }),
            ...(o.cold === true ? cold : {}),
            ...(o.connex === undefined ? {} : { connex: o.connex }),
            ...(o.routes === undefined ? {} : { routes: o.routes }),
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
    if (o.until?.({ core, out, events }) === true) break;
  }
  return { core, out, events };
}

/** The flight with the sim data a scenario needs (T46): touchdown rate, fuel lower than planned. */
export function shaped(c: Case, setup: Setup): Case {
  let flight = c.flight;
  if (setup.touchdownFpm !== undefined) flight = withTouchdown(flight, setup.touchdownFpm);
  const drop = setup.fuelDropKg;
  const dropLow = setup.fuelDropLowKg;
  if (dropLow !== undefined) {
    flight = {
      ...flight,
      snapshots: flight.snapshots.map((x) =>
        x.onGround ? x : { ...x, fuelKg: Math.max(0, x.fuelKg - dropLow) },
      ),
    };
  }
  if (drop !== undefined) {
    flight = {
      ...flight,
      snapshots: flight.snapshots.map((x) =>
        x.altFt > 20_000 ? { ...x, fuelKg: Math.max(0, x.fuelKg - drop) } : x,
      ),
    };
  }
  return flight === c.flight ? c : { ...c, flight };
}

/**
 * `c` to Osaka Itami (RJOO, curfew 21:00 local, T42) instead of Kansai, every time shifted so
 * the estimated landing is 45 min before the curfew: only a delay brings it within 20.
 */
export function toCurfew(c: Case): Case {
  const ofp = { ...c.ofp, destination: { ...c.ofp.destination, icao: 'RJOO', utcOffsetH: 9 } };
  const latest = latestLanding(ofp);
  const t = ofp.times;
  if (latest === null) throw new Error('RJOO has no curfew');
  const d = latest - 45 * 60_000 - (t.estOnMs ?? t.estInMs);
  return {
    name: `${c.name} to RJOO`,
    ofp: shifted(ofp, d),
    flight: { ...c.flight, snapshots: c.flight.snapshots.map((s) => ({ ...s, t: s.t + d })) },
  };
}

/** A plain synthetic flight of `ofp` that starts boarding `min` minutes late. */
export function late(ofp: Ofp, min: number): Case {
  const startMs = ofp.times.schedOutMs - 35 * 60_000 + min * 60_000;
  return { name: `late ${min}`, ofp, flight: generateSyntheticFlight({ ofp, startMs }) };
}

export const errors = (r: Run) => r.events.filter((e) => e.type === 'SCENARIO_ERROR');
export const ids = (r: Run) => r.out.map((m) => m.scenarioId);
export const missing = new RegExp(`(^|[^-])${MISSING}($|[^-])`, 'm');
export const textsOf = (r: Run, id: string) =>
  r.out.filter((m) => m.scenarioId === id).map((m) => m.message.text.replaceAll('\n', ' '));

/** Each irregular scenario alone on `c`, 3 profiles, once per answer the pilot can give. */
export function aloneOn(c: Case): void {
  describe(`each irregular scenario alone on ${c.name}`, () => {
    const cases = irregular.flatMap((s) => {
      const setup = SETUP[s.id] ?? {};
      const answers = setup.answers ?? [undefined];
      return answers.map((a) => [`${s.id}${a === undefined ? '' : ` ${a}`}`, s.id, a] as const);
    });
    it.each(cases)('%s', (_, id, answer) => {
      const setup = SETUP[id] ?? {};
      const set = [byId(id), ...(setup.with ?? []).map(byId)];
      const base = setup.lateMin === undefined ? c : late(c.ofp, setup.lateMin);
      const cc = shaped(setup.curfew === true ? toCurfew(base) : base, setup);
      for (const profile of [DEFAULT_PROFILE, B77X_PROFILE, B78X_PROFILE]) {
        const r = fly(cc, set, {
          profile,
          ...(answer === undefined ? {} : { answer }),
          ...(setup.delayMin === undefined ? {} : { delayMin: setup.delayMin }),
          ...(setup.cold === undefined ? {} : { cold: setup.cold }),
          ...(setup.divert === undefined ? {} : { divert: setup.divert }),
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
}
