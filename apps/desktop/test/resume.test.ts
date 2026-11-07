// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type FlightPhase,
  generateSyntheticFlight,
  ManualClock,
  parseSimbriefOfp,
} from '@acars/core';
import { compareOutbound, parseJsonl, type Recording, replay } from '@acars/replay';
import { loadScenarios } from '@acars/scenarios';
import { MockTransport } from '@acars/transport';
import { describe, expect, it } from 'vitest';
import { AppController } from '../src/main/controller.js';
import { guard } from '../src/main/errors.js';
import {
  fileRecordings,
  fileResume,
  RESUME_MAX_AGE_MS,
  tempRecordingsDir,
} from '../src/main/recording.js';
import { BASE_SCENARIOS } from '../src/main/scenario-sources.js';
import { SecretStore } from '../src/main/secrets.js';
import { defaultSettings, SettingsStore } from '../src/main/settings.js';
import type { FeedEntry } from '../src/shared/api.js';
import {
  FakeCipher,
  FakeTimers,
  OFP_FIXTURE,
  simbriefOk,
  socketFactory,
  tempDir,
} from './support.js';

/** T64: a flight the app lost goes on from its recording. */

const SCENARIOS = loadScenarios(BASE_SCENARIOS);
const ofp = parseSimbriefOfp(JSON.parse(await readFile(OFP_FIXTURE, 'utf8')));
const flight = generateSyntheticFlight({ ofp, boardingSec: 65 * 60 });
const T0 = flight.snapshots[0]?.t ?? 0;

/** One run of the app on a user-data folder; a second one on the same folder is the restart. */
async function launch(dir: string, clock: ManualClock) {
  const recordings = join(dir, 'recordings');
  const sockets = socketFactory();
  const transports: MockTransport[] = [];
  const app = new AppController({
    secrets: new SecretStore(join(dir, 'secrets.json'), new FakeCipher()),
    settings: new SettingsStore(join(dir, 'settings.json'), defaultSettings('en')),
    scenarioSources: BASE_SCENARIOS,
    http: await simbriefOk(),
    createTransport: () => {
      const t = new MockTransport(clock);
      transports.push(t);
      return t;
    },
    createSocket: sockets.create,
    timers: new FakeTimers(),
    now: () => clock.now(),
    openRecording: fileRecordings(recordings),
    resume: fileResume(recordings),
    revealRecordings: async () => {},
    onChange: () => {},
  });
  await app.init();
  sockets.last().hello();
  return { app, sockets, transports, recordings };
}
type Run = Awaited<ReturnType<typeof launch>>;

async function startOffline(r: Run, record = true): Promise<void> {
  await r.app.setSimbriefUsername('pilot42');
  await r.app.updateSettings({ transport: 'offline', recordFlights: record });
  await r.app.loadOfp();
  await r.app.startFlight();
}

/** Feeds snapshots [from, to) through the bridge socket and the 1 Hz loop; `until` stops early. */
function fly(
  r: Run,
  clock: ManualClock,
  from: number,
  to = flight.snapshots.length,
  until?: (phase: FlightPhase | null) => boolean,
): number {
  for (let i = from; i < to; i++) {
    const snap = flight.snapshots[i];
    if (snap === undefined) break;
    clock.set(Math.max(clock.now(), snap.t));
    r.sockets.last().frame({ type: 'telemetry', data: snap });
    r.app.tick(clock.now());
    if (until?.(r.app.state().phase) === true) return i + 1;
  }
  return to;
}

const sent = (feed: readonly FeedEntry[]) =>
  feed.flatMap((e) => (e.kind === 'outbound' ? [`${e.scenarioId}|${e.t}|${e.text}`] : []));

/** The whole flight without a restart. */
async function continuous(): Promise<string[]> {
  const clock = new ManualClock(T0);
  const r = await launch(await tempDir(), clock);
  await startOffline(r);
  fly(r, clock, 0);
  return sent(r.app.state().feed);
}
const WHOLE = await continuous();
const timeOf = (m: string) => Number(m.split('|')[1]);
const idOf = (m: string) => m.split('|')[0];

function readRecording(file: string): Recording {
  const parsed = parseJsonl(readFileSync(file, 'utf8'));
  if (parsed.kind !== 'recording') throw new Error('not a recording');
  return parsed.recording;
}
const onlyFile = (dir: string) => {
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  return join(dir, files[0] as string);
};

