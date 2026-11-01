// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  changelogSection,
  isNewer,
  parseMerges,
  parseVersion,
  readVersions,
  setVersions,
  sha256Line,
  withSection,
} from '../version.mjs';

const root = resolve(import.meta.dirname, '../../..');
const files = () => ({
  packageJson: readFileSync(join(root, 'apps/desktop/package.json'), 'utf8'),
  csproj: readFileSync(join(root, 'bridge/msfs/src/AcarsBridge/AcarsBridge.csproj'), 'utf8'),
});

describe('one version (T77)', () => {
  it('the app and the bridge carry the same X.Y.Z', () => {
    const v = readVersions(files());
    expect(parseVersion(v.app ?? '')).not.toBeNull();
    expect(v.bridge).toBe(v.app);
  });

  it('a release changes the version in both files and nothing else', () => {
    const before = files();
    const after = setVersions(before, '9.8.7');
    expect(readVersions(after)).toEqual({ app: '9.8.7', bridge: '9.8.7' });
    const v = readVersions(before).app;
    expect(after.packageJson.replace('"version": "9.8.7"', `"version": "${v}"`)).toBe(
      before.packageJson,
    );
    expect(after.csproj.replace('<Version>9.8.7<', `<Version>${v}<`)).toBe(before.csproj);
  });

  it('a file without its version field is an error', () => {
    expect(() =>
      setVersions({ packageJson: '{}', csproj: '<Version>1</Version>' }, '1.0.0'),
    ).toThrow(/package.json/);
    expect(() => setVersions({ packageJson: '{"version": "1"}', csproj: '' }, '1.0.0')).toThrow(
      /csproj/,
    );
  });
});

describe('SemVer X.Y.Z', () => {
  it('only X.Y.Z without leading zeros', () => {
    expect(parseVersion('0.1.10')).toEqual([0, 1, 10]);
    for (const bad of ['0.1', '0.1.0-rc.1', 'v0.1.0', '01.0.0', '0.1.0+dev', ''])
      expect(parseVersion(bad), bad).toBeNull();
  });

  it('newer by number, not by text', () => {
    expect(isNewer('0.1.10', '0.1.9')).toBe(true);
    expect(isNewer('0.2.0', '0.1.10')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
    expect(isNewer('0.1.0', '0.1.1')).toBe(false);
  });
});

describe('CHANGELOG.md section', () => {
  const log = [
    'Merge task/T75-bridge-supervisor into task/T73-simconnect-static: bridge supervision',
    'Merge branch "master" of github.com:x/y',
    'Merge task/T76-test-timeouts into master: tests - CI timeout and shards',
    'Merge task/T75-bridge-supervisor into master: bridge supervision again',
  ].join('\n');

  it('the merged tasks in order, once each; other merges are not tasks', () => {
    expect(parseMerges(log)).toEqual([
      { branch: 'task/T75-bridge-supervisor', title: 'bridge supervision' },
      { branch: 'task/T76-test-timeouts', title: 'tests - CI timeout and shards' },
    ]);
    expect(parseMerges('')).toEqual([]);
  });

  it('the newest version first, under the introduction', () => {
    const section = changelogSection('0.1.1', '2026-11-02', parseMerges(log));
    expect(section).toBe(
      [
        '## 0.1.1 — 2026-11-02',
        '',
        '- bridge supervision (`task/T75-bridge-supervisor`)',
        '- tests - CI timeout and shards (`task/T76-test-timeouts`)',
        '',
      ].join('\n'),
    );
    const old = '# Changelog\n\nIntro.\n\n## 0.1.0 — 2026-10-31\n\n- Start.\n';
    expect(withSection(old, section)).toBe(
      `# Changelog\n\nIntro.\n\n${section}\n## 0.1.0 — 2026-10-31\n\n- Start.\n`,
    );
    expect(withSection('# Changelog\n', section)).toBe(`# Changelog\n\n${section}`);
  });

  it('the CHANGELOG.md of the repository starts with the title and has 0.1.0', () => {
    const text = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    expect(text.startsWith('# Changelog\n')).toBe(true);
    expect(text).toMatch(/^## 0\.1\.0 — \d{4}-\d{2}-\d{2}$/m);
  });
});

describe('installer checksum (T84)', () => {
  const hex = 'E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855';

  it('one sha256sum line: lower-case hash, two spaces, the file name', () => {
    expect(sha256Line(hex, 'ACARS-Link-Setup-1.0.0.exe')).toBe(
      `${hex.toLowerCase()}  ACARS-Link-Setup-1.0.0.exe\n`,
    );
  });

  it('not a SHA-256 or not a bare file name is an error', () => {
    expect(() => sha256Line(hex.slice(1), 'a.exe')).toThrow();
    expect(() => sha256Line(`${hex.slice(1)}G`, 'a.exe')).toThrow();
    expect(() => sha256Line(hex, '')).toThrow();
    expect(() => sha256Line(hex, 'release/a.exe')).toThrow();
    expect(() => sha256Line(hex, 'release\\a.exe')).toThrow();
  });
});
