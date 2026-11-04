// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  B77X_PROFILE,
  B78X_PROFILE,
  buildFlightData,
  checkText,
  DEFAULT_PROFILE,
  type FlightKind,
  generateSyntheticFlight,
  type Ofp,
  parseSimbriefOfp,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../src/index.js';
import { type Case, errors, fly, ids, missing, read, textsOf } from './irregular-fixture.js';

/** T91: charter and ferry packs; connections only on scheduled flights; no made-up next leg. */

const all = loadScenarios(
  ['base', 'commands', 'irregular', 'cargo', 'charter', 'ferry'].flatMap(read),
);
const byId = (id: string) => {
  const s = all.find((x) => x.id === id);
  if (s === undefined) throw new Error(`no scenario ${id}`);
  return { ...s, probability: 1 };
};
const pack = (dir: string) => {
  const files = new Set(read(dir).map((f) => f.file.replace(/\.yaml$/, '')));
  return all.filter((s) => files.has(s.id));
};

// biome-ignore lint/suspicious/noExplicitAny: tests mutate raw JSON freely
const raw = (): any =>
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../core/test/fixtures/ofp/rctp-rjbb-a35k-kgs.json'),
      'utf8',
    ),
  );
const paxOfp: Ofp = parseSimbriefOfp(raw());
const ferryRaw = raw();
ferryRaw.weights.pax_count = '0';
ferryRaw.weights.pax_count_actual = '0';
ferryRaw.weights.bag_count = '0';
ferryRaw.weights.freight_added = '0';
ferryRaw.weights.cargo = '0';
const ferryOfp: Ofp = parseSimbriefOfp(ferryRaw);
const pax: Case = { name: 'pax', ofp: paxOfp, flight: generateSyntheticFlight({ ofp: paxOfp }) };
const ferry: Case = {
  name: 'ferry',
  ofp: ferryOfp,
  flight: generateSyntheticFlight({ ofp: ferryOfp }),
};
const PROFILES = [DEFAULT_PROFILE, B77X_PROFILE, B78X_PROFILE];

const seedWithPaxLmc = (sign: 1 | -1): string => {
  for (let i = 0; i < 200; i++) {
    const seed = `t91-${i}`;
    if (Math.sign(buildFlightData(paxOfp, seed, undefined, 'charter_pax').load.paxLmc) === sign)
      return seed;
  }
  throw new Error('no seed');
};

describe('charter pack (T91)', () => {
  const charter = pack('charter');
  it('is for charters only', () => {
    expect(charter.map((s) => s.id).sort()).toEqual([
      'charter_group_lmc',
      'charter_sports_team',
      'charter_tour_rep',
      'charter_transfer',
      'charter_vip',
    ]);
    for (const s of charter) expect(s.def.operations, s.id).toEqual(['charter_pax']);
  });

  it.each(charter.map((s) => s.id))('%s alone on a charter, 3 profiles', (id) => {
    const seed = id === 'charter_group_lmc' ? seedWithPaxLmc(-1) : 't91';
    for (const profile of PROFILES) {
      const r = fly(pax, [byId(id)], { profile, flightKind: 'charter_pax', seed });
      expect(errors(r)).toEqual([]);
      expect(ids(r), `${id} on ${profile.id}`).toContain(id);
      for (const m of r.out) {
        expect(checkText(m.message.text, profile)).toEqual([]);
        expect(m.message.text).not.toMatch(missing);
      }
      // A scheduled flight never gets them.
      expect(ids(fly(pax, [byId(id)], { profile, flightKind: 'sched_pax', seed }))).toEqual([]);
    }
  });

  it('one charter story per flight', () => {
    const stories = ['charter_tour_rep', 'charter_sports_team', 'charter_vip'].map(byId);
    const r = fly(pax, stories, { flightKind: 'charter_pax' });
    expect(ids(r)).toHaveLength(1);
  });

  it('the tour group change names the passenger LMC of the final loadsheet', () => {
    for (const sign of [-1, 1] as const) {
      const seed = seedWithPaxLmc(sign);
      const r = fly(pax, [byId('charter_group_lmc'), byId('final_loadsheet')], {
        flightKind: 'charter_pax',
        seed,
      });
      const lmc = buildFlightData(paxOfp, seed, undefined, 'charter_pax').load.paxLmc;
      const line = `LMC PAX ${lmc > 0 ? '+' : ''}${lmc}`;
      expect(textsOf(r, 'charter_group_lmc').join(' ')).toContain(line);
      expect(textsOf(r, 'charter_group_lmc').join(' ')).toContain(
        sign < 0 ? 'NO SHOW' : 'LATE TOUR GROUP',
      );
      expect(textsOf(r, 'final_loadsheet').join(' ')).toContain(line);
    }
  });

  it('no connections, no CONNEX and no transfer passengers on a charter', () => {
    const set = ['short_connection', 'connection_made', 'arrival_info'].map(byId);
    const run = (k: FlightKind) => fly(pax, set, { flightKind: k, delayMin: 30 });
    const charterRun = run('charter_pax');
    // `#ops`: the core's RCVD to the pilot's DELAY (no handler in this set).
    expect(ids(charterRun).filter((x) => x !== '#ops')).toEqual(['arrival_info']);
    expect(textsOf(charterRun, 'arrival_info').join(' ')).not.toContain('TRANSFER PAX');
    const sched = run('sched_pax');
    expect(ids(sched)).toContain('short_connection');
    expect(textsOf(sched, 'arrival_info').join(' ')).toContain('TRANSFER PAX');
    expect(byId('connex_list').def.operations).toEqual(['sched_pax']);
  });
});

