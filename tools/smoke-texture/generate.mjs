// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

// Smoke puff texture for the ACARS Smoke effect (T104), made from scratch so the package can ship
// (the SimpleFX sample texture may not be distributed: MSFS SDK EULA 11/2019, 1 b).
// One puff, 512×512 RGBA, straight alpha: white with soft self-shading, alpha = density with edges
// fading to 0. The effect's colour curve tints it. Same seed → same bytes.
//
//   node tools/smoke-texture/generate.mjs [--out <file.png>] [--seed <n>] [--size <px>]

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

/** 32-bit seeded PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable value noise on a `period`×`period` lattice, smooth-step interpolated. */
function valueNoise(rand, period) {
  const g = new Float64Array(period * period);
  for (let i = 0; i < g.length; i++) g[i] = rand();
  const at = (x, y) =>
    g[(((y % period) + period) % period) * period + (((x % period) + period) % period)];
  return (x, y) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
    return a + (b - a) * sy;
  };
}

/** Fractal sum of octaves in 0..1; `u`, `v` in 0..1. */
function fbm(octaves) {
  return (u, v) => {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    for (const o of octaves) {
      sum += amp * o.n(u * o.f, v * o.f);
      norm += amp;
      amp *= 0.5;
    }
    return sum / norm;
  };
}

const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** RGBA bytes of the puff. */
export function smokePixels(size, seed) {
  const rand = rng(seed);
  const octaves = (base) =>
    [0, 1, 2, 3, 4, 5].map((i) => ({ f: base << i, n: valueNoise(rand, base << i) }));
  const density = fbm(octaves(4));
  const warpX = fbm(octaves(3));
  const warpY = fbm(octaves(3));
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      // Domain warp: billowy, not grainy.
      const wu = u + 0.12 * (warpX(u, v) - 0.5);
      const wv = v + 0.12 * (warpY(u, v) - 0.5);
      const d = density(wu, wv);
      // Radial falloff with a noisy rim, so the puff is round but not a disc; 0 well before the edge.
      const r = Math.hypot(u - 0.5, v - 0.5) * 2;
      const rim = 0.9 + 0.3 * (d - 0.5);
      const fall = 1 - smooth(0.2 * rim, rim, r);
      // Billows inside: density varies the alpha also in the core, never fully opaque.
      const a = 0.95 * fall * smooth(0.2, 0.62, d);
      // Self-shading: light from above-left (density slope towards the light), plus top brighter.
      const lit = density(wu - 0.012, wv - 0.012) - d;
      const shade = 0.78 + 0.14 * (1 - v) + 2.2 * lit;
      const c = Math.round(255 * Math.min(1, Math.max(0, shade)));
      const i = (y * size + x) * 4;
      px[i] = c;
      px[i + 1] = c;
      px[i + 2] = c;
      px[i + 3] = Math.round(255 * Math.min(1, Math.max(0, a)));
    }
  }
  return px;
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** PNG (8-bit RGBA, no filter) of `px`. */
export function encodePng(px, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, def) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : def;
  };
  const size = Number(arg('--size', '512'));
  const seed = Number(arg('--seed', '104'));
  const out = arg(
    '--out',
    'bridge/msfs/package/PackageSources/MaterialLibs/acars-smoke-materiallib/Textures/acars_smoke.png',
  );
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, encodePng(smokePixels(size, seed), size));
  console.log(`${out}: ${size}×${size}, seed ${seed}`);
}
