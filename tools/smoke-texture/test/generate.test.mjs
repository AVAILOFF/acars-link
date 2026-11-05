// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodePng, smokePixels } from '../generate.mjs';

const TEXTURE = new URL(
  '../../../bridge/msfs/package/PackageSources/MaterialLibs/acars-smoke-materiallib/Textures/acars_smoke.png',
  import.meta.url,
);

describe('smoke texture (T104)', () => {
  const size = 512;
  const px = smokePixels(size, 104);

  it('is the same for the same seed and differs for another', () => {
    expect(smokePixels(64, 104)).toEqual(smokePixels(64, 104));
    expect(smokePixels(64, 105)).not.toEqual(smokePixels(64, 104));
  });

  it('fades to fully transparent at the border, so no square edge shows', () => {
    let max = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (x > 8 && y > 8 && x < size - 9 && y < size - 9) continue;
        max = Math.max(max, px[(y * size + x) * 4 + 3]);
      }
    }
    expect(max).toBe(0);
  });

  it('has a dense middle, never fully opaque', () => {
    let max = 0;
    for (let i = 3; i < px.length; i += 4) max = Math.max(max, px[i]);
    expect(max).toBeGreaterThan(200);
    expect(max).toBeLessThan(255);
  });

  it('the file in the package is the generator output (seed 104, 512 px)', () => {
    expect(readFileSync(TEXTURE).equals(encodePng(px, size))).toBe(true);
  });
});
