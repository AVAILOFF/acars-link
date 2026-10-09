import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AcarsCore } from '../src/core.js';
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
      narrow: { chars: 6, lines: 6 },
      wide: { chars: 9, lines: 7 },
      x: { chars: 10, lines: 7 },
    });
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
