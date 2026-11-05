// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  installedPackagesPath,
  newerVersion,
  SMOKE_PACKAGE,
  SmokePackage,
  userCfgFiles,
} from '../src/main/smoke-package.js';
import { tempDir } from './support.js';

const manifest = (version: string, title = 'ACARS Smoke') =>
  JSON.stringify({ title, package_version: version, content_type: 'MISC' });

/** A fake user profile: Steam MSFS 2024 with packages in `<root>/MSFS2024`, the bundle in `<root>/bundle`. */
async function setup(o: { store?: boolean; steam?: boolean; bundle?: string | null } = {}) {
  const root = await tempDir();
  const env = {
    localAppData: join(root, 'Local'),
    appData: join(root, 'Roaming'),
    bundleDir: o.bundle === null ? null : join(root, 'bundle'),
  };
  const [store, steam] = userCfgFiles(env);
  const pkgs = { store: join(root, 'StorePkgs'), steam: join(root, 'MSFS2024') };
  for (const [on, cfg, dir] of [
    [o.store ?? false, store, pkgs.store],
    [o.steam ?? true, steam, pkgs.steam],
  ] as const) {
    if (!on || cfg === undefined) continue;
    await mkdir(join(cfg.file, '..'), { recursive: true });
    await mkdir(dir, { recursive: true });
    await writeFile(cfg.file, `Version 1\nInstalledPackagesPath "${dir}"\nOther 1\n`);
  }
  if (o.bundle !== null) {
    await mkdir(join(root, 'bundle', 'SimObjects'), { recursive: true });
    await writeFile(join(root, 'bundle', 'manifest.json'), manifest(o.bundle ?? '1.0.0'));
    await writeFile(join(root, 'bundle', 'SimObjects', 'sim.cfg'), 'x');
  }
  return { root, env, pkgs, p: new SmokePackage(env) };
}

describe('smoke package in Community (T104)', () => {
  it('reads InstalledPackagesPath as the SDK sample does', () => {
    expect(installedPackagesPath('A 1\r\nInstalledPackagesPath "D:\\MSFS2024"\r\nB 2')).toBe(
      'D:\\MSFS2024',
    );
    expect(installedPackagesPath('InstalledPackagesPath ""')).toBeNull();
    expect(installedPackagesPath('nothing')).toBeNull();
  });

  it('UserCfg.opt of the Store and Steam versions (SDK sample paths)', () => {
    const files = userCfgFiles({ localAppData: 'L', appData: 'R' });
    expect(files.map((f) => f.install)).toEqual(['store', 'steam']);
    expect(files[0]?.file).toBe(
      join('L', 'Packages', 'Microsoft.Limitless_8wekyb3d8bbwe', 'LocalCache', 'UserCfg.opt'),
    );
    expect(files[1]?.file).toBe(join('R', 'Microsoft Flight Simulator 2024', 'UserCfg.opt'));
  });

  it('compares x.y.z versions', () => {
    expect(newerVersion('1.0.10', '1.0.9')).toBe(true);
    expect(newerVersion('1.0', '1.0.0')).toBe(false);
    expect(newerVersion('1.0.0', '1.0.1')).toBe(false);
    expect(newerVersion('x', '1.0.0')).toBe(false);
  });

  it('no MSFS 2024: no targets, install refuses', async () => {
    const { p } = await setup({ steam: false });
    expect(await p.view()).toEqual({ bundled: '1.0.0', targets: [] });
    await expect(p.install()).rejects.toThrow(/MSFS 2024 not found/);
  });

  it('a folder named in UserCfg.opt that does not exist is no target', async () => {
    const { env, p } = await setup({ steam: false });
    const steam = userCfgFiles(env)[1];
    if (steam === undefined) throw new Error('no steam');
    await mkdir(join(steam.file, '..'), { recursive: true });
    await writeFile(steam.file, 'InstalledPackagesPath "Z:\\nowhere"\n');
    expect((await p.view()).targets).toEqual([]);
  });

  it('installs into Community (made if missing) and removes it again', async () => {
    const { pkgs, p } = await setup();
    const community = join(pkgs.steam, 'Community');
    expect((await p.view()).targets).toEqual([
      { install: 'steam', community, installed: null, foreign: false },
    ]);
    const v = await p.install();
    expect(v.targets[0]?.installed).toBe('1.0.0');
    expect(await readFile(join(community, SMOKE_PACKAGE, 'SimObjects', 'sim.cfg'), 'utf8')).toBe(
      'x',
    );
    expect(await readdir(community)).toEqual([SMOKE_PACKAGE]);
    expect((await p.remove()).targets[0]?.installed).toBeNull();
    expect(await readdir(community)).toEqual([]);
  });

  it('updates an older version, leaves the same or a newer one', async () => {
    const { pkgs, p } = await setup({ bundle: '1.2.0' });
    const dir = join(pkgs.steam, 'Community', SMOKE_PACKAGE);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'manifest.json'), manifest('1.1.0'));
    await writeFile(join(dir, 'old.txt'), 'old');
    await p.install();
    expect(await readdir(dir)).not.toContain('old.txt');
    expect((await p.view()).targets[0]?.installed).toBe('1.2.0');

    await writeFile(join(dir, 'manifest.json'), manifest('2.0.0'));
    await p.install();
    expect((await p.view()).targets[0]?.installed).toBe('2.0.0');
  });

  it('never touches a foreign folder of that name', async () => {
    const { pkgs, p } = await setup();
    const dir = join(pkgs.steam, 'Community', SMOKE_PACKAGE);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'manifest.json'), manifest('0.1.0', 'Someone else'));
    expect((await p.view()).targets[0]?.foreign).toBe(true);
    await p.install();
    await p.remove();
    expect(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')).title).toBe(
      'Someone else',
    );
  });

  it('installs into both the Store and the Steam versions', async () => {
    const { p } = await setup({ store: true, steam: true });
    const v = await p.install();
    expect(v.targets.map((t) => [t.install, t.installed])).toEqual([
      ['store', '1.0.0'],
      ['steam', '1.0.0'],
    ]);
  });

  it('no package in this build: shown as such, install refuses', async () => {
    const { p } = await setup({ bundle: null });
    expect((await p.view()).bundled).toBeNull();
    await expect(p.install()).rejects.toThrow(/not in this build/);
  });
});
