// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { VdgsCommand, VdgsMessage } from '@acars/core';
import { describe, expect, it } from 'vitest';
import {
  gsxVdgsDir,
  VDGS_FILE,
  type VdgsShown,
  VdgsWriter,
  vdgsFileJson,
} from '../src/main/vdgs.js';
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
    expect(JSON.parse(vdgsFileJson([cmd('vdgs_arrival', 'SJX') as VdgsShown]))).toEqual({
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

  it('T102: the departure board takes the id of the GSX message it replaces (flight_information)', () => {
    const c = cmd('vdgs_departure', 'SJX', 'EDDL');
    const board: VdgsCommand = {
      ...c,
      vdgs: { ...(c.vdgs as VdgsMessage), replaces: 'flight_information' },
    };
    const json = JSON.parse(
      vdgsFileJson([cmd('vdgs_arrival', 'SJX') as VdgsShown, board as VdgsShown]),
    );
    // GSX replaces a stock message only when the file lists it (sample_chock_override.json).
    expect(json.overrides).toEqual({ stock: ['flight_information'] });
    expect(json.messages[0].id).toBe('acars_vdgs_arrival');
    expect(json.messages[1]).toMatchObject({
      id: 'flight_information',
      conditions: { airports: ['EDDL'] },
    });
    expect(json.messages[1]).not.toHaveProperty('replaces');
    // No replacing message, no `overrides`.
    expect(JSON.parse(vdgsFileJson([cmd('vdgs_arrival', 'SJX') as VdgsShown]))).not.toHaveProperty(
      'overrides',
    );
  });

  it('T102: `vdgs: null` removes the scenario message; the last one gone, the file goes', async () => {
    const dir = join(await tempDir(), 'VGDS');
    const w = new VdgsWriter(dir);
    w.show(cmd('a', 'ONE'));
    w.show(cmd('b', 'TWO'));
    w.show({ command: 'vdgs', scenarioId: 'a', t: 1, vdgs: null });
    const file = JSON.parse(readFileSync(join(dir, VDGS_FILE), 'utf8'));
    expect(file.messages.map((m: { id: string }) => m.id)).toEqual(['acars_b']);
    w.show({ command: 'vdgs', scenarioId: 'zz', t: 1, vdgs: null }); // unknown: nothing to do
    w.show({ command: 'vdgs', scenarioId: 'b', t: 2, vdgs: null });
    expect(existsSync(join(dir, VDGS_FILE))).toBe(false);
  });

  it('T102: the same text is not written again (the board is rendered every minute)', async () => {
    const dir = join(await tempDir(), 'VGDS');
    const w = new VdgsWriter(dir);
    w.show(cmd('a', 'ONE'));
    const file = join(dir, VDGS_FILE);
    const before = statSync(file).mtimeMs;
    w.show({ ...cmd('a', 'ONE'), t: 60_000 });
    expect(statSync(file).mtimeMs).toBe(before);
    w.show(cmd('a', 'TWO'));
    expect(JSON.parse(readFileSync(file, 'utf8')).messages[0].display.wide.pages[0].lines).toEqual([
      'TWO',
    ]);
  });
});
