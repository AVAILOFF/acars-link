// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATION_MARKER, migrateOldUserData } from '../src/main/migrate.js';
import { tempDir } from './support.js';

async function oldFolder(root: string): Promise<string> {
  const dir = join(root, 'ACARS Sim');
  await mkdir(join(dir, 'recordings'), { recursive: true });
  await writeFile(join(dir, 'settings.json'), '{"xatc":true}');
  await writeFile(join(dir, 'airline-memory.json'), '{"flags":{}}');
  await writeFile(join(dir, 'secrets.json'), 'old secret');
  await writeFile(join(dir, 'recordings', 'a.jsonl'), 'old a');
  await writeFile(join(dir, 'recordings', 'b.jsonl'), 'old b');
  return dir;
}

describe('user data migration (ACARS Sim → ACARS Link)', () => {
  it('copies settings, airline memory and recordings once, not the secrets', async () => {
    const root = await tempDir();
    const old = await oldFolder(root);
    const neu = join(root, 'ACARS Link');
    await mkdir(join(neu, 'recordings'), { recursive: true });
    await writeFile(join(neu, 'settings.json'), '{"xatc":false}');
    await writeFile(join(neu, 'secrets.json'), 'new secret');
    await writeFile(join(neu, 'recordings', 'a.jsonl'), 'new a');

    expect(await migrateOldUserData(old, neu)).toEqual([
      'settings.json',
      'airline-memory.json',
      'recordings',
    ]);
    expect(await readFile(join(neu, 'settings.json'), 'utf8')).toBe('{"xatc":true}');
    expect(await readFile(join(neu, 'airline-memory.json'), 'utf8')).toBe('{"flags":{}}');
    expect(await readFile(join(neu, 'secrets.json'), 'utf8')).toBe('new secret');
    expect(await readFile(join(neu, 'recordings', 'a.jsonl'), 'utf8')).toBe('new a');
    expect(await readFile(join(neu, 'recordings', 'b.jsonl'), 'utf8')).toBe('old b');

    // Second start: the marker stops it, the new settings stay.
    await writeFile(join(neu, 'settings.json'), '{"xatc":false}');
    expect(await migrateOldUserData(old, neu)).toEqual([]);
    expect(await readFile(join(neu, 'settings.json'), 'utf8')).toBe('{"xatc":false}');
  });

  it('only writes the marker when there is no old folder', async () => {
    const root = await tempDir();
    const neu = join(root, 'ACARS Link');
    expect(await migrateOldUserData(join(root, 'ACARS Sim'), neu)).toEqual([]);
    expect(await readFile(join(neu, MIGRATION_MARKER), 'utf8')).toBe('');
  });
});
