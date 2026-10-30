// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { rename } from 'node:fs/promises';
import { FLIGHT_REPORT_VERSION, type FlightReport } from '@acars/core';
import { readTextFile, writeTextFileAtomic } from './files.js';

/**
 * The logbook (T69): the report of every flight closed at the gate, oldest first, in
 * `<userData>/logbook.json`. No limit (decision of 2026-10-30): it outlives the recordings, of which
 * only the last 20 are kept. A file that cannot be read is moved aside, never overwritten.
 */

export const LOGBOOK_VERSION = 1;

export interface LogbookEntry {
  /** When the flight was closed, the app clock (epoch ms). */
  readonly closedAt: number;
  readonly to: 'TURNAROUND' | 'DONE';
  /** The recording of the flight (file name); null = not kept. */
  readonly recording: string | null;
  readonly report: FlightReport;
}

export interface Logbook {
  readonly v: typeof LOGBOOK_VERSION;
  readonly flights: readonly LogbookEntry[];
}

export interface LogbookStore {
  append(entry: LogbookEntry): Promise<void>;
}

const isEntry = (x: unknown): x is LogbookEntry => {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  const r = e['report'] as Record<string, unknown> | null | undefined;
  return (
    typeof e['closedAt'] === 'number' &&
    (e['to'] === 'TURNAROUND' || e['to'] === 'DONE') &&
    (e['recording'] === null || typeof e['recording'] === 'string') &&
    typeof r === 'object' &&
    r !== null &&
    r['v'] === FLIGHT_REPORT_VERSION
  );
};

/** The flights of a logbook file; null = not a logbook (unreadable, another format). */
export function parseLogbook(text: string): LogbookEntry[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const b = raw as Record<string, unknown>;
  const flights = b['flights'];
  if (b['v'] !== LOGBOOK_VERSION || !Array.isArray(flights)) return null;
  return flights.filter(isEntry);
}

export class FileLogbook implements LogbookStore {
  /** One write at a time: two flights closed quickly do not lose one another. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly now: () => number,
  ) {}

  append(entry: LogbookEntry): Promise<void> {
    const next = this.queue.then(() => this.write(entry));
    this.queue = next.catch(() => {});
    return next;
  }

  private async write(entry: LogbookEntry): Promise<void> {
    const text = await readTextFile(this.file);
    let flights = text === null ? [] : parseLogbook(text);
    if (flights === null) {
      await rename(this.file, `${this.file}.${this.now()}.unreadable`);
      flights = [];
    }
    const book: Logbook = { v: LOGBOOK_VERSION, flights: [...flights, entry] };
    await writeTextFileAtomic(this.file, `${JSON.stringify(book, null, 2)}\n`);
  }
}
