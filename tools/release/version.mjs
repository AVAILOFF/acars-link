// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

// Versions, the changelog and the installer checksum of a release (T77, T84). Pure functions; the
// CLI is release.mjs.

/** Release version: SemVer `X.Y.Z`, no pre-release or build part (1.0.0 — the public release, T84). */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** `[major, minor, patch]`, or null when `v` is not `X.Y.Z`. */
export function parseVersion(v) {
  const m = SEMVER.exec(v);
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** `a` comes after `b` (both `X.Y.Z`). */
export function isNewer(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (x === null || y === null) throw new Error(`not X.Y.Z: ${x === null ? a : b}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

const PACKAGE_VERSION = /("version"\s*:\s*")([^"]*)(")/;
const CSPROJ_VERSION = /(<Version>)([^<]*)(<\/Version>)/;

/** The two places of the version: `apps/desktop/package.json` and the bridge `.csproj`. */
export function readVersions({ packageJson, csproj }) {
  return {
    app: JSON.parse(packageJson).version ?? null,
    bridge: CSPROJ_VERSION.exec(csproj)?.[2] ?? null,
  };
}

/** The texts with `version` in place of the old one; the rest of each file is left as it is. */
export function setVersions({ packageJson, csproj }, version) {
  if (!PACKAGE_VERSION.test(packageJson)) throw new Error('package.json has no "version"');
  if (!CSPROJ_VERSION.test(csproj)) throw new Error('the .csproj has no <Version>');
  return {
    packageJson: packageJson.replace(PACKAGE_VERSION, `$1${version}$3`),
    csproj: csproj.replace(CSPROJ_VERSION, `$1${version}$3`),
  };
}

const MERGE = /^Merge (task\/\S+) into \S+: (.+)$/;

/**
 * The merged tasks in `git log --format=%s` output: `Merge task/<name> into <branch>: <title>`
 * (CLAUDE.md, "Как работать"); other lines are not tasks. A branch merged twice counts once.
 */
export function parseMerges(log) {
  const seen = new Set();
  const out = [];
  for (const line of log.split('\n')) {
    const m = MERGE.exec(line.trim());
    if (m === null || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ branch: m[1], title: m[2] });
  }
  return out;
}

/** A `CHANGELOG.md` section: the version, the date (UTC `YYYY-MM-DD`) and one line per task. */
export function changelogSection(version, date, merges) {
  const lines = merges.map((m) => `- ${m.title} (\`${m.branch}\`)`);
  return `## ${version} — ${date}\n\n${lines.join('\n')}\n`;
}

/** `changelog` with `section` above the newest version (after the title and the introduction). */
export function withSection(changelog, section) {
  const at = changelog.search(/^## /m);
  if (at < 0) return `${changelog.trimEnd()}\n\n${section}`;
  return `${changelog.slice(0, at)}${section}\n${changelog.slice(at)}`;
}

/**
 * The `<file>.sha256` text next to the installer (T84): one line in `sha256sum` format — the hash
 * in lower-case hex, two spaces, the file name — so `sha256sum -c` and a look at `Get-FileHash`
 * both work.
 */
export function sha256Line(hex, fileName) {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`not a SHA-256: ${hex}`);
  if (fileName === '' || /[\\/\n]/.test(fileName)) throw new Error(`not a file name: ${fileName}`);
  return `${hex.toLowerCase()}  ${fileName}\n`;
}
