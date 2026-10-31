// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

// Build variant (T72): `ACARS_BUILD=public` leaves out data that is not licensed for
// redistribution — the EUROCONTROL CAL and ICAO APAC squawk tables and the natTrak adapter:
// their modules are replaced by empty stand-ins from variants/public. Default (and
// `personal`) is the full build. `__ACARS_PUBLIC__` tells the main process which one it is.
const variantName = process.env['ACARS_BUILD'] ?? 'personal';
if (variantName !== 'public' && variantName !== 'personal') {
  throw new Error(`ACARS_BUILD must be "public" or "personal", got "${variantName}"`);
}
const isPublic = variantName === 'public';
const PUBLIC_STAND_INS: readonly (readonly [RegExp, RegExp, string])[] = [
  [/(^|\/)eur-cal\.js$/, /packages[/]core[/]src[/]atc[/]squawk[/]/, 'eur-cal.ts'],
  [/(^|\/)icao-apac\.js$/, /packages[/]core[/]src[/]atc[/]squawk[/]/, 'icao-apac.ts'],
  [/(^|\/)nattrak\.js$/, /packages[/]data-sources[/]src[/]/, 'nattrak.ts'],
];
const publicVariant = (): Plugin => ({
  name: 'acars-public-variant',
  enforce: 'pre',
  resolveId(source, importer) {
    if (!isPublic || importer === undefined) return null;
    for (const [name, from, stand] of PUBLIC_STAND_INS) {
      if (name.test(source) && from.test(importer)) {
        return fileURLToPath(new URL(`./variants/public/${stand}`, import.meta.url));
      }
    }
    return null;
  },
});

// CSP of the built renderer (T82): `ws://localhost:*` in index.html is for the Vite dev server
// (HMR) only; the renderer itself connects to nothing (the bridge talks to the main process).
// Missing text is an error, so a changed index.html cannot leave the rule in silently;
// tools/release/verify-renderer.mjs checks the result.
export const DEV_CONNECT_SRC = ' ws://localhost:*';
export const productionCsp = (): Plugin => ({
  name: 'acars-production-csp',
  apply: 'build',
  transformIndexHtml(html) {
    if (!html.includes(DEV_CONNECT_SRC)) {
      throw new Error(`index.html: "connect-src 'self'${DEV_CONNECT_SRC}" not found`);
    }
    return html.replace(DEV_CONNECT_SRC, '');
  },
});

export default defineConfig({
  main: {
    resolve: { conditions },
    ssr: { resolve: { conditions, externalConditions: ['source'] } },
    define: { __ACARS_PUBLIC__: JSON.stringify(isPublic) },
    plugins: [publicVariant(), copyrightBanner()],
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
    plugins: [react(), productionCsp(), copyrightBanner()],
  },
});
