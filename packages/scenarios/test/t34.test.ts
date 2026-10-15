import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AcarsCore,
  type CompiledScenario,
  generateSyntheticFlight,
  type Ofp,
  parseSimbriefOfp,
  type SimCommand,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../src/index.js';

/** T34: the `smoke` step of dest_fire reaches the app as a command naming the runway. */

const dir = (name: string) => join(import.meta.dirname, '..', name);
const read = (name: string) =>
  readdirSync(dir(name))
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(dir(name), file), 'utf8') }));
const fire: CompiledScenario = {
  ...(loadScenarios([...read('irregular')]).find((s) => s.id === 'dest_fire') as CompiledScenario),
  probability: 1,
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

function commands(answer: string | null): SimCommand[] {
  const core = AcarsCore.create({ ofp, scenarios: [fire], seed: 't34' });
  core.startFlight();
  const out: SimCommand[] = [];
  let asked = false;
  for (const s of flight.snapshots) {
    const r = core.tick({
      now: s.t,
      telemetry: s,
      ...(answer !== null && asked
        ? { inbound: [{ from: ofp.callsign, type: 'telex', text: answer }] }
        : {}),
    });
    if (r.outbound.some((m) => m.scenarioId === 'dest_fire')) asked = true;
    out.push(...r.commands);
  }
  return out;
}

describe('dest_fire smoke (T34)', () => {
  it('starts the smoke with the first message and stops it when the fire is under control', () => {
    const c = commands('HOLD').filter((x) => x.command === 'smoke');
    expect(c.map((x) => (x.command === 'smoke' ? x.action : null))).toEqual(['start', 'stop']);
    for (const x of c) {
      expect(x).toMatchObject({
        scenarioId: 'dest_fire',
        airport: ofp.destination.icao,
        runway: ofp.destination.planRwy,
      });
    }
  });

  it('DIVERT leaves the smoke burning: no stop command', () => {
    const c = commands('DIVERT').filter((x) => x.command === 'smoke');
    expect(c.map((x) => (x.command === 'smoke' ? x.action : null))).toEqual(['start']);
  });
});
