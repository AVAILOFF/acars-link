// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { cp, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SimInstall, SmokePackageTarget, SmokePackageView } from '../shared/api.js';

/**
 * The smoke package for MSFS 2024 (T104) in the Community folder: found, installed, updated and
 * removed by the app, only when the user presses the button.
 *
 * Where the Community folder is: the rules of the MSFS 2024 SDK sample `Samples/VisualStudio/
 * PackageInstaller/DetectMSFS/CustomAction.cpp` (SDK 1.8.1, checked 2026-11-05): `UserCfg.opt` of
 * the Store version in `%LOCALAPPDATA%\Packages\Microsoft.Limitless_8wekyb3d8bbwe\LocalCache`, of
 * the Steam version in `%APPDATA%\Microsoft Flight Simulator 2024`; its line `InstalledPackagesPath
 * "<folder>"` names an existing folder, Community is `<folder>\Community`. Both versions may be
 * installed: the package goes to each.
 */

/** Folder name of the package in Community: the package name the SDK made, `<company>-<name>` (T104). */
export const SMOKE_PACKAGE = 'avail-acars-smoke';

export interface SmokePackageEnv {
  /** `%LOCALAPPDATA%`. */
  readonly localAppData: string;
  /** `%APPDATA%`. */
  readonly appData: string;
  /** The built package shipped with the app; null = not in this build. */
  readonly bundleDir: string | null;
}

/** `UserCfg.opt` of each MSFS 2024 version, in the SDK sample's order. */
export function userCfgFiles(env: Pick<SmokePackageEnv, 'localAppData' | 'appData'>): {
  readonly install: SimInstall;
  readonly file: string;
}[] {
  return [
    {
      install: 'store',
      file: join(
        env.localAppData,
        'Packages',
        'Microsoft.Limitless_8wekyb3d8bbwe',
        'LocalCache',
        'UserCfg.opt',
      ),
    },
    { install: 'steam', file: join(env.appData, 'Microsoft Flight Simulator 2024', 'UserCfg.opt') },
  ];
}

/**
 * The `InstalledPackagesPath` value of `UserCfg.opt` (the SDK sample: the line holding
 * `InstalledPackagesPath `, then the text between the quotes); null = no such line.
 */
export function installedPackagesPath(text: string): string | null {
  let found: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /InstalledPackagesPath\s+"([^"]*)"/.exec(line);
    // The sample keeps the last such line.
    if (m?.[1] !== undefined && m[1] !== '') found = m[1];
  }
  return found;
}

/** Numbers of `x.y.z`; null = not a version. */
function versionParts(v: string): number[] | null {
  return /^\d+(\.\d+)*$/.test(v) ? v.split('.').map(Number) : null;
}

/** a > b for `x.y.z`; a version that does not parse is never newer. */
export function newerVersion(a: string, b: string): boolean {
  const pa = versionParts(a);
  const pb = versionParts(b);
  if (pa === null || pb === null) return false;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

interface Manifest {
  readonly title: string;
  readonly version: string;
}

async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    const m: unknown = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    if (typeof m !== 'object' || m === null) return null;
    const { title, package_version: version } = m as Record<string, unknown>;
    return typeof title === 'string' && typeof version === 'string' ? { title, version } : null;
  } catch {
    return null;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export class SmokePackage {
  constructor(private readonly env: SmokePackageEnv) {}

  /** The Community folders of the installed MSFS 2024 versions. */
  private async communities(): Promise<{ install: SimInstall; community: string }[]> {
    const out: { install: SimInstall; community: string }[] = [];
    for (const { install, file } of userCfgFiles(this.env)) {
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const root = installedPackagesPath(text);
      if (root !== null && (await isDir(root)))
        out.push({ install, community: join(root, 'Community') });
    }
    return out;
  }

  private async bundle(): Promise<Manifest | null> {
    return this.env.bundleDir === null ? null : readManifest(this.env.bundleDir);
  }

  async view(): Promise<SmokePackageView> {
    const bundle = await this.bundle();
    const targets: SmokePackageTarget[] = [];
    for (const { install, community } of await this.communities()) {
      const dir = join(community, SMOKE_PACKAGE);
      if (!(await exists(dir))) {
        targets.push({ install, community, installed: null, foreign: false });
        continue;
      }
      const m = await readManifest(dir);
      // A folder of that name that is not our package (another title, no manifest) is never touched.
      const foreign = m === null || (bundle !== null && m.title !== bundle.title);
      targets.push({ install, community, installed: m?.version ?? null, foreign });
    }
    return { bundled: bundle?.version ?? null, targets };
  }

  /**
   * Copies the bundled package into every Community folder found (new or older version; the same
   * or newer is left). The copy goes next to it first, then replaces the old folder.
   */
  async install(): Promise<SmokePackageView> {
    const src = this.env.bundleDir;
    const bundle = await this.bundle();
    if (src === null || bundle === null) throw new Error('the smoke package is not in this build');
    const before = await this.view();
    if (before.targets.length === 0)
      throw new Error('MSFS 2024 not found (no UserCfg.opt with InstalledPackagesPath)');
    for (const t of before.targets) {
      if (t.foreign) continue;
      if (t.installed !== null && !newerVersion(bundle.version, t.installed)) continue;
      await mkdir(t.community, { recursive: true });
      const dest = join(t.community, SMOKE_PACKAGE);
      const tmp = `${dest}.acars-tmp`;
      await rm(tmp, { recursive: true, force: true });
      await cp(src, tmp, { recursive: true });
      await rm(dest, { recursive: true, force: true });
      await rename(tmp, dest);
    }
    return this.view();
  }

  /** Removes our package from every Community folder (a foreign folder of that name stays). */
  async remove(): Promise<SmokePackageView> {
    for (const t of (await this.view()).targets) {
      if (t.foreign || t.installed === null) continue;
      await rm(join(t.community, SMOKE_PACKAGE), { recursive: true, force: true });
    }
    return this.view();
  }
}
