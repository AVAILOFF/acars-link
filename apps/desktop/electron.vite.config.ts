import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

// Workspace packages resolve to their TypeScript sources (`source` export condition, as in
// tsconfig.base.json and vitest.config.ts) and are bundled into the main process.
const conditions = ['source', 'module', 'node', 'development|production'];

export default defineConfig({
  main: {
    resolve: { conditions },
    ssr: { resolve: { conditions, externalConditions: ['source'] } },
    build: { externalizeDeps: false },
  },
  preload: {
    // A sandboxed preload must be one CommonJS file that only requires `electron`.
    build: {
      externalizeDeps: false,
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    resolve: { conditions: ['source', 'module', 'browser', 'development|production'] },
    plugins: [react()],
  },
});
