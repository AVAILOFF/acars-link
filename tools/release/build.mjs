// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

// Windows installer in one of two variants (T72, docs/07):
//   public   — no EUROCONTROL CAL / ICAO APAC squawk tables, no natTrak; the one to give to
//              other people. Checked after the build: out/ and app.asar must not hold them.
//   personal — everything (private use); installer name gets `-personal`.
// `pnpm desktop:dist` = public, `pnpm desktop:dist:personal` = personal.
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const variant = process.argv[2];
if (variant !== 'public' && variant !== 'personal') {
  console.error('usage: node tools/release/build.mjs public|personal');
  process.exit(2);
}

function run(command, args, env = {}) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  // One command string: with shell: true (pnpm is a .cmd on Windows) Node deprecates a separate args array.
  const r = spawnSync([command, ...args].join(' '), {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) {
    console.error(`failed: ${command} ${args.join(' ')} (${r.status ?? r.signal})`);
    process.exit(r.status ?? 1);
  }
}

const env = { ACARS_BUILD: variant };
run('pnpm', ['bridge:publish']);
run('node', ['tools/release/verify-bridge.mjs', join('bridge', 'msfs', 'publish')]);
run('node', ['tools/release/verify-bridge.mjs', join('bridge', 'msfs', 'publish')]);
run('pnpm', ['run', 'licenses']);
run('pnpm', ['-F', '@acars/desktop', 'exec', 'electron-vite', 'build'], env);
if (variant === 'public') {
  run('node', ['tools/release/verify-public.mjs', join('apps', 'desktop', 'out')]);
}
const builder = ['-F', '@acars/desktop', 'exec', 'electron-builder', '--win'];
if (variant === 'personal') {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: ${version} is an electron-builder macro
  builder.push('-c.nsis.artifactName=ACARS-Link-Setup-personal-${version}.exe');
}
run('pnpm', builder, env);
run('node', [
  'tools/release/verify-bridge.mjs',
  join('apps', 'desktop', 'release', 'win-unpacked', 'resources', 'bridge'),
]);
run('node', [
  'tools/release/verify-bridge.mjs',
  join('apps', 'desktop', 'release', 'win-unpacked', 'resources', 'bridge'),
]);
if (variant === 'public') {
  run('node', [
    'tools/release/verify-public.mjs',
    join('apps', 'desktop', 'release', 'win-unpacked', 'resources', 'app.asar'),
  ]);
}
