// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

/**
 * File logs of the installed app (T67): `<userData>/logs/main.log` (main process) and `bridge.log`
 * (output of the bundled bridge). Lines are `2026-10-29T08:00:00.000Z INFO  text`, UTC, written
 * synchronously so the last lines before a crash are on disk. Every line goes through a
 * {@link Redactor} first: no logon code, RapidAPI key, SimBrief name or bridge token reaches a file.
 */

/** What the controller and the session log through; no Electron, no files. */
export interface Log {
  info(msg: string): void;
  warn(msg: string, err?: unknown): void;
  error(msg: string, err?: unknown): void;
}

export const NO_LOG: Log = { info: () => {}, warn: () => {}, error: () => {} };

/** T67 decision 2: five files of 5 MB per log. */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_FILES = 5;

export const MAIN_LOG = 'main.log';
export const BRIDGE_LOG = 'bridge.log';

const MASK = '***';

/**
 * Replaces the known secrets with `***`, case-insensitively, and masks secret-looking parameters
 * whose value it does not know (`logon=…`, the bridge token variable and header) as a backstop.
 * Secrets are added as they pass through the secret store, and old ones stay.
 */
export class Redactor {
  private secrets: string[] = [];

  add(secret: string | null | undefined): void {
    const s = secret?.trim() ?? '';
    if (s === '' || this.secrets.some((x) => x.toLowerCase() === s.toLowerCase())) return;
    // Longest first: a secret that contains another one is masked whole.
    this.secrets = [...this.secrets, s].sort((a, b) => b.length - a.length);
  }

  redact(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.replace(new RegExp(escapeRe(s), 'gi'), MASK);
    return out
      .replace(/\b(logon=)[^&\s"']+/gi, `$1${MASK}`)
      .replace(/\b(ACARS_BRIDGE_TOKEN["']?\s*[=:]\s*["']?)[^\s"',;}]+/gi, `$1${MASK}`)
      .replace(/\b(X-Acars-Bridge-Token["']?\s*[=:]\s*["']?)[^\s"',;}]+/gi, `$1${MASK}`);
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A log file that rotates by size: `main.log` → `main.1.log` → … → `main.4.log`, the oldest is
 * deleted. Errors of the disk are swallowed: logging never breaks the app.
 */
export class RotatingFile {
  private size = -1;

  constructor(
    readonly file: string,
    private readonly maxBytes = LOG_MAX_BYTES,
    private readonly keep = LOG_FILES,
  ) {}

  write(text: string): void {
    try {
      if (this.size < 0) {
        mkdirSync(dirname(this.file), { recursive: true });
        this.size = fileSize(this.file);
      }
      const bytes = Buffer.byteLength(text);
      if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
      appendFileSync(this.file, text, { mode: 0o600 });
      this.size += bytes;
    } catch {
      this.size = -1;
    }
  }

  /** The files of this log that exist, oldest first. */
  files(): string[] {
    const all = Array.from({ length: this.keep }, (_, i) => rotated(this.file, i));
    return all.filter(existsFile).reverse();
  }

  private rotate(): void {
    rmSync(rotated(this.file, this.keep - 1), { force: true });
    for (let i = this.keep - 2; i >= 0; i--) {
      const from = rotated(this.file, i);
      if (existsFile(from)) renameSync(from, rotated(this.file, i + 1));
    }
    this.size = 0;
  }
}

/** `main.log` for 0, `main.2.log` for 2. */
export function rotated(file: string, i: number): string {
  if (i === 0) return file;
  const ext = extname(file);
  return join(dirname(file), `${basename(file, ext)}.${i}${ext}`);
}

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function existsFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** One log: level, UTC time, redacted text (with the stack of an error). */
export class Logger implements Log {
  constructor(
    private readonly out: { write(text: string): void },
    private readonly redactor: Redactor,
    private readonly now: () => number = Date.now,
  ) {}

  info(msg: string): void {
    this.line('INFO', msg);
  }

  warn(msg: string, err?: unknown): void {
    this.line('WARN', msg, err);
  }

  error(msg: string, err?: unknown): void {
    this.line('ERROR', msg, err);
  }

  private line(level: string, msg: string, err?: unknown): void {
    const text = err === undefined ? msg : `${msg}: ${formatError(err)}`;
    const time = new Date(this.now()).toISOString();
    this.out.write(`${time} ${level.padEnd(5)} ${this.redactor.redact(text)}\n`);
  }
}

/** Stack (or name and message) of an error and of up to three causes. */
export function formatError(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; depth < 4 && cur !== undefined && cur !== null; depth++) {
    if (cur instanceof Error) {
      parts.push(cur.stack ?? `${cur.name}: ${cur.message}`);
      cur = cur.cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join('\n  caused by: ');
}

/**
 * Logs what the process does not handle. Neither listener changes what happens next (checked on
 * Electron 44, 2026-10-29): `uncaughtExceptionMonitor` only watches (Electron's own handler still
 * shows its dialog), and the main process runs in the `warn` mode of unhandled rejections, where
 * Node prints its warning whether a listener is set or not and the process goes on.
 */
export function watchProcess(
  proc: {
    on(event: 'uncaughtExceptionMonitor', fn: (e: Error, origin: string) => void): unknown;
    on(event: 'unhandledRejection', fn: (reason: unknown) => void): unknown;
  },
  log: Log,
): void {
  proc.on('uncaughtExceptionMonitor', (e, origin) =>
    log.error(`uncaught exception (${origin})`, e),
  );
  proc.on('unhandledRejection', (reason) => log.error('unhandled promise rejection', reason));
}
