// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AcarsCore,
  type CompiledScenario,
  firePlace,
  generateSyntheticFlight,
  type Ofp,
  parseSimbriefOfp,
  type SimCommand,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../src/index.js';
import { withHoldMin } from './hold.js';

/** T34: the `smoke` step of dest_fire reaches the app as a command naming the runway. */

const dir = (name: string) => join(import.meta.dirname, '..', name);
const read = (name: string) =>
  readdirSync(dir(name))
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(dir(name), file), 'utf8') }));
const fire: CompiledScenario = {
  ...withHoldMin(
    loadScenarios([...read('irregular')]).find((s) => s.id === 'dest_fire') as CompiledScenario,
    5,
  ),
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

describe('fire at a random point (2026-10-16)', () => {
  it('dest_fire: the smoke is beside the runway (0.8 NM along, 0.1-0.3 NM off), the text says which side', () => {
    const seen = new Set<string>();
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const core = AcarsCore.create({ ofp, scenarios: [fire], seed });
      core.startFlight();
      for (const s of flight.snapshots) {
        const r = core.tick({ now: s.t, telemetry: s });
        const start = r.commands.find((x) => x.command === 'smoke' && x.action === 'start');
        if (start === undefined || start.command !== 'smoke') continue;
        const o = start.offset;
        expect(o).toBeDefined();
        expect(Math.abs(o?.alongNm ?? 9)).toBeLessThanOrEqual(0.8);
        expect(Math.abs(o?.sideNm ?? 0)).toBeGreaterThanOrEqual(0.1);
        expect(Math.abs(o?.sideNm ?? 9)).toBeLessThanOrEqual(0.3);
        seen.add(`${o?.alongNm}/${o?.sideNm}`);
        const text = (
          r.outbound.find((m) => m.scenarioId === 'dest_fire')?.message.text ?? ''
        ).replace(/\s+/g, ' ');
        expect(text).toContain(firePlace(ofp.destination.planRwy, o ?? null));
      }
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('firePlace: the side of the runway from its number', () => {
    expect(firePlace('24R', null)).toBe('NEAR RWY 24R');
    expect(firePlace('24L', { alongNm: 0.3, sideNm: 0.2 })).toBe('NW SIDE OF RWY 24L');
    expect(firePlace('24L', { alongNm: -0.5, sideNm: -0.2 })).toBe('SE SIDE OF RWY 24L');
    expect(firePlace('09', { alongNm: 0, sideNm: 0.1 })).toBe('S SIDE OF RWY 09');
    expect(firePlace('N', { alongNm: 0, sideNm: 0.1 })).toBe('NEAR RWY N');
    expect(firePlace(null, { alongNm: 0, sideNm: 0.1 })).toBe('NEAR THE AIRPORT');
  });
});

describe('dep_fire: fire before takeoff (2026-10-16)', () => {
  const dep: CompiledScenario = {
    ...withHoldMin(
      loadScenarios([...read('irregular')]).find((s) => s.id === 'dep_fire') as CompiledScenario,
      20,
    ),
    probability: 1,
  };

  /** Flies the synthetic flight; `waitMin` keeps the aircraft at the gate that long more. */
  function fly(waitMin: number) {
    const f = generateSyntheticFlight({ ofp, boardingSec: (35 + waitMin) * 60 });
    const core = AcarsCore.create({ ofp, scenarios: [dep], seed: 'dep' });
    core.startFlight();
    const texts: string[] = [];
    const cmds: SimCommand[] = [];
    for (const s of f.snapshots) {
      const r = core.tick({ now: s.t, telemetry: s });
      texts.push(
        ...r.outbound.filter((m) => m.scenarioId === 'dep_fire').map((m) => m.message.text),
      );
      cmds.push(...r.commands.filter((c) => c.command === 'smoke'));
    }
    return { texts, cmds };
  }

  it('at the gate: departures suspended, updates, resumed; smoke at the departure runway', () => {
    const { texts, cmds } = fly(30);
    expect(texts[0]).toMatch(
      new RegExp(String.raw`FIRE REPORTED\s+(NEAR|[NSEW]{1,2} SIDE OF) RWY ` + ofp.origin.planRwy),
    );
    expect(texts[0]).toContain('DEPARTURES SUSPENDED');
    expect(texts.at(-1)).toContain('DEPARTURES RESUMED');
    expect(cmds).toMatchObject([
      { action: 'start', airport: ofp.origin.icao, runway: ofp.origin.planRwy },
      { action: 'stop' },
    ]);
  });

  it('nothing after the takeoff roll', () => {
    const late: CompiledScenario = {
      ...dep,
      steps: dep.steps.map((x) =>
        x.kind === 'draw'
          ? {
              ...x,
              options: [
                {
                  weight: 1,
                  values: [
                    ['run.start_min', { k: 'lit' as const, v: 600 }],
                    ['run.hold_min', { k: 'lit' as const, v: 20 }],
                  ],
                },
              ],
            }
          : x,
      ),
    };
    const core = AcarsCore.create({ ofp, scenarios: [late], seed: 'dep' });
    core.startFlight();
    let sent = 0;
    for (const s of flight.snapshots) {
      const r = core.tick({ now: s.t, telemetry: s });
      sent += r.outbound.filter((m) => m.scenarioId === 'dep_fire').length;
      sent += r.commands.length;
    }
    expect(sent).toBe(0);
  });
});

describe('dep_fire by hand (2026-10-16)', () => {
  it('"run now" skips the random wait: smoke and the message at once', () => {
    const sc = loadScenarios([...read('irregular')]).find(
      (s) => s.id === 'dep_fire',
    ) as CompiledScenario;
    const f = generateSyntheticFlight({ ofp });
    const core = AcarsCore.create({ ofp, scenarios: [sc], seed: 'force' });
    core.startFlight();
    const [first, second] = f.snapshots;
    if (first === undefined || second === undefined) throw new Error('no snapshots');
    core.tick({ now: first.t, telemetry: first });
    const r = core.tick({ now: second.t, telemetry: second, force: ['dep_fire'] });
    expect(r.commands).toMatchObject([{ command: 'smoke', action: 'start' }]);
    const later = core.tick({ now: second.t + 5_000, telemetry: second });
    const sent = [...r.outbound, ...later.outbound].filter((m) => m.scenarioId === 'dep_fire');
    // Ahead of the queue, as an answer to the pilot.
    expect(sent[0]?.toPilot).toBe(true);
    const text = sent.map((m) => m.message.text).join(' ');
    expect(text).toContain('DEPARTURES SUSPENDED');
  });
});
