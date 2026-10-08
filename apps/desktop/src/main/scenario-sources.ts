import type { ScenarioSource } from './controller.js';

/**
 * The base scenario pack (`packages/scenarios/base/*.yaml`), embedded into the main bundle at
 * build time, so the app needs no path to the repository at run time.
 */
const files = import.meta.glob<string>('../../../../packages/scenarios/base/*.yaml', {
  query: '?raw',
  import: 'default',
  eager: true,
});

export const BASE_SCENARIOS: readonly ScenarioSource[] = Object.entries(files)
  .map(([path, source]) => ({ file: path.slice(path.lastIndexOf('/') + 1), source }))
  .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
