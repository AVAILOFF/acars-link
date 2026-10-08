/**
 * @acars/replay — flight recordings (JSONL) and their replay through the core (T11,
 * docs/04 "Тестирование"). The CLI is `src/cli.ts` (`pnpm replay`).
 */
export const REPLAY_PACKAGE = '@acars/replay';

export * from './format.js';
export * from './report.js';
export * from './run.js';
export * from './synthetic.js';
