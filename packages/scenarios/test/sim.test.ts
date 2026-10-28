// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AcarsCore,
  generateSyntheticFlight,
  type Ofp,
  parseSimbriefOfp,
  type SimCommand,
  type VdgsCommand,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../src/index.js';
import { standsFor } from './stands.js';

/** T22: sim-effect scenarios (`sim/`): VDGS text for GSX. */

const DIR = join(import.meta.dirname, '..', 'sim');
const OFPS = join(import.meta.dirname, '../../core/test/fixtures/ofp');
const sim = loadScenarios(
  readdirSync(DIR)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(DIR, file), 'utf8') })),
);
const ofpOf = (name: string): Ofp =>
  parseSimbriefOfp(JSON.parse(readFileSync(join(OFPS, `${name}.json`), 'utf8')));

function fly(ofp: Ofp, stands = true, say?: string) {
  const core = AcarsCore.create({ ofp, scenarios: sim, seed: 'sim' });
  core.startFlight();
  const commands: SimCommand[] = [];
  const errors: string[] = [];
  let said = false;
  for (const [i, s] of generateSyntheticFlight({ ofp }).snapshots.entries()) {
    const out = core.tick({
      now: s.t,
      telemetry: s,
      ...(i === 0 && stands ? { data: standsFor(ofp, s.t) } : {}),
      ...(say !== undefined && s.altFt > 30_000 && !said
        ? { inbound: [{ from: ofp.callsign, type: 'telex' as const, text: say }] }
        : {}),
    });
    if (say !== undefined && s.altFt > 30_000) said = true;
    commands.push(...out.commands);
    expect(out.outbound.filter((m) => m.scenarioId !== '#ops')).toEqual([]);
    for (const e of out.events) if (e.type === 'SCENARIO_ERROR') errors.push(e.error);
  }
  return { commands, errors };
}

describe('sim scenarios', () => {
  it('the two VDGS scenarios', () => {
    expect(sim.map((s) => s.id)).toEqual(['vdgs_arrival', 'vdgs_divert']);
  });

  it('vdgs_arrival: flight, origin and gate at the destination after landing', () => {
    const r = fly(ofpOf('rctp-rjbb-a35k-kgs'));
    expect(r.errors).toEqual([]);
    expect(r.commands).toHaveLength(1);
    const v = (r.commands[0] as VdgsCommand).vdgs;
    expect(v.airport).toBe('RJBB');
    const narrow = (v.displays.narrow ?? []).map((l) => l.text);
    expect(narrow.slice(0, 5)).toEqual(['SJX', '822', 'FROM', 'RCTP', 'GATE']);
    expect(narrow[5]).toMatch(/^[A-Z0-9]{1,6}$/);
    expect((v.displays.wide ?? []).map((l) => l.text)).toEqual([
      'SJX 822',
      'FROM RCTP',
      `GATE ${narrow[5]}`,
    ]);
    expect(v.displays.small).toBeUndefined();
  });

  it('vdgs_arrival on an OFP without a flight number: no error', () => {
    const r = fly(ofpOf('rctp-rjbb-a35k-lbs-synthetic'));
    expect(r.errors).toEqual([]);
  });

  it('vdgs_divert: a red DIVERTED line at the diversion airport, no gate; none without a diversion', () => {
    const ofp = ofpOf('rctp-rjbb-a35k-kgs');
    const altn = ofp.alternates[0]?.icao as string;
    const r = fly(ofp, true, `DIVERT ${altn}`);
    expect(r.errors).toEqual([]);
    expect(r.commands).toHaveLength(1);
    const v = (r.commands[0] as VdgsCommand).vdgs;
    expect(v.airport).toBe(altn);
    expect(v.displays.wide).toEqual([
      expect.objectContaining({ text: 'SJX 822' }),
      expect.objectContaining({ text: 'DIVERTED' }),
      expect.objectContaining({ text: 'FROM RCTP' }),
    ]);
    expect(JSON.stringify(v)).toMatch(/red/i);
    expect(JSON.stringify(v)).not.toContain('GATE');
  });
});
