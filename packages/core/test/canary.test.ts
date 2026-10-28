// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { modelFamily } from '../src/index.js';

// Canaries (T62, approved 2026-10-28; list in docs/07 T62): entries that mark our tables as ours
// and must never change what the pilot gets.
const MODEL_CANARY = 'EMBRAER 190 STD-AVF';

describe('canaries (T62)', () => {
  it('the aircraft-model canary has no family, the same as a string not in the table', () => {
    expect(modelFamily(MODEL_CANARY)).toBeNull();
    expect(modelFamily(MODEL_CANARY.toLowerCase())).toBeNull();
    expect(modelFamily('EMBRAER 190')).toBe('E-JET');
  });

  it('the aircraft-model canary is not a string AeroDataBox answered with', () => {
    const dir = join(import.meta.dirname, '../../data-sources/test/fixtures');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      expect(readFileSync(join(dir, file), 'utf8').toUpperCase()).not.toContain(MODEL_CANARY);
    }
  });
});
