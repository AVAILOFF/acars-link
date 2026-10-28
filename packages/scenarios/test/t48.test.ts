// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AcarsCore,
  type CompiledScenario,
  type CoreEvent,
  type FirArea,
  generateSyntheticFlight,
  type Ofp,
  type OutboundMessage,
  type PilotMessage,
  parseSimbriefOfp,
  stageIndex,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../src/index.js';
import { withHoldMin } from './hold.js';

/** T48: the airline's diversion and holding reach the aircraft through the XATC station. */

const dir = (name: string) => join(import.meta.dirname, '..', name);
const read = (name: string) =>
  readdirSync(dir(name))
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(dir(name), file), 'utf8') }));
const everything = loadScenarios([...read('base'), ...read('commands'), ...read('irregular')]);
const only = (...ids: string[]): CompiledScenario[] =>
  everything
    .filter((s) => ids.includes(s.id))
    // The emergency chains start only after a MAYDAY / PAN (probability 0).
    .map((s) => (s.id.startsWith('emergency_') ? s : { ...s, probability: 1 }))
    // T50: the length of the holding is drawn; here it is short so that the flight sees it end.
    .map((s) => (s.id === 'drone_activity' ? withHoldMin(s, 5) : s));

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

const logon: PilotMessage = {
  from: ofp.callsign,
  type: 'cpdlc',
  text: '/data2/0//Y/REQUEST LOGON',
  to: 'XCAA',
};
const telex = (text: string): PilotMessage => ({ from: ofp.callsign, type: 'telex', text });

function fly(
  say: ReadonlyMap<number, readonly PilotMessage[]>,
  ids: readonly string[],
  o: { logon?: boolean } = {},
) {
  const core = AcarsCore.create({
    ofp,
    scenarios: only(...ids),
    seed: 't48',
    xatc: { enabled: true, randomDirects: false },
  });
  core.startFlight();
  const out: OutboundMessage[] = [];
  const events: CoreEvent[] = [];
  flight.snapshots.forEach((s, i) => {
    const inbound = [...(i === 5 && o.logon !== false ? [logon] : []), ...(say.get(i) ?? [])];
    const r = core.tick({
      now: s.t,
      telemetry: s,
      ...(inbound.length > 0 ? { inbound } : {}),
      ...(i === 0 ? { data: { t: s.t, firs: [WORLD] } } : {}),
    });
    out.push(...r.outbound);
    events.push(...r.events);
  });
  return { core, out, events };
}
const cp = (out: readonly OutboundMessage[]) =>
  out.filter((m) => m.kind === 'cpdlc').map((m) => m.message.text);

describe('airline → XATC (T48)', () => {
  const cruise = stageIndex(flight, 'CRUISE', 600);
  const altn = ofp.alternates[0]?.icao as string;

  it('the pilot DIVERT: a direct to the alternate comes through the station', () => {
    const r = fly(new Map([[cruise, [telex(`DIVERT ${altn}`)]]]), ['cmd_divert']);
    expect(r.core.phase).not.toBe('PREFLIGHT');
    expect(cp(r.out).filter((t) => t.includes(`PROCEED DIRECT TO @${altn}@`))).toHaveLength(1);
    // No clearance of the old route after the diversion.
    const at = r.out.findIndex((m) => m.message.text.includes(`PROCEED DIRECT TO @${altn}@`));
    const later = r.out.slice(at + 1).filter((m) => m.kind === 'cpdlc');
    expect(later.some((m) => m.message.text.includes('DESCEND TO @FL250@'))).toBe(false);
  });

  it('a scenario diversion (MAYDAY, default DIVERT) reaches the station too, after ROGER MAYDAY', () => {
    const r = fly(
      new Map([
        [
          cruise,
          [
            {
              from: ofp.callsign,
              type: 'cpdlc',
              text: '/data2/1//Y/MAYDAY MAYDAY MAYDAY',
              to: 'XCAA',
            },
          ],
        ],
      ]),
      ['emergency_mayday'],
    );
    const t = cp(r.out);
    const roger = t.findIndex((x) => x.includes('ROGER MAYDAY'));
    const direct = t.findIndex((x) => x.includes('PROCEED DIRECT TO @'));
    expect(roger).toBeGreaterThan(-1);
    expect(direct).toBeGreaterThan(roger);
  });

  it('HOLD of drone_activity: HOLD AT a fix with the expected further clearance', () => {
    const r = fly(new Map(), ['drone_activity']);
    const t = cp(r.out);
    const hold = t.findIndex((x) => x.includes('HOLD AT @'));
    if (!r.out.some((m) => m.scenarioId === 'drone_activity')) {
      throw new Error('drone_activity did not start on the synthetic flight');
    }
    expect(hold).toBeGreaterThan(-1);
    expect(t[hold + 1]).toContain('EXPECT FURTHER CLEARANCE AT @');
    // Resumed: a direct to the next fix after the holding is over.
    expect(t.slice(hold + 2).some((x) => x.includes('PROCEED DIRECT TO @'))).toBe(true);
  });

  it('without a logon the airline speaks alone', () => {
    const r = fly(new Map(), ['drone_activity'], { logon: false });
    expect(cp(r.out).some((x) => x.includes('HOLD AT'))).toBe(false);
    expect(r.out.some((m) => m.scenarioId === 'drone_activity')).toBe(true);
  });

  it('is deterministic', () => {
    const a = fly(new Map(), ['drone_activity']);
    const b = fly(new Map(), ['drone_activity']);
    expect(cp(a.out)).toEqual(cp(b.out));
  });
});
