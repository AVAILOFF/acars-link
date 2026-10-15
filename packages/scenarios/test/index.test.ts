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
});
