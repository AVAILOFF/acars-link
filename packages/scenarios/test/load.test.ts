// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AcarsCore,
  checkText,
  DEFAULT_PROFILE,
  generateSyntheticFlight,
  parseSimbriefOfp,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { loadScenario, loadScenarios, parseScenario, ScenarioLoadError } from '../src/index.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const REFERENCE = join(import.meta.dirname, '../../../reference/scenarios');
const read = (dir: string, f: string) => ({ file: f, source: readFileSync(join(dir, f), 'utf8') });
const fixtures = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.yaml'))
  .sort()
  .map((f) => read(FIXTURES, f));

const ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../core/test/fixtures/ofp/rctp-rjbb-a35k-kgs.json'),
      'utf8',
    ),
  ),
);

const minimal = `
id: hello
version: 1
category: fun
title: Hello
enabled_by_default: true
trigger: { on: phase_enter, phase: CRUISE }
steps:
  - send: { body: HELLO }
`;

describe('parseScenario / loadScenario', () => {
  it('loads a minimal scenario; `on:` stays a string (YAML 1.2)', () => {
    const s = loadScenario(minimal);
    expect(s.id).toBe('hello');
    expect(s.def.trigger).toEqual({ on: 'phase_enter', phase: 'CRUISE' });
  });

  it.each<[string, string, RegExp]>([
    ['unknown property', `${minimal}\nfoo: 1\n`, /unknown property "foo"/],
    ['bad category', minimal.replace('fun', 'funny'), /category: must be one of docs/],
    ['bad phase', minimal.replace('CRUISE', 'CRUISING'), /trigger/],
    ['missing steps', minimal.replace(/steps:[\s\S]*/, ''), /must have required property 'steps'/],
    ['set target', minimal.replace('- send: { body: HELLO }', '- set: { x: 1 }'), /steps\/0/],
    ['unknown step', minimal.replace('- send: { body: HELLO }', '- jump: 1'), /steps\/0/],
    ['probability', `${minimal}probability: 2\n`, /probability: must be <= 1/],
    ['duplicate key', `${minimal}title: Again\n`, /unique|duplicate/i],
    ['YAML syntax', 'id: [unclosed', /flow|end|missing/i],
    ['not an object', '- a\n- b\n', /must be object/],
    // T89: kinds of flight.
    ['unknown kind of flight', `${minimal}operations: [cargo, tanker]\n`, /operations\/1/],
    ['empty operations', `${minimal}operations: []\n`, /operations/],
  ])('schema/YAML error: %s', (_, src, re) => {
    expect(() => parseScenario(src, 'x.yaml')).toThrow(ScenarioLoadError);
    expect(() => parseScenario(src, 'x.yaml')).toThrow(re);
  });

  it('operations (T89): the kinds of flight a scenario is for', () => {
    expect(loadScenario(`${minimal}operations: [sched_pax, cargo]\n`).def.operations).toEqual([
      'sched_pax',
      'cargo',
    ]);
    expect(loadScenario(minimal).def.operations).toBeUndefined();
  });

  it('semantic errors come from compileScenario, with file and path', () => {
    const src = minimal.replace('HELLO', '"ZFW {ofp.zfw}"');
    expect(() => loadScenario(src, 'hello.yaml')).toThrow(
      /^hello\.yaml: steps\[0\]\.send\.body: .*unknown variable ofp\.zfw/,
    );
  });

  it('loadScenarios: unique ids, known excludes, all problems at once', () => {
    const dup = { file: 'b.yaml', source: minimal };
    const ex = {
      file: 'c.yaml',
      source: `${minimal.replace('hello', 'other')}excludes: [ghost]\n`,
    };
    const bad = { file: 'd.yaml', source: 'id: 1' };
    try {
      loadScenarios([{ file: 'a.yaml', source: minimal }, dup, ex, bad]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ScenarioLoadError);
      const p = (e as ScenarioLoadError).problems;
      expect(p).toHaveLength(3);
      expect(p[0]).toMatch(/b\.yaml: id "hello" already used by a\.yaml/);
      expect(p[1]).toMatch(/^d\.yaml/);
      expect(p[2]).toMatch(/c\.yaml: excludes unknown scenario "ghost"/);
    }
  });
});

describe('reference/scenarios (docs/05 drafts) are rejected with a clear error', () => {
  // `set` exists since T14, but only for flags.*, flight.divert, ops.arr_gate; `calc.*` never
  // came (load.* / flight.nearest_altn instead). The shipped versions are in packages/scenarios.
  it.each([
    ['prelim_loadsheet.yaml', /steps\[0\]\.set\.flight\.pax_delta: can set flags/],
    [
      'medical_onboard.yaml',
      /steps\[2\]\.branch\.DIVERT\[0\]\.send\.body: .*unknown variable calc\./,
    ],
  ])('%s', (file, re) => {
    const { source } = read(REFERENCE, file);
    expect(() => loadScenario(source, file)).toThrow(re);
  });
});

describe('fixtures on a synthetic flight', () => {
  it('load, run end to end, every message fits the profile', () => {
    const scenarios = loadScenarios(fixtures);
    expect(scenarios.map((s) => s.id)).toEqual(['prelim_loadsheet', 'tod_wx_reminder']);
    const core = AcarsCore.create({ ofp, scenarios });
    core.startFlight();
    const texts: string[] = [];
    for (const s of generateSyntheticFlight({ ofp }).snapshots) {
      for (const m of core.tick({ now: s.t, telemetry: s }).outbound) {
        expect(checkText(m.message.text, DEFAULT_PROFILE)).toEqual([]);
        texts.push(`${new Date(m.t).toISOString()} ${m.scenarioId}\n${m.message.text}`);
      }
    }
    expect(texts).toHaveLength(3);
    expect(texts).toMatchSnapshot();
  });
});
