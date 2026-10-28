// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadScenarios, SCENARIOS_PACKAGE } from '../src/index.js';

describe('@acars/scenarios', () => {
  it('exports its package marker', () => {
    expect(SCENARIOS_PACKAGE).toBe('@acars/scenarios');
  });
});

/** UI texts of every shipped scenario, in both app languages (T45); the telexes stay English. */
describe('scenario UI texts', () => {
  const root = join(import.meta.dirname, '..');
  const dirs = ['base', 'commands', 'external', 'irregular', 'sim'];
  const files = dirs.flatMap((d) =>
    readdirSync(join(root, d))
      .filter((f) => f.endsWith('.yaml'))
      .sort()
      .map((file) => ({ file: `${d}/${file}`, source: readFileSync(join(root, d, file), 'utf8') })),
  );
  const all = loadScenarios(files);

  it('has title_ru, description and description_ru everywhere', () => {
    expect(all.length).toBe(files.length);
    for (const s of all) {
      expect(s.def.title_ru, `${s.id} title_ru`).toMatch(/[А-Яа-яЁё]/);
      expect(s.def.description, `${s.id} description`).toMatch(/^[ -~]+$/);
      expect(s.def.description_ru, `${s.id} description_ru`).toMatch(/[А-Яа-яЁё]/);
    }
  });

  // T57: hints in the app, English and Russian, for every scenario and every awaited answer.
  const en = /^[ -~]+$/;
  const ru = /[А-Яа-яЁё]/;

  it('has hint and hint_ru everywhere (T57)', () => {
    for (const s of all) {
      expect(s.def.hint, `${s.id} hint`).toMatch(en);
      expect(s.def.hint_ru, `${s.id} hint_ru`).toMatch(ru);
    }
  });

  it('every wait: reply has a hint for each option in both languages; step hints too (T57)', () => {
    let replies = 0;
    for (const s of all) {
      for (const step of s.steps) {
        if (step.kind === 'send' && step.hint !== null) {
          expect(step.hint.en, `${s.id} send hint`).toMatch(en);
          expect(step.hint.ru, `${s.id} send hint_ru`).toMatch(ru);
        }
        if (step.kind !== 'wait_reply') continue;
        replies++;
        expect(Object.keys(step.hints ?? {}), `${s.id} reply_hints`).toEqual(step.options);
        for (const o of step.options) {
          expect(step.hints?.[o]?.en, `${s.id} ${o}`).toMatch(en);
          expect(step.hints?.[o]?.ru, `${s.id} ${o} ru`).toMatch(ru);
        }
      }
    }
    // 20 scenarios ask, some of them twice (the question again in a holding loop).
    expect(replies).toBe(23);
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
