// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

// `pnpm spdx` — every tracked or new (not ignored) source file starts with its licence header
// (T62, tools/spdx/header.mjs). `pnpm spdx --write` adds missing headers; part of `pnpm check`.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedHeader, hasHeader, withHeader } from './header.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const write = process.argv.includes('--write');

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\n')
  .filter((p) => p !== '' && expectedHeader(p) !== null && existsSync(join(root, p)));

const missing = [];
for (const path of files) {
  const text = readFileSync(join(root, path), 'utf8');
  if (hasHeader(path, text)) continue;
  if (write) writeFileSync(join(root, path), withHeader(path, text));
  missing.push(path);
}

if (write) {
  console.log(`spdx: header added to ${missing.length} of ${files.length} files`);
} else if (missing.length > 0) {
  console.error(`spdx: no licence header in ${missing.length} files (pnpm spdx --write):`);
  for (const path of missing) console.error(`  ${path}`);
  process.exit(1);
} else {
  console.log(`spdx: ${files.length} files OK`);
}
