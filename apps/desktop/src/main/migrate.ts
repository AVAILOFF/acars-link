// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { access, cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * One-time move of the user data from the old app name (T19, 2026-10-22): the rename
 * «ACARS Sim» → «ACARS Link» changed the user-data folder, and the app came up with default
 * settings (XATC off). Copied: settings, airline memory and recordings. Not copied: secrets
 * (encrypted with the old folder's key) and caches. The old folder stays as it was.
 */

/** User-data folder name of the app before the rename. */
export const OLD_APP_DIR = 'ACARS Sim';
/** Written into the new folder once the move ran (or had nothing to move). */
export const MIGRATION_MARKER = 'migrated-from-acars-sim';

const FILES = ['settings.json', 'airline-memory.json'] as const;
const RECORDINGS = 'recordings';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies the old data into `userData` unless the marker is there. Settings and airline memory
 * replace the new ones; recordings are added, a recording with the same name in the new folder
 * is kept. Returns the copied names; the marker is written only after every copy succeeded.
 */
export async function migrateOldUserData(oldDir: string, userData: string): Promise<string[]> {
  const marker = join(userData, MIGRATION_MARKER);
  if (await exists(marker)) return [];
  const copied: string[] = [];
  if (await exists(oldDir)) {
    await mkdir(userData, { recursive: true });
    for (const name of FILES) {
      const from = join(oldDir, name);
      if (!(await exists(from))) continue;
      await cp(from, join(userData, name), { force: true });
      copied.push(name);
    }
    const recordings = join(oldDir, RECORDINGS);
    if (await exists(recordings)) {
      await cp(recordings, join(userData, RECORDINGS), {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
      copied.push(RECORDINGS);
    }
  }
  await mkdir(userData, { recursive: true });
  await writeFile(marker, '');
  return copied;
}
