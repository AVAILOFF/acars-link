// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AcarsCore,
  type CoreEvent,
  type FirArea,
  generateSyntheticFlight,
  type Ofp,
  type PilotMessage,
  parseSimbriefOfp,
  type RescueCommand,
  type SyntheticStage,
  stageIndex,
  type TelemetrySnapshot,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../src/index.js';

/** T88: MAYDAY / PAN on the ground: services at the airport where the aircraft stands, no DIVERT question. */

const dir = (name: string) => join(import.meta.dirname, '..', name);
const read = (name: string) =>
  readdirSync(dir(name))
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(dir(name), file), 'utf8') }));
const emergency = loadScenarios(read('irregular')).filter((s) =>
  ['emergency_mayday', 'emergency_pan'].includes(s.id),
);

const ofp: Ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../core/test/fixtures/ofp/rctp-rjbb-a35k-kgs.json'),
      'utf8',
    ),
  ),
);
const flight = generateSyntheticFlight({ ofp });
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
const cpdlc = (text: string): PilotMessage => ({
  from: ofp.callsign,
  type: 'cpdlc',
  text,
  to: 'XCAA',
});
const telex = (text: string): PilotMessage => ({ from: ofp.callsign, type: 'telex', text });
const MAYDAY = cpdlc('/data2/1//Y/MAYDAY MAYDAY MAYDAY');
const PAN = cpdlc('/data2/1//Y/PAN PAN PAN');

interface Run {
  readonly rescue: RescueCommand[];
  readonly telexes: string[];
  readonly events: CoreEvent[];
}

/**
 * The synthetic flight with `say` at a stage; `move` shifts the positions before that moment (an
 * aircraft standing far from every airport of the flight).
 */
function fly(
  stage: SyntheticStage,
  say: PilotMessage,
  o: { rescueVersion?: 1 | 2; offsetSec?: number; move?: number; answer?: string } = {},
): Run {
  const core = AcarsCore.create({
    ofp,
    scenarios: emergency,
    seed: 't88',
    xatc: { enabled: true, randomDirects: false },
    rescueVersion: o.rescueVersion ?? 2,
  });
  core.startFlight();
  const at = stageIndex(flight, stage, o.offsetSec ?? 60);
  const run: Run = { rescue: [], telexes: [], events: [] };
  flight.snapshots.slice(0, at + 600).forEach((s, i) => {
    const tm: TelemetrySnapshot =
      o.move !== undefined && i <= at + 5 ? { ...s, lat: s.lat + o.move } : s;
    const inbound =
      i === at ? [say] : i === at + 30 && o.answer !== undefined ? [telex(o.answer)] : [];
    const r = core.tick({
      now: s.t,
      telemetry: tm,
      ...(inbound.length > 0 ? { inbound } : {}),
      ...(i === 0 ? { data: { t: s.t, firs: [WORLD] } } : {}),
    });
    for (const c of r.commands) if (c.command === 'rescue') run.rescue.push(c);
    // The formatter wraps at the display width: compare the words.
    for (const m of r.outbound)
      if (m.scenarioId.startsWith('emergency_'))
        run.telexes.push(m.message.text.replace(/\s+/g, ' '));
    run.events.push(...r.events);
  });
  return run;
}

const orig = ofp.origin;
const dest = ofp.destination;

describe('MAYDAY / PAN on the ground (T88)', () => {
  it('MAYDAY at the gate: no DIVERT question, full at the origin with its planned runway, a ground call', () => {
    const r = fly('GATE', MAYDAY);
    expect(r.telexes).toHaveLength(1);
    expect(r.telexes[0]).toContain('RESCUE AND FIRE SERVICES ALERTED');
    expect(r.telexes[0]).toContain(`AT ${orig.icao}`);
    expect(r.telexes[0]).not.toContain('DIVERT');
    expect(r.rescue).toEqual([
      expect.objectContaining({
        scenarioId: 'emergency_mayday',
        action: 'start',
        level: 'full',
        airport: orig.icao,
        runway: orig.planRwy ?? null,
        ground: true,
      }),
    ]);
  });

  it('PAN on the taxi out: standby at the origin', () => {
    const r = fly('TAXI_OUT', PAN);
    expect(r.telexes[0]).toContain('RESCUE AND MEDICAL STANDBY');
    expect(r.telexes[0]).toContain(`AT ${orig.icao}`);
    expect(r.rescue.map((c) => [c.level, c.airport, c.ground])).toEqual([
      ['standby', orig.icao, true],
    ]);
  });

  it('MAYDAY after landing without a diversion: at the airport where the aircraft stands', () => {
    const r = fly('TAXI_IN', MAYDAY);
    expect(r.telexes[0]).toContain(`AT ${dest.icao}`);
    expect(r.rescue.map((c) => [c.airport, c.runway, c.ground])).toEqual([
      [dest.icao, dest.planRwy ?? null, true],
    ]);
  });

  it('no airport of the flight within 5 NM: no command, an event, the telex without AT', () => {
    const r = fly('GATE', MAYDAY, { move: 2 });
    expect(r.rescue).toEqual([]);
    expect(r.events).toContainEqual(
      expect.objectContaining({ type: 'RESCUE_NO_AIRPORT', id: 'emergency_mayday' }),
    );
    expect(r.telexes[0]).toContain('RESCUE AND FIRE SERVICES ALERTED');
    expect(r.telexes[0]).not.toContain(' AT ');
  });

  it('in the air nothing changes: the DIVERT question, CONTINUE goes to the destination, no ground call', () => {
    const r = fly('CRUISE', MAYDAY, { answer: 'CONTINUE' });
    expect(r.telexes[0]).toContain('REPLY DIVERT OR CONTINUE');
    expect(r.rescue).toEqual([
      expect.objectContaining({ level: 'full', airport: dest.icao, runway: dest.planRwy }),
    ]);
    expect(r.rescue[0]).not.toHaveProperty('ground');
  });

  it('rescueVersion 1 (recordings before T88): on the ground to the destination, as recorded', () => {
    const r = fly('GATE', MAYDAY, { rescueVersion: 1 });
    expect(r.rescue.map((c) => [c.airport, c.runway])).toEqual([[dest.icao, dest.planRwy]]);
    expect(r.rescue[0]).not.toHaveProperty('ground');
  });
});
