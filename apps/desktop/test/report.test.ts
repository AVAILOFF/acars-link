// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateSyntheticFlight, ManualClock, parseSimbriefOfp } from '@acars/core';
import { parseJsonl, replay } from '@acars/replay';
import { loadScenarios } from '@acars/scenarios';
import { MockTransport } from '@acars/transport';
import { describe, expect, it } from 'vitest';
import { AppController, reportFileName } from '../src/main/controller.js';
import { guard } from '../src/main/errors.js';
import { FileLogbook, parseLogbook } from '../src/main/logbook.js';
import { fileRecordings } from '../src/main/recording.js';
import { BASE_SCENARIOS } from '../src/main/scenario-sources.js';
import { SecretStore } from '../src/main/secrets.js';
import { defaultSettings, SettingsStore } from '../src/main/settings.js';
import { MESSAGES } from '../src/renderer/src/i18n.js';
import {
  FakeCipher,
  FakeTimers,
  OFP_FIXTURE,
  simbriefOk,
  socketFactory,
  tempDir,
} from './support.js';

/** T69: the flight report in the app — at the gate, in the recording, the logbook and as JSON. */

const ofp = parseSimbriefOfp(JSON.parse(await readFile(OFP_FIXTURE, 'utf8')));
const flight = generateSyntheticFlight({ ofp, boardingSec: 65 * 60 });
const T0 = flight.snapshots[0]?.t ?? 0;

async function setup(o: { savePath?: string | null } = {}) {
  const dir = await tempDir();
  const clock = new ManualClock(T0);
  const sockets = socketFactory();
  const recordings = join(dir, 'recordings');
  const revealed: string[] = [];
  const app = new AppController({
    secrets: new SecretStore(join(dir, 'secrets.json'), new FakeCipher()),
    settings: new SettingsStore(join(dir, 'settings.json'), defaultSettings('en')),
    scenarioSources: BASE_SCENARIOS,
    http: await simbriefOk(),
    createTransport: () => new MockTransport(clock),
    createSocket: sockets.create,
    timers: new FakeTimers(),
    now: () => clock.now(),
    openRecording: fileRecordings(recordings),
    revealRecordings: async () => {},
    onChange: () => {},
    logbook: new FileLogbook(join(dir, 'logbook.json'), () => clock.now()),
    reportExport: {
      choosePath: async () => (o.savePath === undefined ? join(dir, 'report.json') : o.savePath),
      reveal: (f) => void revealed.push(f),
    },
  });
  await app.init();
  sockets.last().hello();
  await app.setSimbriefUsername('pilot42');
  await app.updateSettings({ transport: 'offline' });
  await app.loadOfp();
  await app.startFlight();
  return { app, clock, sockets, dir, recordings, revealed };
}
type Setup = Awaited<ReturnType<typeof setup>>;

function fly(s: Setup): void {
  for (const snap of flight.snapshots) {
    s.clock.set(Math.max(s.clock.now(), snap.t));
    s.sockets.last().frame({ type: 'telemetry', data: snap });
    s.app.tick(s.clock.now());
  }
}

/** One snapshot a second at the gate (the turnaround goes on). */
function park(s: Setup, sec: number): void {
  const last = flight.snapshots.at(-1);
  if (last === undefined) throw new Error('no snapshots');
  for (let i = 0; i < sec; i++) {
    s.clock.set(s.clock.now() + 1000);
    s.sockets.last().frame({ type: 'telemetry', data: { ...last, t: s.clock.now() } });
    s.app.tick(s.clock.now());
  }
}

const recordingOf = (s: Setup) => {
  const [file] = readdirSync(s.recordings);
  if (file === undefined) throw new Error('no recording');
  return { file, text: readFileSync(join(s.recordings, file), 'utf8') };
};

