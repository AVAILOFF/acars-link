// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AcarsCore } from '../src/core.js';
import { ACDM_AIRPORTS, isAcdmAirport } from '../src/ext/acdm-airports.js';
import { parseSimbriefOfp } from '../src/ofp/index.js';
import { type CompiledScenario, compileScenario, ScenarioError } from '../src/scenario/compile.js';
import type { ScenarioDef, Step } from '../src/scenario/types.js';
import type { SimCommand, VdgsCommand } from '../src/sim/commands.js';
import { buildVdgsMessage, checkVdgsLines, VDGS_DISPLAYS, VdgsError } from '../src/sim/vdgs.js';
import { generateSyntheticFlight } from '../src/synthetic/flight.js';

const ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures/ofp/rctp-rjbb-a35k-kgs.json'), 'utf8'),
  ),
);
const L = (...texts: string[]) => texts.map((text) => ({ text, red: false }));

describe('VDGS limits (FSDreamTeam VGDS manual 2025-07-29)', () => {
  it('display table', () => {
    expect(VDGS_DISPLAYS).toEqual({
      small: { chars: 4, lines: 2 },
      narrow: { chars: 6, lines: 5 },
      wide: { chars: 9, lines: 6 },
      x: { chars: 10, lines: 6 },
      flex: { chars: 10, lines: 5 },
    });
  });

  it('the last display line is left to GSX (VGDS Editor manual, "Reserved Lines")', () => {
    expect(checkVdgsLines('narrow', L('A', 'B', 'C', 'D', 'E'))).toBeNull();
    expect(checkVdgsLines('narrow', L('A', 'B', 'C', 'D', 'E', 'F'))).toMatch(/6 lines, max 5/);
    expect(checkVdgsLines('wide', L('A', 'B', 'C', 'D', 'E', 'F', 'G'))).toMatch(/max 6/);
    expect(checkVdgsLines('x', L('A', 'B', 'C', 'D', 'E', 'F', 'G'))).toMatch(/max 6/);
    expect(() => scenario([{ vdgs: { narrow: ['A', 'B', 'C', 'D', 'E', 'F'] } }])).toThrow(
      /1\.\.5 lines/,
    );
  });

  it('checks width, line count and characters', () => {
    expect(checkVdgsLines('narrow', L('SJX822', 'GATE', 'B12'))).toBeNull();
    expect(checkVdgsLines('narrow', L('SJX8221'))).toMatch(/7 characters, max 6/);
    expect(checkVdgsLines('small', L('GATE', 'B12', 'X'))).toMatch(/3 lines, max 2/);
    expect(checkVdgsLines('x', L('GATE B12 OK'))).toMatch(/max 10/);
    expect(checkVdgsLines('wide', L('ETA 12:30', 'RJBB/KIX', 'A-1 .'))).toBeNull();
    for (const bad of ['GATE#1', 'ÄÖ', 'A,B', 'hi']) {
      expect(checkVdgsLines('wide', L(bad)), bad).toMatch(/characters other than/);
    }
    expect(checkVdgsLines('narrow', [])).toMatch(/no lines/);
  });

  it('builds a message: uppercase, wide and x from narrow, small only when given', () => {
    const m = buildVdgsMessage('RJBB', 6, { narrow: [{ text: ' gate ', red: true }] });
    expect(m).toEqual({
      airport: 'RJBB',
      durationMs: 6000,
      displays: {
        narrow: [{ text: 'GATE', red: true }],
        wide: [{ text: 'GATE', red: true }],
        x: [{ text: 'GATE', red: true }],
        flex: [{ text: 'GATE', red: true }],
      },
    });
    const withSmall = buildVdgsMessage('RJBB', 2.5, {
      narrow: L('GATE'),
      small: L('B12'),
      wide: L('GATE B12'),
    });
    expect(withSmall.durationMs).toBe(2500);
    expect(withSmall.displays.small).toEqual(L('B12'));
    expect(withSmall.displays.x).toEqual(L('GATE')); // x falls back to narrow, not wide
    expect(withSmall.displays.flex).toEqual(L('GATE'));
  });

  it('refuses instead of shortening', () => {
    expect(() => buildVdgsMessage('RJBB', 6, { narrow: L('WELCOME') })).toThrow(VdgsError);
    expect(() => buildVdgsMessage('RJBB', 6, { wide: L('GATE') })).toThrow(/narrow/);
  });
});

