// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

// `pnpm release <X.Y.Z>` (T77, docs/07): a release on `master`.
//   1. master, a clean working copy, no tag vX.Y.Z yet, a version after the current one;
//   2. the version into apps/desktop/package.json and the bridge .csproj, a CHANGELOG.md section
//      from the `Merge task/…` commits since the previous tag;
//   3. pnpm check and pnpm bridge:test (any failure: the three files back as they were, nothing
//      else touched);
//   4. commit "Release vX.Y.Z" and the annotated tag vX.Y.Z;
//   5. pnpm desktop:dist (the public installer).
// Nothing is pushed: push the commit and the tag by hand when the user asks (CLAUDE.md).
// --any-branch: run on another branch (to try the script on a copy); --no-dist: skip step 5.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  changelogSection,
  isNewer,
  parseMerges,
  parseVersion,
  readVersions,
  setVersions,
  withSection,
} from './version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGE = 'apps/desktop/package.json';
const CSPROJ = 'bridge/msfs/src/AcarsBridge/AcarsBridge.csproj';
const CHANGELOG = 'CHANGELOG.md';
const CHANGELOG_HEAD =
  '# Changelog\n\nACARS Link releases: SemVer, an annotated tag `vX.Y.Z` on `master` for each.\n';

const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith('--'));
const anyBranch = args.includes('--any-branch');
const dist = !args.includes('--no-dist');

function fail(text) {
  console.error(`release: ${text}`);
  process.exit(1);
}

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
const read = (f) => readFileSync(join(root, f), 'utf8');

/** A pnpm script; false when it failed. One command string: pnpm is a .cmd on Windows. */
function pnpm(...a) {
  console.log(`\n> pnpm ${a.join(' ')}`);
  return (
    spawnSync(['pnpm', ...a].join(' '), { cwd: root, stdio: 'inherit', shell: true }).status === 0
  );
}

if (version === undefined || parseVersion(version) === null) {
  fail('usage: pnpm release <X.Y.Z> [--no-dist] [--any-branch]');
}
const tag = `v${version}`;

// 1. Where and what.
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'master' && !anyBranch) fail(`on ${branch}, not master`);
if (git('status', '--porcelain') !== '') fail('the working copy has changes; commit or stash them');
if (git('tag', '--list', tag) !== '') fail(`tag ${tag} exists`);
const current = readVersions({ packageJson: read(PACKAGE), csproj: read(CSPROJ) });
if (current.app !== current.bridge) {
  fail(`the versions differ: ${PACKAGE} ${current.app}, ${CSPROJ} ${current.bridge}`);
}
if (!isNewer(version, current.app)) fail(`${version} does not come after ${current.app}`);
let previous;
try {
  previous = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*');
} catch {
  fail('no earlier tag vX.Y.Z: tag the starting point first (git tag -a v0.1.0)');
}
const merges = parseMerges(git('log', '--reverse', '--merges', '--format=%s', `${previous}..HEAD`));
if (merges.length === 0) fail(`no merged task since ${previous}`);

// 2. The files. From here on a failure puts them back.
const hadChangelog = existsSync(join(root, CHANGELOG));
const files = [PACKAGE, CSPROJ, CHANGELOG];
function restore() {
  git('checkout', '--', PACKAGE, CSPROJ);
  if (hadChangelog) git('checkout', '--', CHANGELOG);
  else rmSync(join(root, CHANGELOG), { force: true });
}
function abort(text) {
  restore();
  fail(`${text}; the files are back as they were, nothing was committed`);
}
process.on('SIGINT', () => abort('interrupted'));

const next = setVersions({ packageJson: read(PACKAGE), csproj: read(CSPROJ) }, version);
writeFileSync(join(root, PACKAGE), next.packageJson);
writeFileSync(join(root, CSPROJ), next.csproj);
const date = new Date().toISOString().slice(0, 10);
const section = changelogSection(version, date, merges);
writeFileSync(
  join(root, CHANGELOG),
  withSection(hadChangelog ? read(CHANGELOG) : CHANGELOG_HEAD, section),
);
console.log(`\n${CHANGELOG}:\n\n${section}`);

// 3. The checks, on the new version.
if (!pnpm('check')) abort('pnpm check failed');
if (!pnpm('bridge:test')) abort('pnpm bridge:test failed');

// 4. Commit and tag.
try {
  git('add', '--', ...files);
  git('commit', '-m', `Release ${tag}`);
} catch (e) {
  git('reset', '--quiet', '--', ...files);
  abort(`commit failed (${e instanceof Error ? e.message : String(e)})`);
}
process.removeAllListeners('SIGINT');
git('tag', '-a', tag, '-m', `ACARS Link ${version}`);
console.log(`\nrelease: commit "Release ${tag}" and tag ${tag} on ${branch}`);

// 5. The installer.
if (dist && !pnpm('desktop:dist')) {
  fail(`${tag} is committed and tagged, the installer failed: fix it and run pnpm desktop:dist`);
}
if (dist) console.log(`release: apps/desktop/release/ACARS-Link-Setup-${version}.exe`);
console.log(`release: not pushed; when asked: git push origin ${branch} ${tag}`);
