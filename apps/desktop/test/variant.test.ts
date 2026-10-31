// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as eurCal from '../../../packages/core/src/atc/squawk/eur-cal.js';
import * as icaoApac from '../../../packages/core/src/atc/squawk/icao-apac.js';
import * as natTrak from '../../../packages/data-sources/src/nattrak.js';
import { PUBLIC_BUILD, SQUAWK_TABLES } from '../src/main/variant.js';
import * as standEurCal from '../variants/public/eur-cal.js';
import * as standIcaoApac from '../variants/public/icao-apac.js';
import * as standNatTrak from '../variants/public/nattrak.js';

/** T72: the public build leaves out the CAL and eANP squawk tables and the natTrak adapter. */

const root = resolve(import.meta.dirname, '../../..');
const verify = join(root, 'tools/release/verify-public.mjs');
const keys = (m: object) => Object.keys(m).sort();

describe('build variants (T72)', () => {
  it('the personal build is the default: full tables', () => {
    expect(PUBLIC_BUILD).toBe(false);
    expect(SQUAWK_TABLES).toBe('full');
  });

  it('every public stand-in exports what the module it replaces exports, and is empty', () => {
    expect(keys(standEurCal)).toEqual(keys(eurCal));
    expect(keys(standIcaoApac)).toEqual(keys(icaoApac));
    expect(keys(standNatTrak)).toEqual(keys(natTrak));
    expect(standEurCal.EUR_CAL_ROWS).toHaveLength(0);
    expect(Object.keys(standEurCal.EUR_CAL_PAS)).toHaveLength(0);
    expect(Object.keys(standIcaoApac.ICAO_APAC_FIRS)).toHaveLength(0);
  });

  it('the stand-in natTrak makes no request and returns no tracks', async () => {
    expect(await standNatTrak.fetchNatTracks()).toEqual([]);
    expect(standNatTrak.parseNatTracks()).toEqual([]);
  });
});

describe('tools/release/verify-public.mjs', () => {
  const run = (...paths: string[]) =>
    spawnSync(process.execPath, [verify, ...paths], { encoding: 'utf8' });

  it('every string it looks for is in the module of the data it guards', () => {
    const sentinels = readFileSync(verify, 'utf8').matchAll(
      /\[\s*(["'])(.+?)\1,\s*['"](packages\/[^'"]+)['"]\s*\]/gs,
    );
    let n = 0;
    for (const m of sentinels) {
      const needle = (m[2] as string).replaceAll("'", "'");
      expect(readFileSync(join(root, m[3] as string), 'utf8'), needle).toContain(needle);
      n++;
    }
    expect(n).toBeGreaterThanOrEqual(5);
  });

  it('passes a folder with the stand-ins and fails on the real data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-public-'));
    try {
      writeFileSync(
        join(dir, 'clean.js'),
        `export const x = ${JSON.stringify(standEurCal.EUR_CAL_VERSION)};`,
      );
      expect(run(dir).status).toBe(0);
      writeFileSync(join(dir, 'main.js'), 'const v = "4.13 (2026-03-04)";');
      const bad = run(dir);
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain('4.13 (2026-03-04)');
      writeFileSync(join(dir, 'main.js'), 'fetch("https://nattrak.vatsim.net/api/tracks");');
      expect(run(dir).status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails without arguments', () => {
    expect(run().status).toBe(2);
  });
});

describe('tools/release/verify-bridge.mjs (T73)', () => {
  const script = join(root, 'tools/release/verify-bridge.mjs');
  const run = (...dirs: string[]) =>
    spawnSync(process.execPath, [script, ...dirs], { encoding: 'utf8' });
  const folder = (...files: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-bridge-'));
    for (const f of files) writeFileSync(join(dir, f), '');
    return dir;
  };

  it('passes a bridge with its own SimConnect layer and no Microsoft binaries', () => {
    const dir = folder('acars-msfs-bridge.exe', 'acars_simconnect.dll');
    try {
      expect(run(dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails on SimConnect.dll, on the managed wrapper and on a missing layer', () => {
    const ok = ['acars-msfs-bridge.exe', 'acars_simconnect.dll'];
    for (const [files, text] of [
      [[...ok, 'SimConnect.dll'], 'SimConnect.dll must not be shipped'],
      [[...ok, 'Microsoft.FlightSimulator.SimConnect.dll'], 'must not be shipped'],
      [['acars-msfs-bridge.exe'], 'acars_simconnect.dll is missing'],
    ] as const) {
      const dir = folder(...files);
      try {
        const r = run(dir);
        expect(r.status, text).toBe(1);
        expect(r.stderr).toContain(text);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