function scenario(steps: readonly Step[], extra: Partial<ScenarioDef> = {}): CompiledScenario {
  return compileScenario({
    id: 'vdgs_test',
    version: 1,
    category: 'ops',
    title: 'VDGS test',
    enabled_by_default: true,
    trigger: { on: 'phase_enter', phase: 'LANDED' },
    steps,
    ...extra,
  });
}

describe('vdgs step', () => {
  it('compile: literal lines are checked at once, templates when rendered', () => {
    expect(() => scenario([{ vdgs: { narrow: ['WELCOME'] } }])).toThrow(ScenarioError);
    expect(() => scenario([{ vdgs: { narrow: ['OK'], small: ['A', 'B', 'C'] } }])).toThrow(
      /1\.\.2 lines/,
    );
    expect(() => scenario([{ vdgs: { narrow: ['OK'], duration_sec: 0 } }])).toThrow(/1\.\.60/);
    expect(() => scenario([{ vdgs: { narrow: ['{nope.var}'] } }])).toThrow(/unknown variable/);
    expect(scenario([{ vdgs: { narrow: ['{ofp.flight}', { red: 'GATE' }] } }]).steps).toEqual([
      expect.objectContaining({ kind: 'vdgs', durationSec: 6 }),
    ]);
  });

  function fly(sc: CompiledScenario): { commands: SimCommand[]; errors: string[] } {
    const core = AcarsCore.create({ ofp, scenarios: [sc], seed: 'vdgs' });
    core.startFlight();
    const commands: SimCommand[] = [];
    const errors: string[] = [];
    for (const s of generateSyntheticFlight({ ofp }).snapshots) {
      const out = core.tick({ now: s.t, telemetry: s });
      commands.push(...out.commands);
      for (const e of out.events) if (e.type === 'SCENARIO_ERROR') errors.push(e.error);
    }
    return { commands, errors };
  }

  it('runs once after landing with the destination airport and rendered lines', () => {
    const r = fly(
      scenario([
        { vdgs: { narrow: ['{ofp.airline}', '{ofp.flight}', { red: 'GATE' }], duration_sec: 8 } },
      ]),
    );
    expect(r.errors).toEqual([]);
    expect(r.commands).toHaveLength(1);
    const c = r.commands[0] as VdgsCommand;
    expect(c).toMatchObject({ command: 'vdgs', scenarioId: 'vdgs_test' });
    expect(c.vdgs).toEqual({
      airport: 'RJBB',
      durationMs: 8000,
      displays: {
        narrow: [...L('SJX', '822'), { text: 'GATE', red: true }],
        wide: [...L('SJX', '822'), { text: 'GATE', red: true }],
        x: [...L('SJX', '822'), { text: 'GATE', red: true }],
        flex: [...L('SJX', '822'), { text: 'GATE', red: true }],
      },
    });
  });

  it('a rendered line that does not fit fails the scenario, nothing is sent', () => {
    const r = fly(scenario([{ vdgs: { narrow: ['{ofp.dest_name}'] } }]));
    expect(r.commands).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/narrow: /);
  });
});