describe('flight report in the app (T69)', () => {
  it('none before the gate; at TURNAROUND the report of the flight, the same as `replay summary`', async () => {
    const s = await setup();
    expect(s.app.state().report).toBeNull();
    expect(await guard(() => s.app.exportReport())).toMatchObject({
      ok: false,
      error: { code: 'bad_state', reason: 'no_report' },
    });
    fly(s);
    expect(s.app.state().phase).toBe('ON_BLOCK');
    expect(s.app.state().report).toBeNull();
    await s.app.endFlight('TURNAROUND');
    const view = s.app.state().report;
    expect(view).not.toBeNull();
    const r = view?.report;
    expect(r).toMatchObject({ callsign: ofp.callsign, origin: 'RCTP', destination: 'RJBB' });
    expect(r?.landed).toMatchObject({ icao: 'RJBB', diverted: false });
    expect(r?.touchdownFpm).toBeNull();
    expect(r?.times.IN.actual).not.toBeNull();

    // The turnaround goes on; the report stays as it was taken at the gate.
    park(s, 300);
    expect(s.app.state().report).toEqual(view);

    // The recording: a `summary` line after `end`; its replay gives the same report.
    const { file, text } = recordingOf(s);
    const parsed = parseJsonl(text);
    if (parsed.kind !== 'recording') throw new Error('not a recording');
    const events = parsed.recording.events;
    const end = events.findIndex((e) => e.type === 'end');
    expect(events[end + 1]).toMatchObject({ type: 'summary', report: r });
    const h = parsed.recording.header;
    const scenarios = loadScenarios(BASE_SCENARIOS).filter((c) => h.scenarios.includes(c.id));
    const replayed = replay(parsed.recording, { scenarios });
    expect(replayed.report).toEqual(r);
    expect(replayed.recordedReport).toEqual(r);

    // The logbook: one entry with the recording's name.
    const book = parseLogbook(readFileSync(join(s.dir, 'logbook.json'), 'utf8'));
    expect(book).toEqual([
      { closedAt: expect.any(Number), to: 'TURNAROUND', recording: file, report: r },
    ]);
  });

  it('stays after the flight is closed, goes when the next OFP is loaded', async () => {
    const s = await setup();
    fly(s);
    await s.app.endFlight('DONE');
    park(s, 1);
    await s.app.closeFlight('close', false);
    expect(s.app.state().session).toBe('ready');
    expect(s.app.state().report).not.toBeNull();
    await s.app.loadOfp();
    expect(s.app.state().report).toBeNull();
  });

  it('saved as JSON where the user picks; cancelled = null', async () => {
    const s = await setup();
    fly(s);
    await s.app.endFlight('DONE');
    const file = await s.app.exportReport();
    expect(file).toBe(join(s.dir, 'report.json'));
    expect(JSON.parse(readFileSync(file as string, 'utf8'))).toEqual(s.app.state().report?.report);
    expect(s.revealed).toEqual([file]);
    expect(reportFileName(s.app.state().report?.report as never)).toMatch(
      /^flight-report-SJX822-RCTP-RJBB-\d{8}\.json$/,
    );

    const c = await setup({ savePath: null });
    fly(c);
    await c.app.endFlight('DONE');
    expect(await c.app.exportReport()).toBeNull();
  });
});

describe('logbook (T69)', () => {
  const entry = (n: number) => ({
    closedAt: n,
    to: 'DONE' as const,
    recording: null,
    report: { v: 1, callsign: `X${n}` } as never,
  });

  it('appends every flight, no limit; an unreadable file is moved aside, not overwritten', async () => {
    const dir = await tempDir();
    const file = join(dir, 'logbook.json');
    const book = new FileLogbook(file, () => 42);
    await Promise.all([book.append(entry(1)), book.append(entry(2))]);
    for (let i = 3; i <= 30; i++) await book.append(entry(i));
    const flights = parseLogbook(readFileSync(file, 'utf8'));
    expect(flights?.map((f) => f.closedAt)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));

    writeFileSync(file, '{broken');
    await book.append(entry(99));
    expect(parseLogbook(readFileSync(file, 'utf8'))?.map((f) => f.closedAt)).toEqual([99]);
    expect(readFileSync(`${file}.42.unreadable`, 'utf8')).toBe('{broken');
    expect(parseLogbook('{"v":2,"flights":[]}')).toBeNull();
  });
});

describe('report texts (T69)', () => {
  it('every report key in both languages', () => {
    const keys = Object.keys(MESSAGES.en).filter((k) => k.startsWith('report.'));
    expect(keys.length).toBeGreaterThan(20);
    for (const k of [...keys, 'why.no_report']) {
      expect(MESSAGES.en[k as keyof typeof MESSAGES.en]).toBeTruthy();
      expect(MESSAGES.ru[k as keyof typeof MESSAGES.ru]).toBeTruthy();
      expect(MESSAGES.ru[k as keyof typeof MESSAGES.ru]).not.toBe(
        MESSAGES.en[k as keyof typeof MESSAGES.en],
      );
    }
  });
});
