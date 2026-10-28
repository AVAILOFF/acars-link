// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

// Workspace packages resolve to their TypeScript sources (`source` export condition, as in
// tsconfig.base.json and vitest.config.ts) and are bundled into the main process.
const conditions = ['source', 'module', 'node', 'development|production'];

// Copyright line at the top of every built JS file (T62). Added to the finished chunks:
// Rollup's `output.banner` does not reach the files Vite writes here.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const banner = `/*! ACARS Link ${version} | Copyright (c) 2026 AVAILOFF | All rights reserved, see LICENSE.txt */`;
const copyrightBanner = (): Plugin => ({
  name: 'acars-copyright-banner',
  apply: 'build',
  enforce: 'post',
  generateBundle(_options, bundle) {
    for (const file of Object.values(bundle)) {
      if (file.type === 'chunk') file.code = `${banner}\n${file.code}`;
    }
  },
});

export default defineConfig({
  main: {
    resolve: { conditions },
    ssr: { resolve: { conditions, externalConditions: ['source'] } },
    plugins: [copyrightBanner()],
    build: { externalizeDeps: false },
  },
  preload: {
    plugins: [copyrightBanner()],
    // A sandboxed preload must be one CommonJS file that only requires `electron`.
    build: {
      externalizeDeps: false,
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    resolve: { conditions: ['source', 'module', 'browser', 'development|production'] },
    plugins: [react(), copyrightBanner()],
  },
});
