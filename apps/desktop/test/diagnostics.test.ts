// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { ManualClock } from '@acars/core';
import { MockTransport } from '@acars/transport';
import { describe, expect, it } from 'vitest';
import { AppController } from '../src/main/controller.js';
import { diagnosticsFileName } from '../src/main/diagnostics.js';
import { Logger, Redactor, RotatingFile } from '../src/main/log.js';
import { BASE_SCENARIOS } from '../src/main/scenario-sources.js';
import { SecretStore } from '../src/main/secrets.js';
import { defaultSettings, SettingsStore } from '../src/main/settings.js';
import { zip } from '../src/main/zip.js';
import { FakeCipher, FakeHttp, FakeTimers, socketFactory, tempDir } from './support.js';

/** T67: the diagnostics .zip and the log lines of the controller. */

const T0 = Date.UTC(2026, 9, 29, 8, 30, 0);
const LOGON = 'LOGON0123456789abc';
const KEY = 'abcdef0123456789abcdef0123456789';

/** Reads a ZIP through its central directory; checks every CRC. */
function unzip(buf: Buffer): Map<string, string> {
  const end = buf.length - 22;
  expect(buf.readUInt32LE(end)).toBe(0x06054b50);
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const packed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    expect(buf.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = inflateRawSync(buf.subarray(start, start + packed));
    expect(data.length).toBe(size);
    expect(crc32(data)).toBe(crc);
    out.set(name, data.toString('utf8'));
    p += 46 + nameLen;
  }
  return out;
}

describe('zip', () => {
  it('writes entries that read back byte for byte, UTF-8 names included', () => {
    const big = 'LOADSHEET '.repeat(10_000);
    const files = unzip(
      zip(
        [
          { name: 'a.txt', data: 'hello\n' },
          { name: 'logs/журнал.log', data: big },
          { name: 'empty', data: new Uint8Array() },
        ],
        new Date(2026, 9, 29, 10, 15, 30),
      ),
    );
    expect([...files.keys()]).toEqual(['a.txt', 'logs/журнал.log', 'empty']);
    expect(files.get('logs/журнал.log')).toBe(big);
    expect(files.get('empty')).toBe('');
  });

  it('stores the MS-DOS date and time', () => {
    const buf = zip([{ name: 'x', data: 'x' }], new Date(2026, 9, 29, 10, 15, 30));
    expect(buf.readUInt16LE(10)).toBe((10 << 11) | (15 << 5) | 15);
    expect(buf.readUInt16LE(12)).toBe(((2026 - 1980) << 9) | (10 << 5) | 29);
  });
});

async function setup(chosen: (name: string) => string | null) {
  const dir = await tempDir();
  const clock = new ManualClock(T0);
  const redactor = new Redactor();
  const mainLog = new RotatingFile(join(dir, 'logs', 'main.log'));
  const bridgeFile = new RotatingFile(join(dir, 'logs', 'bridge.log'));
  const log = new Logger(mainLog, redactor, () => clock.now());
  const secrets = new SecretStore(join(dir, 'secrets.json'), new FakeCipher(), (v) =>
    redactor.add(v),
  );
  const recordings = join(dir, 'recordings');
  const sockets = socketFactory();
  const asked: string[] = [];
  const revealed: string[] = [];
  const app = new AppController({
    secrets,
    settings: new SettingsStore(join(dir, 'settings.json'), defaultSettings('en')),
    scenarioSources: BASE_SCENARIOS,
    http: new FakeHttp(() => new Error('offline')),
    createTransport: () => new MockTransport(clock),
    createSocket: sockets.create,
    timers: new FakeTimers(),
    now: () => clock.now(),
    openRecording: null,
    revealRecordings: async () => {},
    onChange: () => {},
    log,
    diagnostics: {
      logFiles: () => [...mainLog.files(), ...bridgeFile.files()],
      latestRecording: () => {
        const f = join(recordings, '20261029-080000-DLH4.jsonl');
        try {
          readFileSync(f);
          return f;
        } catch {
          return null;
        }
      },
      about: () => ({ app: 'ACARS Link 0.1.0', os: 'win32 10.0.26200 x64' }),
      redact: (t) => redactor.redact(t),
      choosePath: async (name) => {
        asked.push(name);
        const f = chosen(name);
        return f === null ? null : join(dir, f);
      },
      reveal: (f) => revealed.push(f),
    },
  });
  await app.init();
  return {
    dir,
    app,
    clock,
    sockets,
    secrets,
    redactor,
    log,
    bridgeFile,
    recordings,
    asked,
    revealed,
  };
}

describe('export diagnostics', () => {
  it('saves logs, versions and settings without secrets; the recording only when asked', async () => {
    const s = await setup((name) => name);
    await s.app.setHoppieCode(LOGON);
    await s.app.setAerodataboxKey(KEY);
    await s.app.setSimbriefUsername('pilot42');
    s.sockets.last().hello();
    // A line written before the key was known, and one of the bridge.
    s.bridgeFile.write(`bridge saw ${KEY} and pilot42\n`);
    s.log.warn(`transport: halted (logon ${LOGON})`);
    mkdirSync(s.recordings, { recursive: true });
    writeFileSync(
      join(s.recordings, '20261029-080000-DLH4.jsonl'),
      '{"type":"header","x":"pilot42"}\n',
    );

    const file = await s.app.exportDiagnostics(false);
    expect(s.asked).toEqual([diagnosticsFileName(T0)]);
    expect(diagnosticsFileName(T0)).toBe('acars-link-diagnostics-20261029-0830.zip');
    expect(file).toBe(join(s.dir, 'acars-link-diagnostics-20261029-0830.zip'));
    expect(s.revealed).toEqual([file]);
    const files = unzip(readFileSync(file ?? ''));
    expect([...files.keys()]).toEqual([
      'about.txt',
      'settings.json',
      'state.json',
      'logs/main.log',
      'logs/bridge.log',
    ]);
    const all = [...files.values()].join('\n');
    for (const secret of [LOGON, KEY, 'pilot42']) expect(all).not.toContain(secret);
    expect(files.get('about.txt')).toContain('bridge: t\n');
    expect(files.get('about.txt')).toContain('exported: 2026-10-29T08:30:00.000Z');
    const settings = JSON.parse(files.get('settings.json') ?? '');
    expect(settings.accounts).toEqual({
      simbriefUsername: true,
      hoppieCode: true,
      aerodataboxKey: true,
      secureStorage: true,
    });
    expect(settings.settings.bridgePort).toBe(defaultSettings('en').bridgePort);
    expect(JSON.parse(files.get('state.json') ?? '').bridge.link).toBe('open');
    expect(files.get('logs/main.log')).toContain('WARN  transport: halted (logon ***)');
    expect(files.get('logs/main.log')).toContain('INFO  bridge: link open, sim -, bridge t');
    expect(files.get('logs/bridge.log')).toBe('bridge saw *** and ***\n');

    const withRec = unzip(readFileSync((await s.app.exportDiagnostics(true)) ?? ''));
    expect(withRec.get('recording/20261029-080000-DLH4.jsonl')).toBe(
      '{"type":"header","x":"***"}\n',
    );
  });

  it('cancelled: nothing is written, nothing shown', async () => {
    const s = await setup(() => null);
    expect(await s.app.exportDiagnostics(true)).toBeNull();
    expect(s.revealed).toEqual([]);
    await expect(s.app.exportDiagnostics('yes')).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
