// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

// Public build check (T72): fails when files under the given paths (a folder is walked, an
// app.asar is read as bytes — asar stores files uncompressed) contain data that is not licensed
// for redistribution: the EUROCONTROL CAL and ICAO APAC eANP squawk tables, the natTrak
// adapter. The strings are taken from the real modules; apps/desktop/test/variant.test.ts checks
// they are still there, so the list cannot rot.
//   node tools/release/verify-public.mjs <file-or-folder> …
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SENTINELS = [
  // [string in the data, the source file that has it]
  ['4.13 (2026-03-04)', 'packages/core/src/atc/squawk/eur-cal.ts'],
  ["'EUR-B'", 'packages/core/src/atc/squawk/eur-cal.ts'],
  ['APAC-II 24/04', 'packages/core/src/atc/squawk/icao-apac.ts'],
  ['TAIBEI', 'packages/core/src/atc/squawk/icao-apac.ts'],
  ['nattrak.vatsim.net', 'packages/data-sources/src/nattrak.ts'],
];

function* files(path) {
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path)) yield* files(join(path, name));
  } else {
    yield path;
  }
}

/** Every [file, sentinel] pair found under `paths`. */
export function scan(paths) {
  const found = [];
  for (const p of paths) {
    for (const file of files(p)) {
      const bytes = readFileSync(file);
      for (const [needle] of SENTINELS) {
        // The same text may sit in single or double quotes after bundling.
        const variants = needle.startsWith("'") ? [needle, needle.replaceAll("'", '"')] : [needle];
        if (variants.some((v) => bytes.includes(v))) found.push([file, needle]);
      }
    }
  }
  return found;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error('usage: node tools/release/verify-public.mjs <file-or-folder> …');
    process.exit(2);
  }
  const found = scan(paths);
  if (found.length > 0) {
    for (const [file, needle] of found)
      console.error(`not for the public build: ${file}: ${needle}`);
    process.exit(1);
  }
  console.log(`public build check: nothing found in ${paths.join(', ')}`);
}
