// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { describe, expect, it } from 'vitest';
import {
  compileExpr,
  compileTemplate,
  createRng,
  ExprError,
  type Lookup,
  MISSING,
  TemplateError,
  type Value,
} from '../src/index.js';

const vars: Record<string, Value> = {
  phase: 'CRUISE',
  'flight.minutes_to_tod': 45,
  'ofp.block_time_min': 150,
  'ofp.altn': null,
  'aircraft.cat': 'H',
  'tm.on_ground': false,
  'ofp.zfw_kg': 180_234,
  'ofp.sched_out': Date.UTC(2026, 9, 8, 7, 5),
  'ofp.callsign': 'sjx822',
};
const look: Lookup = (p) => vars[p];
const test = (src: string) => compileExpr(src).test(look);

describe('compileExpr', () => {
  it.each([
    ['flight.minutes_to_tod >= 40', true],
    ['flight.minutes_to_tod > 45', false],
    ['flight.minutes_to_tod <= 45 and ofp.block_time_min < 200', true],
    ["phase in ['PREFLIGHT', 'BOARDING']", false],
    ['phase not in [\'PREFLIGHT\', "BOARDING"]', true],
    ["aircraft.cat in ['M','H']", true],
    ['ofp.altn == null', true],
    ['ofp.altn != null or tm.on_ground', false],
    ['not tm.on_ground', true],
    ['!(phase == "CRUISE") || flight.minutes_to_tod == 45', true],
    ['ofp.altn > 0', false], // ordering with null is false
    ['ofp.altn < 0', false],
    ["phase > 'A'", false], // ordering compares numbers only
    ['flight.minutes_to_tod > -5', true],
    ['nope.unknown == null', true],
    ['(ofp.block_time_min >= 120 and (phase == "CRUISE"))', true],
  ])('%s → %s', (src, expected) => {
    expect(test(src)).toBe(expected);
  });

  it('lists the variables it reads', () => {
    expect(compileExpr("phase in ['A'] and flight.minutes_to_tod > 1").vars).toEqual([
      'phase',
      'flight.minutes_to_tod',
    ]);
  });

  it.each([
    'phase ==',
    'phase = 1',
    "phase in ['A'",
    "'open",
    'a and or b',
    '1 2',
    'phase == $x',
    '',
  ])('rejects %j', (src) => {
    expect(() => compileExpr(src)).toThrow(ExprError);
  });
});

describe('compileTemplate', () => {
  const rng = () => createRng('tpl');
  const render = (src: string) => compileTemplate(src).render(look, rng());

  it('substitutes variables and applies formatters', () => {
    expect(render('ZFW {ofp.zfw_kg|kg1} {ofp.callsign|upper}')).toBe('ZFW 180.2 SJX822');
    expect(render('{ofp.sched_out|hhmm}Z {ofp.sched_out|ddmmm}')).toBe('0705Z 08OCT');
    expect(render('[{phase|pad:8}][{flight.minutes_to_tod|lpad:4}]')).toBe('[CRUISE  ][  45]');
    expect(render('{ofp.zfw_kg|kg1|lpad:6}')).toBe(' 180.2');
    expect(render('{ofp.block_time_min|int}')).toBe('150');
  });

  it('renders missing values as a placeholder, also through formatters', () => {
    expect(render('ALTN {ofp.altn} {ofp.altn|kg1}')).toBe(`ALTN ${MISSING} ${MISSING}`);
  });

  it('rand/pick/seat come from the seeded Rng: same seed, same text', () => {
    const src = '{rand:25-80} {rand:-5-5} {pick:[CHEST PAIN,FAINTED]} {seat}';
    const a = render(src);
    expect(render(src)).toBe(a);
    expect(a).toMatch(/^\d{2} -?\d (CHEST PAIN|FAINTED) \d{1,2}[A-HJK]$/);
    const values = new Set(
      Array.from({ length: 200 }, (_, i) =>
        Number(compileTemplate('{rand:-5-5}').render(look, createRng(i))),
      ),
    );
    expect(Math.min(...values)).toBe(-5);
    expect(Math.max(...values)).toBe(5);
  });

  it('lists variables, not generators', () => {
    expect(compileTemplate('{ofp.zfw_kg|kg1} {rand:1-2} {seat} {phase}').vars).toEqual([
      'ofp.zfw_kg',
      'phase',
    ]);
  });

  it.each([
    '{ofp.zfw_kg|nope}',
    '{ofp.zfw_kg|pad}',
    '{ofp.zfw_kg|pad:0}',
    '{ofp.zfw_kg|kg1:2}',
    '{rand:9-1}',
    '{pick:[A,,B]}',
    '{name:pilot}',
    '{Bad.Var}',
    'open {ofp.zfw_kg',
    'close }',
  ])('rejects %j at compile time', (src) => {
    expect(() => compileTemplate(src)).toThrow(TemplateError);
  });

  it('rejects unknown variables and non-numbers at render time', () => {
    expect(() => render('{ofp.nothing}')).toThrow(TemplateError);
    expect(() => render('{phase|kg1}')).toThrow(TemplateError);
  });
});
