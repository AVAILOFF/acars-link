// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatError,
  Logger,
  Redactor,
  RotatingFile,
  rotated,
  watchProcess,
} from '../src/main/log.js';
import { SecretStore } from '../src/main/secrets.js';
import { FakeCipher, tempDir } from './support.js';

/** T67: file logs of the main process and the bridge, without secrets. */

const LOGON = 'sEcReT9logonCODE';
const KEY = 'abcdef0123456789abcdef0123456789';
const TOKEN = 'Zm9vYmFyLWJyaWRnZS10b2tlbi1fLQ';
const T = Date.UTC(2026, 9, 29, 8, 0, 0);

function memoryLog(redactor: Redactor) {
  const lines: string[] = [];
  return { lines, log: new Logger({ write: (t) => lines.push(t) }, redactor, () => T) };
}

describe('redactor', () => {
  it('masks a secret in the message and in the stack trace, in any case', () => {
    const r = new Redactor();
    r.add(LOGON);
    r.add(KEY);
    r.add(TOKEN);
    const { lines, log } = memoryLog(r);
    const err = new Error(`Hoppie refused ${LOGON}`, {
      cause: new Error(`key ${KEY.toUpperCase()} rejected`),
    });
    err.stack = `Error: Hoppie refused ${LOGON}\n    at poll (connect.html?logon=${LOGON}&type=poll)`;
    log.error(`request with token ${TOKEN} failed`, err);
    const text = lines.join('');
    for (const s of [LOGON, KEY, KEY.toUpperCase(), TOKEN]) expect(text).not.toContain(s);
    expect(text).toContain('***');
    expect(text).toContain('caused by: Error: key *** rejected');
    expect(text.startsWith('2026-10-29T08:00:00.000Z ERROR request with token *** failed: ')).toBe(
      true,
    );
  });

  it('masks unknown values of secret parameters as a backstop', () => {
    const r = new Redactor();
    expect(r.redact('GET connect.html?logon=unknownCode1&from=OPS1')).toBe(
      'GET connect.html?logon=***&from=OPS1',
    );
    expect(r.redact('ACARS_BRIDGE_TOKEN=abc-123 next')).toBe('ACARS_BRIDGE_TOKEN=*** next');
    expect(r.redact('{"x-acars-bridge-token":"abc_1"}')).toBe('{"x-acars-bridge-token":"***"}');
  });

  it('masks the longer of two overlapping secrets whole and ignores empty ones', () => {
    const r = new Redactor();
    r.add('pilot');
    r.add('pilot42xyz');
    r.add('');
    r.add('   ');
    r.add(null);
    expect(r.redact('user pilot42xyz and pilot')).toBe('user *** and ***');
  });

  it('learns the secrets the secret store reads and saves', async () => {
    const dir = await tempDir();
    const r = new Redactor();
    const store = new SecretStore(join(dir, 'secrets.json'), new FakeCipher(), (v) => r.add(v));
    await store.set('hoppieLogon', LOGON);
    expect(r.redact(`code ${LOGON}`)).toBe('code ***');
    const fresh = new Redactor();
    const again = new SecretStore(join(dir, 'secrets.json'), new FakeCipher(), (v) => fresh.add(v));
    await again.get('hoppieLogon');
    expect(fresh.redact(`code ${LOGON}`)).toBe('code ***');
  });
});

describe('rotating file', () => {
  it('rotates by size and keeps the given number of files, newest in the plain name', async () => {
    const dir = await tempDir();
    const file = new RotatingFile(join(dir, 'logs', 'main.log'), 100, 3);
    for (let i = 0; i < 20; i++)
      file.write(`line ${String(i).padStart(2, '0')} ${'x'.repeat(30)}\n`);
    expect(readdirSync(join(dir, 'logs')).sort()).toEqual(['main.1.log', 'main.2.log', 'main.log']);
    const files = file.files();
    expect(files.map((f) => f.slice(dir.length + 6))).toEqual([
      'main.2.log',
      'main.1.log',
      'main.log',
    ]);
    for (const f of files) expect(readFileSync(f).length).toBeLessThanOrEqual(100);
    expect(readFileSync(join(dir, 'logs', 'main.log'), 'utf8')).toContain('line 19');
    expect(files.map((f) => readFileSync(f, 'utf8')).join('')).not.toContain('line 00');
  });

  it('goes on after a restart with the size on disk', async () => {
    const dir = await tempDir();
    const path = join(dir, 'bridge.log');
    new RotatingFile(path, 100, 2).write(`${'a'.repeat(90)}\n`);
    new RotatingFile(path, 100, 2).write(`${'b'.repeat(20)}\n`);
    expect(readFileSync(rotated(path, 1), 'utf8')).toBe(`${'a'.repeat(90)}\n`);
    expect(readFileSync(path, 'utf8')).toBe(`${'b'.repeat(20)}\n`);
  });

  it('never throws when the disk refuses', async () => {
    const dir = await tempDir();
    // A file where the folder should be: mkdir fails.
    const blocker = join(dir, 'blocker');
    new RotatingFile(blocker).write('x\n');
    expect(() => new RotatingFile(join(blocker, 'main.log')).write('y\n')).not.toThrow();
  });
});

describe('process errors', () => {
  it('logs uncaught exceptions and unhandled rejections without handling them', () => {
    const handlers = new Map<string, (...a: unknown[]) => void>();
    const proc = {
      on(event: string, fn: (...a: never[]) => void) {
        handlers.set(event, fn as (...a: unknown[]) => void);
        return proc;
      },
    };
    const r = new Redactor();
    r.add(LOGON);
    const { lines, log } = memoryLog(r);
    watchProcess(proc, log);
    // Only the monitor: an `uncaughtException` listener would replace Electron's handler.
    expect([...handlers.keys()]).toEqual(['uncaughtExceptionMonitor', 'unhandledRejection']);
    handlers.get('uncaughtExceptionMonitor')?.(new Error(`boom ${LOGON}`), 'uncaughtException');
    handlers.get('unhandledRejection')?.('plain reason');
    expect(lines[0]).toMatch(/ERROR uncaught exception \(uncaughtException\): Error: boom \*\*\*/);
    expect(lines[1]).toContain('ERROR unhandled promise rejection: plain reason');
  });

  it('formats an error without a stack and a thrown non-error', () => {
    const e = new Error('no stack');
    Object.defineProperty(e, 'stack', { value: undefined });
    expect(formatError(e)).toBe('Error: no stack');
    expect(formatError(42)).toBe('42');
  });
});
