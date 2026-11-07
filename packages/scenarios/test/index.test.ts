// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type LocaleSource,
  loadScenarios,
  missingTranslations,
  SCENARIOS_PACKAGE,
} from '../src/index.js';

describe('@acars/scenarios', () => {
  it('exports its package marker', () => {
    expect(SCENARIOS_PACKAGE).toBe('@acars/scenarios');
  });
});

const root = join(import.meta.dirname, '..');
/** Translation files of the UI texts (T85): `locales/<lang>.yaml`. */
export const LOCALES: readonly LocaleSource[] = readdirSync(join(root, 'locales'))
  .filter((f) => f.endsWith('.yaml'))
  .sort()
  .map((f) => ({
    lang: f.slice(0, -'.yaml'.length),
    file: `locales/${f}`,
    source: readFileSync(join(root, 'locales', f), 'utf8'),
  }));

/** UI texts of every shipped scenario, English and Russian (T45, T85); the telexes stay English. */
describe('scenario UI texts', () => {
  const dirs = [
    'base',
    'commands',
    'external',
    'irregular',
    'sim',
    'cargo',
    'charter',
    'ferry',
    'bizav',
  ];
  const files = dirs.flatMap((d) =>
    readdirSync(join(root, d))
      .filter((f) => f.endsWith('.yaml'))
      .sort()
      .map((file) => ({ file: `${d}/${file}`, source: readFileSync(join(root, d, file), 'utf8') })),
  );
  const all = loadScenarios(files, LOCALES);

  it('has a Russian title, a description and its Russian text everywhere', () => {
    expect(all.length).toBe(files.length);
    for (const s of all) {
      expect(s.texts.title['ru'], `${s.id} title ru`).toMatch(/[А-Яа-яЁё]/);
      expect(s.def.description, `${s.id} description`).toMatch(/^[ -~]+$/);
      expect(s.texts.description?.['ru'], `${s.id} description ru`).toMatch(/[А-Яа-яЁё]/);
    }
  });

  // T85: Russian is required for every scenario; other languages may lag behind (reported only).
  it('Russian is complete; the other languages report what is missing', () => {
    expect(missingTranslations(all, 'ru')).toEqual([]);
    for (const l of LOCALES.filter((x) => x.lang !== 'ru')) {
      const missing = missingTranslations(all, l.lang);
      console.info(`scenario texts ${l.lang}: ${missing.length} not translated`);
    }
  });

  // T57: hints in the app, English and Russian, for every scenario and every awaited answer.
  const en = /^[ -~]+$/;
  const ru = /[А-Яа-яЁё]/;

  it('has a hint in English and Russian everywhere (T57)', () => {
    for (const s of all) {
      expect(s.def.hint, `${s.id} hint`).toMatch(en);
      expect(s.texts.hint?.['ru'], `${s.id} hint ru`).toMatch(ru);
    }
  });

  it('every wait: reply has a hint for each option in both languages; step hints too (T57)', () => {
    let replies = 0;
    for (const s of all) {
      for (const step of s.steps) {
        if (step.kind === 'send' && step.hint !== null) {
          expect(step.hint.en, `${s.id} send hint`).toMatch(en);
          expect(step.hint['ru'], `${s.id} send hint ru`).toMatch(ru);
        }
        if (step.kind !== 'wait_reply') continue;
        replies++;
        expect(Object.keys(step.hints ?? {}), `${s.id} reply_hints`).toEqual(step.options);
        for (const o of step.options) {
          expect(step.hints?.[o]?.en, `${s.id} ${o}`).toMatch(en);
          expect(step.hints?.[o]?.['ru'], `${s.id} ${o} ru`).toMatch(ru);
        }
      }
    }
    // 23 scenarios ask, some of them twice (the question again in a holding loop); T90: cargo
    // NOTOC and special load; T91: ferry permit; T94: the FDM letter.
    expect(replies).toBe(27);
  });

  it('the commands of the request window say what they do in the first sentence (T57)', () => {
    for (const id of ['cmd_req_wx', 'cmd_req_atis', 'cmd_req_gate', 'cmd_req_loadsheet']) {
      const hint = all.find((s) => s.id === id)?.def.hint ?? '';
      const command = id.slice(4).replaceAll('_', ' ').toUpperCase();
      expect(hint.startsWith(command), id).toBe(true);
    }
    expect(all.find((s) => s.id === 'cmd_help')?.def.hint).toMatch(/^Free text .*HELP/);
  });
});
