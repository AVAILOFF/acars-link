// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AcarsCore,
  buildFlightData,
  type ExtDataUpdate,
  generateSyntheticFlight,
  type Ofp,
  type OutboundMessage,
  parseSimbriefOfp,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../src/index.js';
import { standsFor } from './stands.js';

/**
 * T55: the next leg of `next_leg` / `welcome_turnaround` from the AeroDataBox data (core
 * `nextLegVersion: 3`): a real departure with its number, place and STD, else a route of the
 * statistics, else as T53 — with the attribution line (C4) only when the data were used.
 */

const BASE = join(import.meta.dirname, '..', 'base');
const all = loadScenarios(
  readdirSync(BASE)
    .filter((f) => f.endsWith('.yaml'))
    .map((file) => ({ file, source: readFileSync(join(BASE, file), 'utf8') })),
);
const byId = (id: string) => {
  const s = all.find((x) => x.id === id);
  if (s === undefined) throw new Error(`no scenario ${id}`);
  return { ...s, probability: 1 };
};
const kg: Ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../core/test/fixtures/ofp/rctp-rjbb-a35k-kgs.json'),
      'utf8',
    ),
  ),
);
const flight = generateSyntheticFlight({ ofp: kg });
const SEED = 't55';
const sta = kg.times.schedInMs;
const turn = buildFlightData(kg, SEED, { version: 3, hub: null }).ops.turnaroundMin;
const std = sta + (turn + 25) * 60_000;
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16).replace(':', '');

function fly(o: { version: 1 | 2 | 3; data?: Omit<ExtDataUpdate, 't'> }): OutboundMessage[] {
  const core = AcarsCore.create({
    ofp: kg,
    scenarios: ['next_leg', 'welcome_turnaround'].map(byId),
    seed: SEED,
    nextLegVersion: o.version,
  });
  core.startFlight();
  const out: OutboundMessage[] = [];
  flight.snapshots.forEach((s, i) => {
    const data = i === 0 ? { ...standsFor(kg, s.t), ...o.data, t: s.t } : undefined;
    out.push(
      ...core.tick({ now: s.t, telemetry: s, ...(data === undefined ? {} : { data }) }).outbound,
    );
  });
  return out;
}
const text = (out: OutboundMessage[], id: string) =>
  out.find((m) => m.scenarioId === id)?.message.text ?? '';

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

describe('next leg from AeroDataBox (T55)', () => {
  it('level 1: the real departure in NEXT LEG and WELCOME, with the source line', () => {
    const out = fly({ version: 3, data: { connex } });
    const next = text(out, 'next_leg');
    expect(next).toContain('NEXT SECTOR SJX866');
    expect(next).toContain('RJBB-RJTT');
    expect(next).toContain(`STD ${hhmm(std)}Z`);
    expect(next.trimEnd().endsWith('SRC AERODATABOX')).toBe(true);
    const welcome = text(out, 'welcome_turnaround');
    expect(welcome).toContain('NEXT SJX866');
    expect(welcome).toContain('SRC AERODATABOX');
  });

  it('level 2: a route of the statistics, the STD of STA + turnaround, with the source line', () => {
    const next = text(fly({ version: 3, data: { routes } }), 'next_leg');
    expect(next).toContain('RJBB-ROAH');
    expect(next).toMatch(/NEXT SECTOR SJX\d{3}\n/);
    expect(next).toContain('SRC AERODATABOX');
    const v2 = text(fly({ version: 2 }), 'next_leg');
    expect(/STD \d{4}Z/.exec(next)?.[0]).toBe(/STD \d{4}Z/.exec(v2)?.[0]);
  });

  it('level 3 or version 2: the T53 texts, no source line', () => {
    const v2 = fly({ version: 2, data: { connex, routes } });
    const none = fly({ version: 3 });
    for (const id of ['next_leg', 'welcome_turnaround']) {
      expect(text(none, id)).toBe(text(fly({ version: 2 }), id));
      expect(text(v2, id)).toBe(text(none, id));
      expect(text(none, id)).not.toContain('AERODATABOX');
    }
  });
});
