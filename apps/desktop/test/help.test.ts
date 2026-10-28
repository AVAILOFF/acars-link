// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { describe, expect, it } from 'vitest';
import { HELP, searchHelp } from '../src/renderer/src/help.js';

describe('Help tab', () => {
  it('has the same sections and questions in both languages', () => {
    const shape = (lang: 'en' | 'ru') =>
      HELP[lang].map((s) => [s.id, s.items.map((i) => [i.id, i.a.length])]);
    expect(shape('ru')).toEqual(shape('en'));
  });

  it('links only to https', () => {
    for (const s of [...HELP.en, ...HELP.ru]) {
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
    expect(searchHelp(HELP.ru, 'zzzz')).toEqual([]);
    expect(searchHelp(HELP.ru, '  ')).toHaveLength(HELP.ru.length);
  });
});
