// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { describe, expect, it } from 'vitest';
import { HELP, type HelpSection, helpFor, searchHelp } from '../src/renderer/src/help.js';
import type { Language } from '../src/shared/api.js';

/** T85: every language that has a help file (`help-<lang>.ts`). */
const LANGS = Object.entries(HELP).flatMap(([lang, sections]) =>
  sections === undefined ? [] : [{ lang, sections }],
);

describe('Help tab', () => {
  it('has the same sections, questions and blocks in every language (T85)', () => {
    const shape = (sections: readonly HelpSection[]) =>
      sections.map((s) => [s.id, s.items.map((i) => [i.id, i.a.length])]);
    expect(LANGS.map((l) => l.lang)).toEqual(expect.arrayContaining(['en', 'ru']));
    for (const l of LANGS) expect(shape(l.sections), l.lang).toEqual(shape(HELP.en));
  });

  it('a language without a help file shows English (T85)', () => {
    expect(helpFor('ru')).toBe(HELP.ru);
    expect(helpFor('xx' as Language)).toBe(HELP.en);
  });

  it('links only to https', () => {
    for (const s of LANGS.flatMap((l) => l.sections)) {
      for (const i of s.items) {
        for (const b of i.a) {
          if (typeof b !== 'string' && 'link' in b) expect(b.href).toMatch(/^https:\/\//);
        }
      }
    }
  });

  it('search keeps matching questions and drops empty sections', () => {
    const found = searchHelp(HELP.en, 'f-pln request');
    expect(found.length).toBeGreaterThan(0);
    for (const s of found) expect(s.items.length).toBeGreaterThan(0);
    expect(found.flatMap((s) => s.items.map((i) => i.id))).toContain('inibuilds');
    expect(searchHelp(helpFor('ru'), 'zzzz')).toEqual([]);
    expect(searchHelp(helpFor('ru'), '  ')).toHaveLength(helpFor('ru').length);
  });
});
