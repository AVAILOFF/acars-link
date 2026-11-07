// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AcarsCore,
  B77X_PROFILE,
  B78X_PROFILE,
  type CompiledScenario,
  type CoreEvent,
  checkText,
  DEFAULT_PROFILE,
  type DisplayProfile,
  generateSyntheticFlight,
  type Ofp,
  type OutboundMessage,
  type PilotMessage,
  parseSimbriefOfp,
  type SyntheticFlight,
  stageIndex,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../src/index.js';

/** T95: the company NOTAM summary before TOD and `REQ NOTAM [ICAO]`. */

const dir = (name: string) => join(import.meta.dirname, '..', name);
const read = (name: string) =>
  readdirSync(dir(name))
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(dir(name), file), 'utf8') }));
const everything = loadScenarios([...read('base'), ...read('commands')]);
const only = (...ids: string[]): CompiledScenario[] =>
  everything.filter((s) => ids.includes(s.id)).map((s) => ({ ...s, probability: 1 }));

const FIX = join(import.meta.dirname, '../../core/test/fixtures/ofp');
const json = (name: string) => JSON.parse(readFileSync(join(FIX, name), 'utf8'));
const notams = json('notams-rjbb-rjgg.json');

function ofpWith(dest: readonly unknown[], altn: readonly unknown[]): Ofp {
  const raw = json('rctp-rjbb-a35k-kgs.json');
  raw.destination.notam = dest;
  raw.alternate[0].notam = altn;
  return parseSimbriefOfp(raw);
}
const ofp = ofpWith(notams.destination, notams.alternate);
const plain = parseSimbriefOfp(json('rctp-rjbb-a35k-kgs.json'));

interface Run {
  readonly out: OutboundMessage[];
  readonly events: CoreEvent[];
}

function run(
  scenarios: readonly CompiledScenario[],
  o: Ofp,
  flight: SyntheticFlight,
  say: readonly { at: number; text: string }[] = [],
  profile: DisplayProfile = DEFAULT_PROFILE,
): Run {
  const core = AcarsCore.create({ ofp: o, scenarios, seed: 't95', profile });
  core.startFlight();
  const out: OutboundMessage[] = [];
  const events: CoreEvent[] = [];
  flight.snapshots.forEach((s, i) => {
    const inbound: PilotMessage[] = say
      .filter((x) => x.at === i)
      .map((x) => ({ from: o.callsign, type: 'telex', text: x.text }));
    const r = core.tick({ now: s.t, telemetry: s, ...(inbound.length > 0 ? { inbound } : {}) });
    out.push(...r.outbound);
    events.push(...r.events);
  });
  return { out, events };
}

const errors = (r: Run) => r.events.filter((e) => e.type === 'SCENARIO_ERROR');
const textsOf = (r: Run, id: string) =>
  r.out.filter((m) => m.scenarioId === id).map((m) => m.message.text);

describe('company_notam (T95)', () => {
  const flight = generateSyntheticFlight({ ofp });

  it('before TOD: destination and alternate items, as of the OFP release', () => {
    const r = run(only('company_notam', 'dest_weather'), ofp, flight);
    expect(errors(r)).toEqual([]);
    expect(r.out.map((m) => m.scenarioId)).toEqual(['company_notam', 'dest_weather']);
    // Lines as the display wraps them, joined back.
    const text = (textsOf(r, 'company_notam')[0] ?? '').replaceAll('\n', ' ');
    expect(text).toContain('COMPANY NOTAM');
    expect(text).toContain('B2496/26 TIL 141500Z');
    expect(text).toContain('RWY 06R/24L CLSD DUE TO MAINT');
    expect(text).toContain('SKED 07 09 13-14 16 20- 21 23 27-28 30 1500/2130');
    expect(text).toContain('ALTN RJGG');
    expect(text).toContain('RWY 18/36 CLSD DUE TO CONST');
    expect(text).toContain('AS OF OFP RELEASE 0702Z');
    // Taxiways, obstacles, unmanned aircraft, no subject (XX) are not in the summary.
    for (const id of ['B2651/26', 'B2568/26', 'B2543/26', 'B2043/26', 'G2218/26']) {
      expect(text).not.toContain(id);
    }
    // The aerodrome item comes before the runway one.
    expect(text.indexOf('B2496/26')).toBeLessThan(text.indexOf('B2655/26'));
  });

  it('fits every display profile', () => {
    for (const p of [DEFAULT_PROFILE, B77X_PROFILE, B78X_PROFILE]) {
      const r = run(only('company_notam'), ofp, flight, [], p);
      const m = r.out[0];
      expect(m, p.id).toBeDefined();
      expect(checkText(m?.message.text ?? '', p)).toEqual([]);
      expect(m?.message.lines.every((l) => l.length <= p.lineWidth)).toBe(true);
    }
  });

  it('nothing at the alternate: NIL SIGNIFICANT; nothing at both: no message', () => {
    const destOnly = ofpWith(notams.destination, [notams.alternate[2]]);
    const text = textsOf(run(only('company_notam'), destOnly, flight), 'company_notam')[0] ?? '';
    expect(text).toMatch(/ALTN RJGG\nNIL SIGNIFICANT/);
    const none = ofpWith([notams.destination[0]], [notams.alternate[2]]);
    expect(run(only('company_notam'), none, flight).out).toEqual([]);
    // An OFP without NOTAM (and a recording made before T95): no message.
    expect(run(only('company_notam'), plain, generateSyntheticFlight({ ofp: plain })).out).toEqual(
      [],
    );
  });
});

describe('REQ NOTAM [ICAO] (T95)', () => {
  const flight = generateSyntheticFlight({ ofp });
  const cruise = stageIndex(flight, 'CRUISE', 60);

  it('destination without an airport, the alternate, an airport not in the plan', () => {
    const r = run(only('cmd_req_notam'), ofp, flight, [
      { at: cruise, text: 'REQ NOTAM' },
      { at: cruise + 5, text: 'REQ NOTAM RJGG' },
      { at: cruise + 10, text: 'REQ NOTAM RJTT' },
      { at: cruise + 15, text: 'REQ NOTAM RCTP' },
    ]);
    expect(errors(r)).toEqual([]);
    const [dest, altn, other, origin] = textsOf(r, 'cmd_req_notam').map((t) =>
      t.replaceAll('\n', ' '),
    );
    expect(dest).toContain('NOTAM RJBB');
    expect(dest).toContain('B2655/26');
    expect(altn).toContain('G2431/26');
    expect(other).toContain('NO NOTAM DATA');
    // The origin is in the plan but SimBrief gave no NOTAM of it here.
    expect(origin).toContain('NIL SIGNIFICANT');
  });

  it('HELP lists the command', () => {
    const r = run(only('cmd_help'), ofp, flight, [{ at: cruise, text: 'HELP' }]);
    expect(r.out[0]?.message.text).toContain('REQ NOTAM ICAO');
  });
});
