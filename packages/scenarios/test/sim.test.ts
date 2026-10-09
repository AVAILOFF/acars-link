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

function fly(ofp: Ofp) {
  const core = AcarsCore.create({ ofp, scenarios: sim, seed: 'sim' });
  core.startFlight();
  const commands: SimCommand[] = [];
  const errors: string[] = [];
  for (const s of generateSyntheticFlight({ ofp }).snapshots) {
    const out = core.tick({ now: s.t, telemetry: s });
    commands.push(...out.commands);
    expect(out.outbound).toEqual([]);
    for (const e of out.events) if (e.type === 'SCENARIO_ERROR') errors.push(e.error);
  }
  return { commands, errors };
}

describe('sim scenarios', () => {
  it('vdgs_arrival only', () => {
    expect(sim.map((s) => s.id)).toEqual(['vdgs_arrival']);
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
});
