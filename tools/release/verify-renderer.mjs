// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

// Built renderer check (T82): the Content-Security-Policy of out/renderer/index.html allows no
// WebSocket. `ws://localhost:*` is for the Vite dev server (HMR) only and is taken out at build
// time (electron.vite.config.ts); the renderer connects to nothing, the bridge talks to main.
//   node tools/release/verify-renderer.mjs <index.html> …
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** What is wrong with a built index.html (empty = fine). */
export function problems(file) {
  const html = readFileSync(file, 'utf8');
  const out = [];
  if (!html.includes('http-equiv="Content-Security-Policy"')) out.push(`${file}: no CSP`);
  for (const scheme of ['ws://', 'wss://']) {
    if (html.includes(scheme)) out.push(`${file}: ${scheme} in the built page`);
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: node tools/release/verify-renderer.mjs <index.html> …');
    process.exit(2);
  }
  const found = files.flatMap(problems);
  if (found.length > 0) {
    for (const line of found) console.error(line);
    process.exit(1);
  }
  console.log(`renderer check: ${files.join(', ')} ok`);
}
