// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AcarsCore,
  aircraftInfo,
  B77X_PROFILE,
  B78X_PROFILE,
  BIZAV_FAMILIES,
  checkText,
  classifyFlight,
  DEFAULT_PROFILE,
  generateSyntheticFlight,
  isBizAviationType,
  type Ofp,
  parseSimbriefOfp,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../src/index.js';
import { type Case, errors, fly, ids, missing, read, textsOf } from './irregular-fixture.js';

/** T92: business aviation by type, the business pack, a flight without an airline. */

const DIRS = ['base', 'commands', 'external', 'irregular', 'sim', 'cargo', 'charter', 'ferry'];
const shipped = loadScenarios([...DIRS, 'bizav'].flatMap(read));
const byId = (id: string) => {
  const s = shipped.find((x) => x.id === id);
  if (s === undefined) throw new Error(`no scenario ${id}`);
  return { ...s, probability: 1 };
};
const bizavIds = read('bizav').map((f) => f.file.replace(/\.yaml$/, ''));

// biome-ignore lint/suspicious/noExplicitAny: tests mutate raw JSON freely
const raw = (): any =>
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../core/test/fixtures/ofp/rctp-rjbb-a35k-kgs.json'),
      'utf8',
    ),
  );

/** A Citation Latitude with 4 passengers, no airline, the registration as the callsign. */
const jetRaw = (dest?: string) => {
  const r = raw();
  r.general.icao_airline = '';
  r.general.flight_number = '';
  r.atc.callsign = 'N680AB';
  r.aircraft.icao_code = 'C68A';
  r.aircraft.reg = 'N680AB';
  r.aircraft.max_passengers = '9';
  r.weights.pax_count = '4';
  r.weights.pax_count_actual = '4';
  r.weights.bag_count = '4';
  r.weights.freight_added = '0';
  if (dest !== undefined) r.destination.icao_code = dest;
  return r;
};
const jet: Ofp = parseSimbriefOfp(jetRaw());
const jetCase: Case = { name: 'jet', ofp: jet, flight: generateSyntheticFlight({ ofp: jet }) };
const PROFILES = [DEFAULT_PROFILE, B77X_PROFILE, B78X_PROFILE];

describe('business aviation types (T92, ICAO Doc 8643)', () => {
  it.each([
    ['C68A', 'CITATION', 'CESSNA'],
    ['C25C', 'CITATION', 'CESSNA'],
    ['CL35', 'CHALLENGER', 'BOMBARDIER'],
    ['GL7T', 'GLOBAL', 'BOMBARDIER'],
    ['GLF6', 'GULFSTREAM', 'GULFSTREAM AEROSPACE'],
    ['FA7X', 'FALCON', 'DASSAULT'],
    ['LJ75', 'LEARJET', 'LEARJET'],
    ['E55P', 'PHENOM', 'EMBRAER'],
    ['PC24', 'PC-24', 'PILATUS'],
    ['HDJT', 'HONDAJET', 'HONDA'],
    ['SF50', 'VISION', 'CIRRUS'],
    ['B350', 'KING AIR', 'BEECH'],
    ['PC12', 'PC-12', 'PILATUS'],
    ['TBM9', 'TBM', 'SOCATA'],
  ])('%s → %s (%s), business aviation, no alerting system named', (code, family, maker) => {
    const a = aircraftInfo(code);
    expect(a?.family).toBe(family);
    expect(a?.maker).toBe(maker);
    expect(a?.alertSys).toBeNull();
    expect(isBizAviationType(code)).toBe(true);
  });

  it('airliners are not business aviation (BBJ / ACJ share their designators)', () => {
    for (const code of ['B738', 'A20N', 'B77L', 'E190', 'CRJ9', 'AT76', null])
      expect(isBizAviationType(code)).toBe(false);
    expect(BIZAV_FAMILIES.size).toBe(16);
  });

  it('classifyFlight: the type makes business aviation, after cargo, ferry and FPL type G', () => {
    const k = classifyFlight(jet);
    expect(k).toMatchObject({ kind: 'bizav', rule: 'aircraft_type', aircraftType: 'C68A' });
    const g = raw();
    g.atc.flight_type = 'G';
    expect(classifyFlight(parseSimbriefOfp(g))).toMatchObject({
      kind: 'bizav',
      rule: 'flight_type',
    });
    // An empty leg of a jet is a ferry flight (D2 of T89).
    const empty = jetRaw();
    empty.weights.pax_count = '0';
    empty.weights.pax_count_actual = '0';
    expect(classifyFlight(parseSimbriefOfp(empty)).kind).toBe('ferry');
    expect(classifyFlight(jet, 'sched_pax').kind).toBe('sched_pax');
  });
});

