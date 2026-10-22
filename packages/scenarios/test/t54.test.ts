import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AcarsCore,
  type CompiledScenario,
  type FirArea,
  generateSyntheticFlight,
  type Ofp,
  type PilotMessage,
  parseSimbriefOfp,
  type RescueCommand,
  stageIndex,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../src/index.js';

/** T54: the emergency scenarios order rescue services at the landing airport (`rescue` step). */

const dir = (name: string) => join(import.meta.dirname, '..', name);
const read = (name: string) =>
  readdirSync(dir(name))
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(dir(name), file), 'utf8') }));
const everything = loadScenarios([...read('base'), ...read('irregular'), ...read('commands')]);
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
const cruise = stageIndex(flight, 'CRUISE', 600);

function rescues(say: ReadonlyMap<number, readonly PilotMessage[]>, ids: readonly string[]) {
  const core = AcarsCore.create({
    ofp,
    scenarios: only(...ids),
    seed: 't54',
    xatc: { enabled: true, randomDirects: false },
  });
  core.startFlight();
  const out: RescueCommand[] = [];
  flight.snapshots.forEach((s, i) => {
    const r = core.tick({
      now: s.t,
      telemetry: s,
      ...(say.has(i) ? { inbound: say.get(i) as PilotMessage[] } : {}),
      ...(i === 0 ? { data: { t: s.t, firs: [WORLD] } } : {}),
    });
    for (const c of r.commands) if (c.command === 'rescue') out.push(c);
  });
  return out;
}

const dest = ofp.destination.icao;
const planRwy = ofp.destination.planRwy;

describe('rescue services by scenario (T54)', () => {
  it('the OFP has a planned runway at the destination', () => {
    expect(planRwy).toMatch(/^\d{2}[LRC]?$/);
  });

  it('MAYDAY, CONTINUE: full at the destination and its planned runway', () => {
    const r = rescues(
      new Map([
        [cruise, [cpdlc('/data2/1//Y/MAYDAY MAYDAY MAYDAY')]],
        [cruise + 30, [telex('CONTINUE')]],
      ]),
      ['emergency_mayday'],
    );
    expect(r).toEqual([
      expect.objectContaining({
        scenarioId: 'emergency_mayday',
        action: 'start',
        level: 'full',
        airport: dest,
        runway: planRwy,
      }),
    ]);
  });

  it('MAYDAY, DIVERT: full at the diversion airport (the nearest), no planned runway there', () => {
    const r = rescues(
      new Map([
        [cruise, [cpdlc('/data2/1//Y/MAYDAY MAYDAY MAYDAY')]],
        [cruise + 30, [telex('DIVERT')]],
      ]),
      ['emergency_mayday'],
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ level: 'full', runway: null });
    expect(r[0]?.airport).toMatch(/^[A-Z]{4}$/);
    expect(r[0]?.airport).not.toBe(dest);
  });

  it('PAN: standby (the trucks wait and do not follow)', () => {
    const r = rescues(
      new Map([
        [cruise, [cpdlc('/data2/1//Y/PAN PAN PAN')]],
        [cruise + 30, [telex('CONTINUE')]],
      ]),
      ['emergency_pan'],
    );
    expect(r.map((c) => [c.level, c.airport])).toEqual([['standby', dest]]);
  });

  it('PAN, then MAYDAY: standby, then full; the app keeps the senior one', () => {
    const r = rescues(
      new Map([
        [cruise, [cpdlc('/data2/1//Y/PAN PAN PAN')]],
        [cruise + 30, [telex('CONTINUE')]],
        [cruise + 120, [cpdlc('/data2/2//Y/MAYDAY MAYDAY MAYDAY')]],
        [cruise + 150, [telex('CONTINUE')]],
      ]),
      ['emergency_pan', 'emergency_mayday'],
    );
    expect(r.map((c) => c.level)).toEqual(['standby', 'full']);
  });

  it('MEDICAL command: an ambulance after the answer', () => {
    const r = rescues(
      new Map([
        [cruise, [telex('MEDICAL PAX UNCONSCIOUS')]],
        [cruise + 30, [telex('CONTINUE')]],
      ]),
      ['cmd_medical'],
    );
    expect(r.map((c) => [c.level, c.airport, c.scenarioId])).toEqual([
      ['medical', dest, 'cmd_medical'],
    ]);
  });

  it('fire in the cabin and a medical case: full and medical, before on-block', () => {
    for (const [id, level] of [
      ['ped_fire_cabin', 'full'],
      ['medical_onboard', 'medical'],
    ] as const) {
      const sc = everything.find((s) => s.id === id) as CompiledScenario;
      const core = AcarsCore.create({ ofp, scenarios: [sc], seed: 't54' });
      core.startFlight();
      const got: RescueCommand[] = [];
      let asked = false;
      flight.snapshots.forEach((s, i) => {
        const r = core.tick({
          now: s.t,
          telemetry: s,
          ...(i === cruise ? { force: [id] } : {}),
          ...(asked && i % 60 === 0 ? { inbound: [telex('CONTINUE')] } : {}),
        });
        if (r.outbound.some((m) => m.scenarioId === id)) asked = true;
        for (const c of r.commands) if (c.command === 'rescue') got.push(c);
      });
      expect(got.map((c) => [c.level, c.airport])).toEqual([[level, dest]]);
    }
  });

  it('a step `rescue: stop` stops; a bad level does not load', () => {
    const yaml = (step: string) => ({
      file: 't.yaml',
      source: [
        'id: t',
        'version: 1',
        'category: irregular',
        'title: T',
        'enabled_by_default: true',
        'trigger: { on: phase, phase: CRUISE }',
        'probability: 1',
        'steps:',
        `  - ${step}`,
      ].join('\n'),
    });
    const [sc] = loadScenarios([yaml('rescue: stop')]);
    const core = AcarsCore.create({ ofp, scenarios: [sc as CompiledScenario], seed: 1 });
    core.startFlight();
    const got: RescueCommand[] = [];
    for (const s of flight.snapshots.slice(0, cruise + 5)) {
      for (const c of core.tick({ now: s.t, telemetry: s }).commands) {
        if (c.command === 'rescue') got.push(c);
      }
    }
    expect(got).toEqual([expect.objectContaining({ action: 'stop', level: null, airport: dest })]);
    expect(() => loadScenarios([yaml('rescue: { level: huge }')])).toThrow();
    expect(() => loadScenarios([yaml('rescue: start')])).toThrow();
  });
});
