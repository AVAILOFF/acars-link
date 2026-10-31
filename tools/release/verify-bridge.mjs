// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

// Bridge folder check (T73): the installer must not carry Microsoft's SimConnect binaries (no
// written permission to redistribute them); the bridge brings its own client in
// acars_simconnect.dll, which has SimConnect linked in statically from the MSFS SDK.
//   node tools/release/verify-bridge.mjs <bridge folder> …
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FORBIDDEN = ['SimConnect.dll', 'Microsoft.FlightSimulator.SimConnect.dll'];
export const REQUIRED = ['acars-msfs-bridge.exe', 'acars_simconnect.dll'];

/** What is wrong with a bridge folder (empty = fine). */
export function problems(dir) {
  const out = [];
  for (const name of FORBIDDEN) {
    if (existsSync(join(dir, name))) out.push(`${dir}: ${name} must not be shipped`);
  }
  for (const name of REQUIRED) {
    if (!existsSync(join(dir, name))) out.push(`${dir}: ${name} is missing`);
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    console.error('usage: node tools/release/verify-bridge.mjs <bridge folder> …');
    process.exit(2);
  }
  const found = dirs.flatMap(problems);
  if (found.length > 0) {
    for (const line of found) console.error(line);
    process.exit(1);
  }
  console.log(`bridge check: ${dirs.join(', ')} ok`);
}