describe('business pack (T92)', () => {
  it('is for business flights only', () => {
    for (const id of bizavIds) expect(byId(id).def.operations, id).toEqual(['bizav']);
  });

  const alone = bizavIds.filter((id) => id !== 'cmd_req_loadsheet_bizav' && id !== 'bizav_eapis');
  it.each(alone)('%s alone on a business flight, 3 profiles', (id) => {
    for (const profile of PROFILES) {
      const r = fly(jetCase, [byId(id)], { profile, flightKind: null });
      expect(errors(r)).toEqual([]);
      expect(ids(r), `${id} on ${profile.id}`).toContain(id);
      for (const m of r.out) {
        expect(checkText(m.message.text, profile)).toEqual([]);
        expect(m.message.text).not.toMatch(missing);
        expect(m.message.text).toContain('FLIGHT SUPPORT');
      }
    }
  });

  it('eAPIS only into the US from outside', () => {
    const into = (dest: string, orig?: string) => {
      const r = jetRaw(dest);
      if (orig !== undefined) r.origin.icao_code = orig;
      const ofp = parseSimbriefOfp(r);
      const c: Case = { name: dest, ofp, flight: generateSyntheticFlight({ ofp }) };
      return ids(fly(c, [byId('bizav_eapis')], { flightKind: null }));
    };
    expect(into('KTEB')).toEqual(['bizav_eapis']);
    expect(into('PHNL')).toEqual(['bizav_eapis']);
    expect(into('PANC')).toEqual(['bizav_eapis']);
    expect(into('RJBB')).toEqual([]);
    expect(into('PGUM')).toEqual([]);
    expect(into('KTEB', 'KVNY')).toEqual([]);
  });

  it('REQ LOADSHEET: no loadsheet, weight and balance by the crew', () => {
    const set = [
      'cmd_req_loadsheet',
      'cmd_req_loadsheet_none',
      'cmd_req_loadsheet_bizav',
      'bizav_handling',
    ].map(byId);
    const r = fly(jetCase, set, { flightKind: null, until: (x) => x.out.length > 0 });
    const out = r.core.tick({
      now: r.out[0]?.t ?? 0,
      telemetry: null,
      inbound: [{ from: jet.callsign, type: 'telex', text: 'REQ LOADSHEET' }],
    }).outbound;
    expect(out.map((m) => m.scenarioId)).toEqual(['cmd_req_loadsheet_bizav']);
    expect(out[0]?.message.text).toContain('MASS AND BALANCE BY CREW');
  });
});

describe('a business flight without an airline, the registration as callsign (T92)', () => {
  // Every chance 1 except the irregular events of all kinds (an emergency would divert the
  // flight before its arrival messages); the passenger ones among them are tried by T89.
  const scenarios = shipped.map((s) =>
    s.def.category === 'irregular' && !s.id.startsWith('bizav') ? s : { ...s, probability: 1 },
  );
  const run = () => {
    const core = AcarsCore.create({
      ofp: jet,
      scenarios,
      seed: 't92',
      flightKind: { override: null },
      xatc: { enabled: true },
      nextLegVersion: 3,
      station: 'OPS{flight}',
    });
    core.startFlight();
    const out = [];
    const events = [];
    const commands = [];
    for (const s of jetCase.flight.snapshots) {
      const r = core.tick({ now: s.t, telemetry: s });
      out.push(...r.outbound);
      events.push(...r.events);
      commands.push(...r.commands);
    }
    return { core, out, events, commands };
  };
  const r = run();

  it('runs through without errors; telexes from the station of the registration', () => {
    expect(r.core.flightKind?.kind).toBe('bizav');
    expect(r.events.filter((e) => e.type === 'SCENARIO_ERROR')).toEqual([]);
    const telex = r.out.filter((m) => m.kind === 'telex');
    expect(telex.length).toBeGreaterThan(0);
    for (const m of telex) {
      expect(m.from).toBe('OPSN680AB');
      expect(m.to).toBe('N680AB');
      expect(m.message.text).not.toMatch(missing);
    }
  });

  it('flight support messages; no airline loadsheet, NOTOC, CONNEX, made-up next leg or VDGS', () => {
    const sent = new Set(r.out.map((m) => m.scenarioId));
    for (const id of ['bizav_handling', 'bizav_fuel_release', 'bizav_catering', 'bizav_arrival'])
      expect(sent.has(id), id).toBe(true);
    for (const id of [
      'prelim_loadsheet',
      'final_loadsheet',
      'dg_notoc',
      'connex_list',
      'short_connection',
      'next_leg',
      'aircraft_change',
      'welcome_turnaround',
      'gate_assignment',
      'arrival_info',
      'crew_info',
      'unruly_passenger',
      'medical_onboard',
      'vdgs_arrival',
    ])
      expect(sent.has(id), id).toBe(false);
    expect(r.commands.filter((c) => c.command === 'vdgs')).toEqual([]);
    expect(textsOf(r, 'bizav_handling').join(' ')).toContain('N680AB');
  });
});
