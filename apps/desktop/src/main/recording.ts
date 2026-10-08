import { closeSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Flight recordings on disk (T11): one JSONL file per flight in the user-data folder, replayed
 * with `pnpm replay run <file>`. Lines are written synchronously, so a crash loses at most
 * the line being written (the replay reader skips a broken last line).
 */

export interface RecordingSink {
  readonly file: string;
  write(text: string): void;
  close(): void;
}

export type OpenRecording = (callsign: string, now: number) => RecordingSink;

/** Older recordings are deleted when a new one starts. */
export const KEEP_RECORDINGS = 20;

const FILE_RE = /^\d{8}-\d{6}-[A-Z0-9]+(?:-\d+)?\.jsonl$/;

/** `20261008-074500-SJX822.jsonl` (UTC), sorts by time. */
export function recordingName(callsign: string, now: number): string {
  const iso = new Date(now).toISOString();
  const stamp = `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}`;
  const cs = callsign.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'FLIGHT';
  return `${stamp}-${cs}.jsonl`;
}

export function fileRecordings(dir: string, keep = KEEP_RECORDINGS): OpenRecording {
  return (callsign, now) => {
    mkdirSync(dir, { recursive: true });
    const name = recordingName(callsign, now);
    let file = join(dir, name);
    let fd: number | null = null;
    for (let i = 1; fd === null; i++) {
      try {
        fd = openSync(file, 'wx', 0o600);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || i > 50) throw e;
        file = join(dir, name.replace(/\.jsonl$/, `-${i}.jsonl`));
      }
    }
    prune(dir, keep);
    const handle = fd;
    let open = true;
    return {
      file,
      write(text) {
        if (open) writeSync(handle, text);
      },
      close() {
        if (!open) return;
        open = false;
        closeSync(handle);
      },
    };
  };
}

/** Keeps the newest `keep` recordings; never touches other files. */
function prune(dir: string, keep: number): void {
  const old = readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .sort()
    .slice(0, -keep);
  for (const f of old) rmSync(join(dir, f), { force: true });
}
