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

/** T47: MAYDAY / PAN to the XATC station start the airline's emergency chain. */

const dir = (name: string) => join(import.meta.dirname, '..', name);
const read = (name: string) =>
  readdirSync(dir(name))
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(dir(name), file), 'utf8') }));
const everything = loadScenarios([...read('base'), ...read('irregular')]);
const only = (...ids: string[]): CompiledScenario[] => everything.filter((s) => ids.includes(s.id));

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

function fly(
  say: ReadonlyMap<number, readonly PilotMessage[]>,
  ids: readonly string[],
  restoreAt = -1,
) {
  const options = {
    ofp,
    scenarios: only(...ids),
    seed: 't47',
    xatc: { enabled: true, randomDirects: false },
  };
  let core = AcarsCore.create(options);
  core.startFlight();
  const out: OutboundMessage[] = [];
  const events: CoreEvent[] = [];
  flight.snapshots.forEach((s, i) => {
    // The app restores the flight from the saved state before this tick (T64).
    if (i === restoreAt)
      core = AcarsCore.fromState(JSON.parse(JSON.stringify(core.getState())), options);
    const r = core.tick({
      now: s.t,
      telemetry: s,
      ...(say.has(i) ? { inbound: say.get(i) as PilotMessage[] } : {}),
      ...(i === 0 ? { data: { t: s.t, firs: [WORLD] } } : {}),
    });
    out.push(...r.outbound);
    events.push(...r.events);
  });
  return { core, out, events };
}
const texts = (out: readonly OutboundMessage[], id: string) =>
  out.filter((m) => m.scenarioId === id).map((m) => m.message.text.replaceAll('\n', ' '));

describe('emergency chain after MAYDAY / PAN (T47)', () => {
  const cruise = stageIndex(flight, 'CRUISE', 600);
  const logon = cpdlc('/data2/0//Y/REQUEST LOGON');

  it('MAYDAY: ROGER MAYDAY from the station, the airline desk offers a diversion, default DIVERT', () => {
    const r = fly(
      new Map([
        [cruise - 10, [logon]],
        [cruise, [cpdlc('/data2/1//Y/MAYDAY MAYDAY MAYDAY')]],
      ]),
      ['emergency_mayday'],
    );
    expect(r.events.filter((e) => e.type === 'SCENARIO_ERROR')).toEqual([]);
    expect(r.out.some((m) => m.kind === 'cpdlc' && m.message.text.includes('ROGER MAYDAY'))).toBe(
      true,
    );
    const t = texts(r.out, 'emergency_mayday');
    expect(t[0]).toContain('MAYDAY RCVD VIA ATC');
    expect(t[0]).toContain('REPLY DIVERT OR CONTINUE');
    expect(t[1]).toContain('ROGER DIVERT');
    expect(t[1]).toContain('RESCUE AND FIRE SERVICES ALERTED');
    expect(t).toHaveLength(2);
  });

  it('PAN: the answer CONTINUE keeps the destination; the same chain does not start twice', () => {
    const r = fly(
      new Map([
        [cruise - 10, [logon]],
        [cruise, [cpdlc('/data2/1//Y/PAN PAN PAN'), cpdlc('/data2/2//Y/PAN PAN PAN')]],
        [cruise + 30, [telex('CONTINUE')]],
      ]),
      ['emergency_pan'],
    );
    const t = texts(r.out, 'emergency_pan');
    expect(t[0]).toContain('PAN PAN RCVD VIA ATC');
    expect(t[1]).toContain(`ROGER CONTINUE TO ${ofp.destination.icao}`);
    expect(t).toHaveLength(2);
  });

  it('the chain due on the next tick survives a state round trip (T64)', () => {
    const say = new Map([
      [cruise - 10, [logon]],
      [cruise, [cpdlc('/data2/1//Y/MAYDAY MAYDAY MAYDAY')]],
    ]);
    const whole = fly(say, ['emergency_mayday']);
    const split = fly(say, ['emergency_mayday'], cruise + 1);
    expect(texts(split.out, 'emergency_mayday')).toEqual(texts(whole.out, 'emergency_mayday'));
    expect(texts(split.out, 'emergency_mayday')[0]).toContain('MAYDAY RCVD VIA ATC');
  });

  it('a MAYDAY is taken without a logon too: an emergency is never refused', () => {
    const r = fly(new Map([[cruise, [cpdlc('/data2/1//Y/MAYDAY MAYDAY MAYDAY')]]]), [
      'emergency_mayday',
    ]);
    expect(texts(r.out, 'emergency_mayday')[0]).toContain('MAYDAY RCVD VIA ATC');
  });

  it('never starts on its own', () => {
    const r = fly(new Map(), ['emergency_mayday', 'emergency_pan']);
    expect(r.out.filter((m) => m.scenarioId.startsWith('emergency'))).toEqual([]);
  });
});
