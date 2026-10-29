// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { crc32, deflateRawSync } from 'node:zlib';

/**
 * A plain ZIP archive (PKWARE APPNOTE 6.3.x: local headers, central directory, end record; deflate;
 * UTF-8 names) for the diagnostics export (T67, decision 3: one .zip, no dependency). No ZIP64:
 * every size and offset must stay below 4 GiB, which logs of 2 × 25 MB and one recording do.
 */

export interface ZipEntry {
  /** Path inside the archive, `/`-separated. */
  readonly name: string;
  readonly data: Uint8Array | string;
}

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const VERSION = 20;
const UTF8_NAMES = 0x0800;
const DEFLATE = 8;
const MAX32 = 0xffffffff;

export function zip(entries: readonly ZipEntry[], date: Date): Buffer {
  if (entries.length > 0xffff) throw new RangeError('zip: too many entries');
  const { time, day } = dosTime(date);
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : Buffer.from(e.data);
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    if (data.length > MAX32 || packed.length > MAX32 || offset > MAX32) {
      throw new RangeError('zip: entry too large');
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(DEFLATE, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(CENTRAL, 0);
    dir.writeUInt16LE(VERSION, 4);
    dir.writeUInt16LE(VERSION, 6);
    dir.writeUInt16LE(UTF8_NAMES, 8);
    dir.writeUInt16LE(DEFLATE, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(day, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    // Extra, comment, disk, internal and external attributes: 0.
    dir.writeUInt32LE(offset, 42);
    parts.push(local, name, packed);
    central.push(dir, name);
    offset += local.length + name.length + packed.length;
  }
  const dirSize = central.reduce((n, b) => n + b.length, 0);
  if (offset > MAX32 || dirSize > MAX32) throw new RangeError('zip: archive too large');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

/** MS-DOS date and time (local, 2 s steps; years 1980–2107). */
function dosTime(d: Date): { time: number; day: number } {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    day: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
