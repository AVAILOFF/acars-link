import { defineConfig } from 'vitest/config';

// Workspace packages resolve to their TypeScript sources via the `source` export
// condition (same as `customConditions` in tsconfig.base.json), no build needed.
const conditions = ['source', 'module', 'node', 'development|production'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ['source'] } },
  test: {
    projects: [
      ...['core', 'scenarios', 'transport'].map((name) => ({
        extends: true,
        test: { name: `@acars/${name}`, root: `packages/${name}` },
      })),
      { extends: true, test: { name: '@acars/desktop', root: 'apps/desktop' } },
      { extends: true, test: { name: '@acars/replay', root: 'tools/replay' } },
    ],
  },
});
