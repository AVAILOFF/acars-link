// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VdgsCommand } from '@acars/core';
import { describe, expect, it } from 'vitest';
import { gsxVdgsDir, VDGS_FILE, VdgsWriter, vdgsFileJson } from '../src/main/vdgs.js';
import { tempDir } from './support.js';

const cmd = (scenarioId: string, text: string, airport = 'RJBB'): VdgsCommand => ({
  command: 'vdgs',
  scenarioId,
  t: 0,
  vdgs: {
    airport,
    durationMs: 6000,
    displays: {
      narrow: [
        { text, red: false },
        { text: 'GATE', red: true },
      ],
      wide: [{ text, red: false }],
    },
  },
});

describe('GSX VDGS file (T22)', () => {
  it('has the header and message shape of the FSDreamTeam manual', () => {
    expect(JSON.parse(vdgsFileJson([cmd('vdgs_arrival', 'SJX')]))).toEqual({
      type: 'vgds_messages',
      version: '1.0',
      enabled: true,
      auto_cleanup: false,
      source: 'ACARS Link',
      messages: [
        {
          id: 'acars_vdgs_arrival',
          duration: 6000,
          conditions: { airports: ['RJBB'] },
          display: {
            narrow: { pages: [{ lines: ['SJX', { red: 'GATE' }] }] },
            wide: { pages: [{ lines: ['SJX'] }] },
          },
        },
      ],
    });
  });

  it('finds the folder only when GSX is installed for the user', async () => {
    const appData = await tempDir();
    expect(gsxVdgsDir(appData)).toBeNull();
    mkdirSync(join(appData, 'Virtuali', 'GSX'), { recursive: true });
    expect(gsxVdgsDir(appData)).toBe(join(appData, 'Virtuali', 'GSX', 'VGDS'));
  });

  it('one file: a message per scenario, replaced in place, removed by clear()', async () => {
    const dir = join(await tempDir(), 'VGDS');
    const w = new VdgsWriter(dir);
    expect(w.available).toBe(true);
    w.show(cmd('a', 'ONE'));
    w.show(cmd('b', 'TWO'));
    w.show(cmd('a', 'THREE'));
    expect(readdirSync(dir)).toEqual([VDGS_FILE]); // no temp file left behind
    const file = JSON.parse(readFileSync(join(dir, VDGS_FILE), 'utf8'));
    expect(file.messages.map((m: { id: string }) => m.id)).toEqual(['acars_a', 'acars_b']);
    expect(file.messages[0].display.wide.pages[0].lines).toEqual(['THREE']);
    w.clear();
    expect(existsSync(join(dir, VDGS_FILE))).toBe(false);
    w.clear(); // twice is fine
  });

  it('without GSX nothing is written', () => {
    const w = new VdgsWriter(null);
    expect(w.available).toBe(false);
    w.show(cmd('a', 'ONE'));
    w.clear();
  });
});