describe('ferry pack (T91)', () => {
  const ferryPack = pack('ferry');
  it('is for ferry flights only', () => {
    for (const s of ferryPack) expect(s.def.operations, s.id).toEqual(['ferry']);
  });

  it.each(['ferry_loadsheet', 'ferry_permit', 'ferry_after_mx'])(
    '%s alone on a ferry flight, 3 profiles',
    (id) => {
      for (const profile of PROFILES) {
        const r = fly(ferry, [byId(id)], { profile, flightKind: null, answer: 'ACK' });
        expect(errors(r)).toEqual([]);
        expect(ids(r), `${id} on ${profile.id}`).toContain(id);
        for (const m of r.out) {
          expect(checkText(m.message.text, profile)).toEqual([]);
          expect(m.message.text).not.toMatch(missing);
          expect(m.message.text).not.toMatch(/\bPAX \d|CGO \d|LMC/);
        }
      }
    },
  );

  it('a ferry flight gets the crew-only loadsheet and no passenger scenarios or made-up leg', () => {
    const set = [
      'prelim_loadsheet',
      'final_loadsheet',
      'cargo_final_loadsheet',
      'ferry_loadsheet',
      'next_leg',
      'aircraft_change',
      'welcome_turnaround',
      'ferry_positioning',
      'dg_notoc',
    ].map(byId);
    const r = fly(ferry, set, { flightKind: null });
    expect(ids(r)).toEqual(['ferry_loadsheet']);
    expect(textsOf(r, 'ferry_loadsheet').join(' ')).toContain('NO PAX NO CARGO');
  });

  it('the permit by the registration: N + digit SPECIAL FLIGHT PERMIT, else PERMIT TO FLY', () => {
    const text = (reg: string) => {
      const ofp = { ...ferryOfp, aircraft: { ...ferryOfp.aircraft, reg } };
      const c: Case = { name: reg, ofp, flight: ferry.flight };
      return textsOf(fly(c, [byId('ferry_permit')], { flightKind: null }), 'ferry_permit')[0];
    };
    expect(text('N123AB')).toContain('SPECIAL FLIGHT PERMIT ISSUED');
    expect(text('D-AIXA')).toContain('PERMIT TO FLY ISSUED');
    expect(text('G-KXWB')).toContain('PERMIT TO FLY ISSUED');
  });

  it('positioning only with a real departure from AeroDataBox', () => {
    const std = ferryOfp.times.schedInMs + 120 * 60_000;
    const connex = {
      icao: 'RJBB',
      list: [
        {
          number: 'SJX866',
          dest: 'RJTT',
          std,
          terminal: null,
          gate: null,
          codeshare: false,
          model: 'Airbus A350-900',
        },
      ],
    };
    const routes = { icao: 'RJBB', list: [{ dest: 'ROAH', daily: 2.5, operators: ['SJX'] }] };
    const run = (data: { connex?: typeof connex; routes?: typeof routes }) =>
      fly(ferry, [byId('ferry_positioning')], {
        flightKind: null,
        nextLegVersion: 3,
        ...data,
      });
    const real = textsOf(run({ connex }), 'ferry_positioning').join(' ');
    expect(real).toContain('NEXT SJX866');
    expect(real).toContain('SRC AERODATABOX');
    expect(ids(run({ routes }))).toEqual([]);
    expect(ids(run({}))).toEqual([]);
  });

  it('REQ LOADSHEET on a ferry flight: none yet, then the crew-only loadsheet', () => {
    const set = [
      'ferry_loadsheet',
      'cmd_req_loadsheet',
      'cmd_req_loadsheet_none',
      'cmd_req_loadsheet_ferry',
      'cmd_req_loadsheet_ferry_none',
    ].map(byId);
    const r = fly(ferry, set, { flightKind: null, until: (x) => x.out.length > 0 });
    const ask = (now: number) =>
      r.core.tick({
        now,
        telemetry: null,
        inbound: [{ from: ferryOfp.callsign, type: 'telex', text: 'REQ LOADSHEET' }],
      }).outbound;
    const t = r.out[0]?.t ?? 0;
    const again = ask(t);
    expect(again.map((m) => m.scenarioId)).toEqual(['cmd_req_loadsheet_ferry']);
    expect(again[0]?.message.text).toContain('CREW ONLY');
  });
});
