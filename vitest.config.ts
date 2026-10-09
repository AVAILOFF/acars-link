import { defineConfig } from 'vitest/config';

// Workspace packages resolve to their TypeScript sources via the `source` export
// condition (same as `customConditions` in tsconfig.base.json), no build needed.
const conditions = ['source', 'module', 'node', 'development|production'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ['source'] } },
  test: {
    // Synthetic 1 Hz flights through the core take seconds each; the default 5 s is too tight
    // when all projects run in parallel.
    testTimeout: 20_000,
    projects: [
      ...['core', 'data-sources', 'scenarios', 'transport'].map((name) => ({
        extends: true,
        test: { name: `@acars/${name}`, root: `packages/${name}` },
      })),
      { extends: true, test: { name: '@acars/desktop', root: 'apps/desktop' } },
      { extends: true, test: { name: '@acars/replay', root: 'tools/replay' } },
    ],
  },
});