describe('departure board (T102)', () => {
  const MIN = 60_000;
  const sched = ofp.times.schedOutMs;
  const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16).replace(':', '');

  it('A-CDM table: 35 EUROCONTROL airports, each with its source and the date checked', () => {
    expect(ACDM_AIRPORTS).toHaveLength(35);
    expect(new Set(ACDM_AIRPORTS.map((a) => a.icao)).size).toBe(35);
    for (const a of ACDM_AIRPORTS) {
      expect(a.icao).toMatch(/^[A-Z]{4}$/);
      expect(a.url).toMatch(/^https:\/\/www\.eurocontrol\.int\//);
      expect(a.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(isAcdmAirport('EDDL')).toBe(true);
    expect(isAcdmAirport('eham')).toBe(true);
    expect(isAcdmAirport('RCTP')).toBe(false);
  });

  it('compile: `vdgs: stop`, `at`, `replaces`', () => {
    expect(scenario([{ vdgs: 'stop' }]).steps).toEqual([{ kind: 'vdgs_stop' }]);
    expect(
      scenario([{ vdgs: { at: 'orig', replaces: 'flight_information', narrow: ['A', ''] } }]).steps,
    ).toEqual([
      expect.objectContaining({ kind: 'vdgs', at: 'orig', replaces: 'flight_information' }),
    ]);
    expect(scenario([{ vdgs: { narrow: ['A'] } }]).steps).toEqual([
      expect.objectContaining({ kind: 'vdgs', at: 'dest', replaces: null }),
    ]);
    expect(() => scenario([{ vdgs: 'go' as 'stop' }])).toThrow(/stop/);
    expect(() =>
      scenario([{ vdgs: { replaces: 'chock' as 'flight_information', narrow: ['A'] } }]),
    ).toThrow(/flight_information/);
  });

  function run(scs: readonly CompiledScenario[], until: (t: number) => boolean) {
    const core = AcarsCore.create({ ofp, scenarios: scs, seed: 'vdgs' });
    core.startFlight();
    const commands: VdgsCommand[] = [];
    const errors: string[] = [];
    for (const s of generateSyntheticFlight({ ofp, startMs: sched - 35 * MIN }).snapshots) {
      if (until(s.t)) break;
      const out = core.tick({ now: s.t, telemetry: s });
      for (const c of out.commands) if (c.command === 'vdgs') commands.push(c);
      for (const e of out.events) if (e.type === 'SCENARIO_ERROR') errors.push(e.error);
    }
    return { commands, errors };
  }

  it('at the origin, replacing flight_information; `stop` takes it down (null)', () => {
    const r = run(
      [
        scenario(
          [
            { vdgs: { at: 'orig', replaces: 'flight_information', narrow: ['{ofp.flight}', ''] } },
            { wait: { minutes: 1 } },
            { vdgs: 'stop' },
          ],
          { trigger: { on: 'time', at: { rel: 'sched_out', offset_min: -34 } } },
        ),
      ],
      (t) => t > sched - 30 * MIN,
    );
    expect(r.errors).toEqual([]);
    expect(r.commands.map((c) => c.vdgs)).toEqual([
      {
        airport: 'RCTP',
        replaces: 'flight_information',
        durationMs: 6000,
        displays: {
          narrow: L('822', ''),
          wide: L('822', ''),
          x: L('822', ''),
          flex: L('822', ''),
        },
      },
      null,
    ]);
  });

  /** A scenario showing `{flight.tobt|hhmm}` 5 min after it starts, after `steps`. */
  const board = (id: string, steps: readonly Step[]) =>
    compileScenario({
      id,
      version: 1,
      category: 'ops',
      title: id,
      enabled_by_default: true,
      trigger: { on: 'time', at: { rel: 'sched_out', offset_min: -34 } },
      steps: [
        ...steps,
        { wait: { minutes: 5 } },
        { vdgs: { at: 'orig', narrow: ['{flight.tobt|hhmm}', '{flight.minutes_to_tobt}'] } },
      ],
    });
  const tobtOf = (scs: readonly CompiledScenario[]) =>
    run(scs, (t) => t > sched - 25 * MIN).commands.map((c) =>
      c.vdgs?.displays.narrow?.map((l) => l.text),
    );

  it('TOBT = STD + the airline delay; the ATFM slot (slot_ctot) moves the CTOT, not the TOBT', () => {
    const slot = board('slot_ctot', [{ set: { 'flight.delay_min': 20 } }]);
    const late = board('cargo_late_truck', [{ set: { 'flight.delay_min': 15 } }]);
    expect(tobtOf([board('vdgs_test', [])])).toEqual([[hhmm(sched), '29']]);
    expect(tobtOf([slot])).toEqual([[hhmm(sched), '29']]);
    expect(tobtOf([late])).toEqual([[hhmm(sched + 15 * MIN), '44']]);
    // The airline's 15 min under a 20 min slot still count: TOBT moves by 15, not 0 or 20.
    expect(tobtOf([slot, late]).at(-1)).toEqual([hhmm(sched + 15 * MIN), '44']);
  });
});
