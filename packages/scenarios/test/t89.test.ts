// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AcarsCore,
  type CompiledScenario,
  type CoreEvent,
  type FlightKind,
  generateSyntheticFlight,
  type Ofp,
  PASSENGER_KINDS,
  parseSimbriefOfp,
  stageIndex,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../src/index.js';

/** T89: the passenger scenarios name their kinds of flight and do not run on a cargo flight. */

const dir = (name: string) => join(import.meta.dirname, '..', name);
const read = (name: string) =>
  readdirSync(dir(name))
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(dir(name), file), 'utf8') }));
const everything = loadScenarios(
  [
    'base',
    'commands',
    'irregular',
    'external',
    'sim',
    'cargo',
    'charter',
    'ferry',
    'bizav',
  ].flatMap(read),
);

/** Passengers in the cabin (docs/07, T89; `cmd_medical` stays for all: a crew member may fall ill). */
const PASSENGER_SCENARIOS = [
  'boarding_completed',
  'connection_held',
  'connection_made',
  'connection_missed',
  'connex_list',
  'lost_baggage',
  'medical_onboard',
  'ped_fire_cabin',
  'rush_bags_followup',
  'short_connection',
  'unruly_followup',
  'unruly_passenger',
  'vip_onboard',
];

// biome-ignore lint/suspicious/noExplicitAny: tests mutate raw JSON freely
const raw = (): any =>
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../core/test/fixtures/ofp/rctp-rjbb-a35k-kgs.json'),
      'utf8',
    ),
  );
const cargoRaw = raw();
cargoRaw.weights.pax_count = '0';
cargoRaw.weights.freight_added = '30000';
cargoRaw.weights.cargo = '30000';
const cargo: Ofp = parseSimbriefOfp(cargoRaw);

describe('operations of the scenario files (T89)', () => {
  it('exactly the passenger scenarios are limited to the passenger kinds', () => {
    // T91: the connections are for scheduled flights only (a charter has none).
    const connections = PASSENGER_SCENARIOS.filter(
      (id) => id.startsWith('conn') || id === 'short_connection',
    );
    const ops = (id: string) => everything.find((s) => s.id === id)?.def.operations;
    for (const id of PASSENGER_SCENARIOS)
      expect(ops(id), id).toEqual(connections.includes(id) ? ['sched_pax'] : PASSENGER_KINDS);
    const limited = everything.filter((s) =>
      (s.def.operations ?? []).every((k) => PASSENGER_KINDS.includes(k)),
    );
    expect(
      limited
        .filter((s) => s.def.operations !== undefined)
        .map((s) => s.id)
        .sort(),
    ).toEqual(
      [
        ...PASSENGER_SCENARIOS,
        'charter_group_lmc',
        'charter_sports_team',
        'charter_tour_rep',
        'charter_transfer',
        'charter_vip',
      ].sort(),
    );
  });

  it('a cargo flight starts none of them, by hand neither', () => {
    // Every chance 1, so a passenger scenario would start whenever its trigger fires.
    const scenarios: CompiledScenario[] = everything.map((s) => ({ ...s, probability: 1 }));
    const flight = generateSyntheticFlight({ ofp: cargo });
    const run = (override: FlightKind | null) => {
      const core = AcarsCore.create({
        ofp: cargo,
        scenarios,
        seed: 't89',
        syntheticConnections: true,
        flightKind: { override },
      });
      core.startFlight();
      const gate = stageIndex(flight, 'GATE', 30);
      const events: CoreEvent[] = [];
      flight.snapshots.forEach((s, i) => {
        const r = core.tick({
          now: s.t,
          telemetry: s,
          ...(i === gate ? { force: ['unruly_passenger', 'medical_onboard'] } : {}),
        });
        events.push(...r.events);
      });
      return events;
    };
    const started = (events: CoreEvent[]) =>
      events.flatMap((e) => (e.type === 'SCENARIO_STARTED' ? [e.id] : []));

    const asCargo = run(null);
    expect(started(asCargo).filter((id) => PASSENGER_SCENARIOS.includes(id))).toEqual([]);
    expect(
      asCargo.filter((e) => e.type === 'FORCED').map((e) => (e as { result: string }).result),
    ).toEqual(['operation', 'operation']);

    // The user's "scheduled" brings them back: the kind no longer stops them (their own conditions
    // may, at the gate), and a passenger scenario starts in the flight.
    const asPax = run('sched_pax');
    expect(
      asPax.filter((e) => e.type === 'FORCED').map((e) => (e as { result: string }).result),
    ).not.toContain('operation');
    expect(started(asPax).some((id) => PASSENGER_SCENARIOS.includes(id))).toBe(true);
  });
});
