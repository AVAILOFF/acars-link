// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { CONNEX_RETENTION_MS, parseJsonl, purgeConnex, type Recording } from '@acars/replay';

/**
 * Flight recordings on disk (T11): one JSONL file per flight in the user-data folder, replayed
 * with `pnpm replay run <file>`. Lines are written synchronously, so a crash loses at most
 * the line being written (the replay reader skips a broken last line).
 *
 * A flight that was neither stopped nor ended is restored from its recording at the next start
 * (T64). With "Record flights" off the flight is recorded all the same, into a folder of its own,
 * and the file is deleted when the flight stops.
 */

export interface RecordingSink {
  readonly file: string;
  write(text: string): void;
  /** Closes the file; it stays (the app quits, the flight goes on at the next start). */
  close(): void;
  /** Closes at the end of the flight: a temporary recording is deleted; absent = `close`. */
  end?(): void;
  /** Lives as long as the flight (T64): the feed does not name it. */
  readonly temporary?: boolean;
}

/** `temporary`: the user does not keep recordings, the file lives as long as the flight (T64). */
export type OpenRecording = (callsign: string, now: number, temporary?: boolean) => RecordingSink;

/** Older recordings are deleted when a new one starts. */
export const KEEP_RECORDINGS = 20;

/** A flight is offered to go on this long after its recording was last written (T64, decision 4). */
export const RESUME_MAX_AGE_MS = 24 * 3_600_000;

/** Folder of the temporary recordings, next to the recordings one. */
export const tempRecordingsDir = (dir: string) => join(dirname(dir), 'flight-temp');

/** The flight to restore (T64). */
export interface UnfinishedFlight {
  readonly file: string;
  readonly recording: Recording;
  /** Last write, wall clock. */
  readonly writtenAt: number;
  readonly temporary: boolean;
}

export interface FlightResume {
  /** The newest recording, if its flight was neither ended nor stopped and is fresh enough. */
  find(now: number): UnfinishedFlight | null;
  /** Writes on at the end of the file. */
  append(file: string): RecordingSink;
  /** The user gave the flight up: a kept recording gets this last line, a temporary one is deleted. */
  discard(f: UnfinishedFlight, lastLine: string): void;
}

const FILE_RE = /^\d{8}-\d{6}-[A-Z0-9]+(?:-\d+)?\.jsonl$/;

/** `20261008-074500-SJX822.jsonl` (UTC), sorts by time. */
export function recordingName(callsign: string, now: number): string {
  const iso = new Date(now).toISOString();
  const stamp = `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}`;
  const cs = callsign.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'FLIGHT';
  return `${stamp}-${cs}.jsonl`;
}

export function fileRecordings(
  dir: string,
  keep = KEEP_RECORDINGS,
  temp = tempRecordingsDir(dir),
): OpenRecording {
  return (callsign, now, temporary = false) => {
    const into = temporary ? temp : dir;
    mkdirSync(into, { recursive: true });
    const name = recordingName(callsign, now);
    let file = join(into, name);
    let fd: number | null = null;
    for (let i = 1; fd === null; i++) {
      try {
        fd = openSync(file, 'wx', 0o600);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || i > 50) throw e;
        file = join(into, name.replace(/\.jsonl$/, `-${i}.jsonl`));
      }
    }
    // One temporary flight at a time; the kept ones are pruned to the newest N.
    prune(into, temporary ? 1 : keep);
    if (!temporary) purgeOldConnex(dir, now);
    return sink(fd, file, temporary);
  };
}

function sink(fd: number, file: string, temporary: boolean): RecordingSink {
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    closeSync(fd);
  };
  return {
    file,
    temporary,
    write(text) {
      if (open) writeSync(fd, text);
    },
    close,
    end() {
      close();
      if (temporary) rmSync(file, { force: true });
    },
  };
}

/** Restoring flights from the recordings (T64): `dir` and its temporary folder. */
export function fileResume(
  dir: string,
  maxAgeMs = RESUME_MAX_AGE_MS,
  temp = tempRecordingsDir(dir),
): FlightResume {
  const isTemp = (file: string) => dirname(file) === temp;
  return {
    find(now) {
      const files = [dir, temp].flatMap((d) => names(d).map((f) => ({ f, file: join(d, f) })));
      // The newest flight by its start (the name); an older unfinished one is not offered.
      const newest = files.sort((a, b) => a.f.localeCompare(b.f)).at(-1);
      if (newest === undefined) return null;
      try {
        const writtenAt = statSync(newest.file).mtimeMs;
        const temporary = isTemp(newest.file);
        if (now - writtenAt > maxAgeMs) {
          if (temporary) rmSync(newest.file, { force: true });
          return null;
        }
        const parsed = parseJsonl(readFileSync(newest.file, 'utf8'));
        if (parsed.kind !== 'recording') return null;
        const r = parsed.recording;
        if (!unfinished(r)) return null;
        return { file: newest.file, recording: r, writtenAt, temporary };
      } catch {
        return null;
      }
    },
    append(file) {
      const fd = openSync(file, 'a', 0o600);
      return sink(fd, file, isTemp(file));
    },
    discard(f, lastLine) {
      if (f.temporary) rmSync(f.file, { force: true });
      else writeFileSync(f.file, lastLine, { flag: 'a', mode: 0o600 });
    },
  };
}

/**
 * A desktop flight that started and was neither ended at ON_BLOCK nor stopped. Recordings made
 * before T64 (no `simTime` in the header) are never restored: they do not say which telexes left.
 */
export function unfinished(r: Recording): boolean {
  if (r.header.source !== 'desktop' || r.header.simTime === undefined) return false;
  let started = false;
  for (const e of r.events) {
    if (e.type === 'start') started = true;
    if (e.type === 'end' || e.type === 'stop') return false;
  }
  return started;
}

function names(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => FILE_RE.test(f));
  } catch {
    return [];
  }
}

/**
 * AeroDataBox data of recordings last written more than 7 days ago are purged (T30, docs/07 C9:
 * terms p. 5.5); the file being written now is never older. Errors leave a file as it is.
 */
export function purgeOldConnex(dir: string, now: number): void {
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => FILE_RE.test(f));
  } catch {
    return;
  }
  for (const f of names) {
    const file = join(dir, f);
    try {
      if (now - statSync(file).mtimeMs <= CONNEX_RETENTION_MS) continue;
      const purged = purgeConnex(readFileSync(file, 'utf8'));
      if (purged === null) continue;
      writeFileSync(`${file}.tmp`, purged, { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch {
      // Next start tries again.
    }
  }
}

/** Keeps the newest `keep` recordings; never touches other files. */
function prune(dir: string, keep: number): void {
  const old = names(dir).sort().slice(0, -keep);
  for (const f of old) rmSync(join(dir, f), { force: true });
}