describe('restoring a flight (T64)', () => {
  it.each(['BOARDING', 'PUSHBACK', 'CLIMB', 'CRUISE', 'DESCENT', 'TAXI_IN'] as const)(
    'closed in %s, restarted at once: the same messages as without a restart',
    async (phase) => {
      const dir = await tempDir();
      const clock = new ManualClock(T0);
      const first = await launch(dir, clock);
      await startOffline(first);
      const next = fly(first, clock, 0, undefined, (p) => p === phase);
      expect(first.app.state().phase).toBe(phase);
      expect(first.app.canResume).toBe(true);
      first.app.dispose();

      const again = await launch(dir, clock);
      expect(again.app.state()).toMatchObject({
        session: 'idle',
        resume: {
          callsign: ofp.callsign,
          origin: ofp.origin.icao,
          destination: ofp.destination.icao,
        },
      });
      expect(await guard(() => again.app.resumeFlight())).toEqual({ ok: true, value: null });
      expect(again.app.state()).toMatchObject({ session: 'running', phase, resume: null });
      fly(again, clock, next);
      expect(sent(again.app.state().feed)).toEqual(WHOLE);
      expect(
        again.app.state().feed.filter((e) => e.kind === 'system' && e.code === 'flight_resumed'),
      ).toHaveLength(1);

      // The file holds the whole flight: a replay gives what went out live (`replay run --check`).
      const rec = readRecording(onlyFile(again.recordings));
      expect(rec.events.filter((e) => e.type === 'resume')).toHaveLength(1);
      const r = replay(rec, {
        scenarios: SCENARIOS.filter((c) => rec.header.scenarios.includes(c.id)),
      });
      expect(compareOutbound(r.recorded, r.outbound)).toEqual([]);
      expect(r.outbound).toHaveLength(WHOLE.length);
    },
  );

  it('10 min closed in CRUISE: the messages due meanwhile come at once, in order', async () => {
    // `next_leg` is due at OFF + 40 min, in the cruise: the app closes 5 min before it.
    const nextLeg = timeOf(WHOLE.find((m) => idOf(m) === 'next_leg') ?? '');
    const dir = await tempDir();
    const clock = new ManualClock(T0);
    const first = await launch(dir, clock);
    await startOffline(first);
    const next = fly(
      first,
      clock,
      0,
      undefined,
      (p) => p === 'CRUISE' && clock.now() >= nextLeg - 5 * 60_000,
    );
    expect(first.app.state().phase).toBe('CRUISE');
    first.app.dispose();
    const down = clock.now();
    const back = down + 10 * 60_000;
    clock.set(back);
    const again = await launch(dir, clock);
    await again.app.resumeFlight();
    const skip = flight.snapshots.findIndex((s, i) => i >= next && s.t >= back);
    fly(again, clock, skip);
    const feed = again.app.state().feed;
    expect(feed.filter((e) => e.kind === 'system' && e.code === 'scenario_error')).toEqual([]);
    expect(again.app.state().phase).toBe('ON_BLOCK');
    // Nothing is sent for the time the app was closed; what was due is not lost.
    const times = feed.flatMap((e) => (e.kind === 'outbound' ? [e.t] : []));
    expect(times.filter((t) => t > down && t < back)).toEqual([]);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    const due = WHOLE.filter((m) => timeOf(m) > down && timeOf(m) < back).map(idOf);
    expect(due).toEqual(['next_leg']);
    const after = sent(feed).filter((m) => timeOf(m) >= back);
    expect(after.map(idOf).slice(0, due.length)).toEqual(due);
    // Right after the restart (the first ticks), not at its old time.
    expect(timeOf(after[0] ?? '')).toBeLessThan(back + 60_000);
    const rec = readRecording(onlyFile(again.recordings));
    const r = replay(rec, {
      scenarios: SCENARIOS.filter((c) => rec.header.scenarios.includes(c.id)),
    });
    expect(compareOutbound(r.recorded, r.outbound)).toEqual([]);
  });

  it('telexes that never left the app are sent again; delivered ones are not', async () => {
    const dir = await tempDir();
    const clock = new ManualClock(T0);
    const first = await launch(dir, clock);
    await startOffline(first);
    // The pre-departure messages leave, then the network stops taking anything.
    let next = fly(first, clock, 0, undefined, (p) => p === 'PUSHBACK');
    const before = sent(first.app.state().feed).length;
    first.transports.at(-1)?.halt('network down');
    // T61: the documents are all out by pushback; the departure report (in the climb) gets stuck.
    next = fly(first, clock, next, undefined, (p) => p === 'CRUISE');
    const stuck = first.app
      .state()
      .feed.flatMap((e) => (e.kind === 'outbound' && e.delivery === 'queued' ? [e.text] : []));
    expect(stuck.length).toBeGreaterThan(0);
    expect(sent(first.app.state().feed).length).toBe(before + stuck.length);
    first.app.dispose();

    const again = await launch(dir, clock);
    await again.app.resumeFlight();
    fly(again, clock, next, next + 2);
    const t = again.transports.at(-1);
    expect(t?.sent.map((s) => s.telex.message.text)).toEqual(stuck);
    const feed = again.app.state().feed.flatMap((e) => (e.kind === 'outbound' ? [e] : []));
    expect(feed.every((e) => e.delivery === 'sent')).toBe(true);
    const rec = readRecording(onlyFile(again.recordings));
    const marks = rec.events.flatMap((e) => (e.type === 'sent' ? [e.n] : []));
    expect(new Set(marks).size).toBe(marks.length);
    expect(marks.length).toBe(rec.events.filter((e) => e.type === 'out').length);
  });

  it('a recording run differently (other scenarios) is refused; the feed and the offer stay', async () => {
    const dir = await tempDir();
    const clock = new ManualClock(T0);
    const first = await launch(dir, clock);
    await startOffline(first);
    fly(first, clock, 0, undefined, (p) => p === 'CLIMB');
    first.app.dispose();
    const file = onlyFile(join(dir, 'recordings'));
    const text = readFileSync(file, 'utf8').replace(
      /"type":"out","t":(\d+),"scenarioId":"[a-z_]+"/,
      (m) => m.replace(/"scenarioId":"[a-z_]+"/, '"scenarioId":"other"'),
    );
    writeFileSync(file, text);

    const again = await launch(dir, clock);
    const r = await guard(() => again.app.resumeFlight());
    expect(r).toMatchObject({ ok: false, error: { reason: 'resume_mismatch' } });
    expect(again.app.state()).toMatchObject({ session: 'idle', feed: [] });
    expect(again.app.state().resume).not.toBeNull();
  });

  it('discarded: not offered again, the recording stays with a stop line', async () => {
    const dir = await tempDir();
    const clock = new ManualClock(T0);
    const first = await launch(dir, clock);
    await startOffline(first);
    fly(first, clock, 0, 200);
    first.app.dispose();

    const again = await launch(dir, clock);
    expect(again.app.state().resume).not.toBeNull();
    await again.app.discardResume();
    expect(again.app.state()).toMatchObject({ session: 'idle', resume: null });
    const rec = readRecording(onlyFile(again.recordings));
    expect(rec.events.at(-1)?.type).toBe('stop');
    expect((await launch(dir, clock)).app.state().resume).toBeNull();
    expect(await guard(() => again.app.resumeFlight())).toMatchObject({
      ok: false,
      error: { reason: 'no_resume' },
    });
  });

  it('a new flight gives the lost one up', async () => {
    const dir = await tempDir();
    const clock = new ManualClock(T0);
    const first = await launch(dir, clock);
    await startOffline(first);
    fly(first, clock, 0, 200);
    first.app.dispose();
    const again = await launch(dir, clock);
    await again.app.loadOfp();
    await again.app.startFlight();
    const files = readdirSync(again.recordings).sort();
    expect(files).toHaveLength(2);
    const old = readRecording(join(again.recordings, files[0] as string));
    expect(old.events.at(-1)?.type).toBe('stop');
  });

  it('not offered: stopped, ended at ON_BLOCK, older than 24 h, or recorded before T64', async () => {
    const clock = new ManualClock(T0);
    const stopped = await tempDir();
    const a = await launch(stopped, clock);
    await startOffline(a);
    fly(a, clock, 0, 200);
    await a.app.stopFlight();
    a.app.dispose();
    expect((await launch(stopped, clock)).app.state().resume).toBeNull();

    const ended = await tempDir();
    const b = await launch(ended, clock);
    await startOffline(b);
    fly(b, clock, 0);
    await b.app.endFlight('DONE');
    b.app.dispose();
    expect((await launch(ended, clock)).app.state().resume).toBeNull();

    const old = await tempDir();
    const c = await launch(old, clock);
    await startOffline(c);
    fly(c, clock, 0, 200);
    c.app.dispose();
    const file = onlyFile(join(old, 'recordings'));
    const now = clock.now();
    utimesSync(
      file,
      new Date(now - RESUME_MAX_AGE_MS - 1000),
      new Date(now - RESUME_MAX_AGE_MS - 1000),
    );
    expect((await launch(old, clock)).app.state().resume).toBeNull();
    utimesSync(file, new Date(now), new Date(now));
    expect((await launch(old, clock)).app.state().resume).not.toBeNull();
    // A recording without `simTime` in the header was made before T64: no `sent` lines in it.
    writeFileSync(file, readFileSync(file, 'utf8').replace(/,"simTime":false/, ''));
    expect((await launch(old, clock)).app.state().resume).toBeNull();
  });

  it('"Record flights" off: a temporary recording, restored the same, deleted with the flight', async () => {
    const dir = await tempDir();
    const clock = new ManualClock(T0);
    const first = await launch(dir, clock);
    await startOffline(first, false);
    const temp = tempRecordingsDir(first.recordings);
    expect(first.app.state().feed.some((e) => e.kind === 'system' && e.code === 'recording')).toBe(
      false,
    );
    const next = fly(first, clock, 0, undefined, (p) => p === 'CLIMB');
    first.app.dispose();
    expect(existsSync(first.recordings)).toBe(false);
    const file = onlyFile(temp);

    const again = await launch(dir, clock);
    await again.app.resumeFlight();
    fly(again, clock, next);
    expect(sent(again.app.state().feed)).toEqual(WHOLE);
    await again.app.endFlight('DONE');
    await again.app.stopFlight();
    expect(existsSync(file)).toBe(false);
    expect(existsSync(first.recordings)).toBe(false);
  });

  it('a temporary flight given up is deleted', async () => {
    const dir = await tempDir();
    const clock = new ManualClock(T0);
    const first = await launch(dir, clock);
    await startOffline(first, false);
    fly(first, clock, 0, 200);
    first.app.dispose();
    const file = onlyFile(tempRecordingsDir(first.recordings));
    const again = await launch(dir, clock);
    await again.app.discardResume();
    expect(existsSync(file)).toBe(false);
  });
});
