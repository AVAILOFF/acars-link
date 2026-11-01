// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  checkSimCommand,
  DEFAULT_RESCUE_TITLES,
  distanceNm,
  generateSyntheticFlight,
  ManualClock,
  parseSimbriefOfp,
} from '@acars/core';
import { compareOutbound, parseJsonl, type Recording, replay } from '@acars/replay';
import { loadScenarios } from '@acars/scenarios';
import { MockTransport } from '@acars/transport';
import { describe, expect, it, vi } from 'vitest';
import { AppController, type TransportFactory } from '../src/main/controller.js';
import { guard } from '../src/main/errors.js';
import type { FlagsStore } from '../src/main/flags.js';
import { fileRecordings, type OpenRecording } from '../src/main/recording.js';
import { BASE_SCENARIOS, SCENARIO_LOCALES } from '../src/main/scenario-sources.js';
import { SecretStore } from '../src/main/secrets.js';
import { defaultSettings, SettingsStore } from '../src/main/settings.js';
import { SPECIAL_SCENARIOS } from '../src/main/special.js';
import { VDGS_FILE } from '../src/main/vdgs.js';
import { MESSAGES, translator } from '../src/renderer/src/i18n.js';
import type { AboutInfo, FeedEntry, SimChoice } from '../src/shared/api.js';
import {
  FakeCipher,
  FakeHttp,
  FakeTimers,
  OFP_FIXTURE,
  simbriefOk,
  socketFactory,
  tempDir,
} from './support.js';

const BASE_SCENARIOS_COMPILED = loadScenarios(BASE_SCENARIOS, SCENARIO_LOCALES);
const ofp = parseSimbriefOfp(JSON.parse(await readFile(OFP_FIXTURE, 'utf8')));
// 65 min at the gate: the whole pre-departure sequence fits, nothing is fitted to the time left.
const flight = generateSyntheticFlight({ ofp, boardingSec: 65 * 60 });
const T0 = flight.snapshots[0]?.t ?? 0;

async function setup(
  o: {
    openRecording?: OpenRecording | null;
    http?: FakeHttp;
    flags?: FlagsStore;
    vdgsDir?: string;
    onBridgeConfig?: (port: number, simulator: SimChoice) => void;
    about?: () => AboutInfo;
  } = {},
) {
  const dir = await tempDir();
  const recordings = join(dir, 'recordings');
  let revealed = 0;
  const clock = new ManualClock(T0);
  const sockets = socketFactory();
  const transports: { choice: Parameters<TransportFactory>[0]; t: MockTransport }[] = [];
  const secretsFile = join(dir, 'secrets.json');
  const app = new AppController({
    secrets: new SecretStore(secretsFile, new FakeCipher()),
    settings: new SettingsStore(join(dir, 'settings.json'), defaultSettings('en')),
    scenarioSources: BASE_SCENARIOS,
    scenarioLocales: SCENARIO_LOCALES,
    http: o.http ?? (await simbriefOk()),
    // The mock stands in for Hoppie too; the test checks which logon it was given.
    createTransport: (choice) => {
      const t = new MockTransport(clock);
      transports.push({ choice, t });
      return t;
    },
    createSocket: sockets.create,
    timers: new FakeTimers(),
    now: () => clock.now(),
    openRecording: o.openRecording === undefined ? fileRecordings(recordings) : o.openRecording,
    revealRecordings: async () => {
      revealed++;
    },
    onChange: () => {},
    ...(o.flags === undefined ? {} : { flags: o.flags }),
    ...(o.vdgsDir === undefined ? {} : { vdgsDir: o.vdgsDir }),
    ...(o.onBridgeConfig === undefined ? {} : { onBridgeConfig: o.onBridgeConfig }),
    ...(o.about === undefined ? {} : { about: o.about }),
  });
  await app.init();
  return { app, clock, sockets, transports, secretsFile, recordings, revealed: () => revealed };
}

/** Streams the synthetic flight through the fake bridge socket and the 1 Hz main loop. */
function fly(s: Awaited<ReturnType<typeof setup>>, from = 0, to = flight.snapshots.length): void {
  const socket = s.sockets.last();
  for (const snap of flight.snapshots.slice(from, to)) {
    s.clock.set(Math.max(s.clock.now(), snap.t));
    socket.frame({ type: 'telemetry', data: snap });
    s.app.tick(s.clock.now());
  }
}

async function readRecording(dir: string): Promise<Recording> {
  const files = await readdir(dir);
  expect(files).toHaveLength(1);
  const parsed = parseJsonl(await readFile(join(dir, files[0] as string), 'utf8'));
  if (parsed.kind !== 'recording') throw new Error('not a recording');
  expect(parsed.warnings).toEqual([]);
  return parsed.recording;
}

const outbound = (feed: readonly FeedEntry[]) =>
  feed.flatMap((e) => (e.kind === 'outbound' ? [e] : []));

describe('AppController', () => {
  it('sim commands go to the bridge; only failures reach the feed', async () => {
    const s = await setup();
    const socket = s.sockets.last();
    socket.hello(2, 1, ['ping']);
    const id = s.app.sendSimCommand({ command: 'ping', args: {}, scenarioId: 't', t: T0 });
    expect(socket.sent).toEqual([{ type: 'command', id, command: 'ping', args: {} }]);
    socket.frame({ type: 'ack', id, ok: true });
    expect(s.app.state().feed).toEqual([]);

    const id2 = s.app.sendSimCommand({ command: 'ping', args: {}, scenarioId: 't', t: T0 });
    socket.frame({ type: 'ack', id: id2, ok: false, error: 'unavailable', detail: 'no GSX' });
    expect(s.app.state().feed).toMatchObject([
      {
        kind: 'system',
        code: 'sim_command_failed',
        params: { command: 'ping', error: 'unavailable', detail: 'no GSX' },
      },
    ]);
    expect(s.app.state().bridge).toMatchObject({ protocol: 2, commands: ['ping'] });
  });

  it('T75: the state of the bridge process is in the app state; a restart is a feed line during a flight only', async () => {
    const s = await setup();
    expect(s.app.state().bridgeProcess).toBeNull();
    s.app.setBridgeProcess({ kind: 'port_in_use', port: 47830 });
    expect(s.app.state().bridgeProcess).toEqual({ kind: 'port_in_use', port: 47830 });
    s.app.setBridgeProcess(null);
    expect(s.app.state().bridgeProcess).toBeNull();

    const restarts = () =>
      s.app.state().feed.filter((e) => e.kind === 'system' && e.code === 'bridge_restarted');
    s.app.noteBridgeRestarted(); // no flight: nothing to tell
    expect(restarts()).toEqual([]);

    await s.app.updateSettings({ transport: 'offline' });
    await s.app.setSimbriefUsername('pilot42');
    await s.app.loadOfp();
    await s.app.startFlight();
    s.app.noteBridgeRestarted();
    expect(restarts()).toHaveLength(1);
    expect(s.app.state().session).toBe('running'); // the flight goes on
  });

  it('a new simulator or bridge port restarts the bridge (T18); other settings do not', async () => {
    const calls: [number, SimChoice][] = [];
    const { app } = await setup({ onBridgeConfig: (port, sim) => calls.push([port, sim]) });
    await app.updateSettings({ messageHints: false });
    await app.updateSettings({ simChoice: 'auto' });
    expect(calls).toEqual([]);
    await app.updateSettings({ simChoice: 'xplane' });
    await app.updateSettings({ bridgePort: 47831 });
    expect(calls).toEqual([
      [47830, 'xplane'],
      [47831, 'xplane'],
    ]);
  });

  it('needs a SimBrief username before loading the OFP', async () => {
    const { app } = await setup();
    expect(await guard(() => app.loadOfp())).toMatchObject({
      ok: false,
      error: { code: 'no_username' },
    });
    expect(app.state().session).toBe('idle');
  });

  it('loads the OFP: summary with station callsign and display profile', async () => {
    const { app } = await setup();
    await app.setSimbriefUsername('pilot42');
    const f = await app.loadOfp();
    expect(f).toMatchObject({
      callsign: ofp.callsign,
      origin: 'RCTP',
      destination: 'RJBB',
      aircraftIcao: ofp.aircraft.icao,
      station: `OPS${ofp.flightNumber ?? ofp.callsign}`,
      profileId: 'default',
      lineWidth: 24,
    });
    expect(app.state().session).toBe('ready');
    await app.updateSettings({ stationTemplate: '{airline}OPS' });
    expect(app.state().flight?.station).toBe(`${ofp.airlineIcao ?? ''}OPS`);
  });

  it('Hoppie needs a stored logon code; the code never reaches the UI state', async () => {
    const s = await setup();
    const { app } = s;
    await app.setSimbriefUsername('pilot42');
    await app.loadOfp();
    expect(await guard(() => app.startFlight())).toMatchObject({
      ok: false,
      error: { code: 'no_hoppie_code' },
    });
    expect(await guard(() => app.setHoppieCode('bad code'))).toMatchObject({ ok: false });
    expect(await app.setHoppieCode(' LOGON0123456789 ')).toMatchObject({ hoppieCodeSet: true });
    await app.startFlight();
    expect(s.transports[0]?.choice).toEqual({ kind: 'hoppie', logon: 'LOGON0123456789' });
    const visible = JSON.stringify([app.state(), await app.credentials()]);
    expect(visible).not.toContain('LOGON0123456789');
    expect(await readFile(s.secretsFile, 'utf8')).not.toContain('LOGON0123456789');
  });

  it('a whole offline flight: phases, telexes sent, ON_BLOCK → TURNAROUND, stop', async () => {
    const s = await setup();
    const { app } = s;
    await app.setSimbriefUsername('pilot42');
    await app.updateSettings({ transport: 'offline' });
    await app.loadOfp();
    s.sockets.last().hello();
    await app.startFlight();
    expect(s.transports[0]?.choice).toEqual({ kind: 'offline' });
    expect(app.state()).toMatchObject({ session: 'running', phase: 'PREFLIGHT' });
    expect(await guard(() => app.startFlight())).toMatchObject({ ok: false });
    expect(await guard(() => app.endFlight('DONE'))).toMatchObject({
      ok: false,
      error: { code: 'bad_state' },
    });

    fly(s);
    const st = app.state();
    expect(st.phase).toBe('ON_BLOCK');
    expect(st.telemetry).not.toBeNull();
    expect(st.transport).toMatchObject({ kind: 'mock', status: 'ok', pending: 0 });

    const phases = st.feed.flatMap((e) =>
      e.kind === 'system' && e.code === 'phase' ? [e.params['to']] : [],
    );
    expect(phases).toEqual([
      'BOARDING',
      'PUSHBACK',
      'TAXI_OUT',
      'TAKEOFF',
      'CLIMB',
      'CRUISE',
      'DESCENT',
      'APPROACH',
      'LANDED',
      'TAXI_IN',
      'ON_BLOCK',
    ]);
    // T49: the FMS drops INIT after landing: one reminder, right after the OOOI IN entry.
    const sys = st.feed.flatMap((e) => (e.kind === 'system' ? [e] : []));
    const inIdx = sys.findIndex((e) => e.code === 'oooi' && e.params['kind'] === 'IN');
    expect(inIdx).toBeGreaterThan(-1);
    expect(sys.filter((e) => e.code === 'flt_nbr_hint')).toHaveLength(1);
    expect(sys[inIdx + 1]).toMatchObject({
      code: 'flt_nbr_hint',
      params: { callsign: ofp.callsign },
    });
    const out = outbound(st.feed);
    expect(out.length).toBeGreaterThanOrEqual(10);
    expect(out.every((m) => m.delivery === 'sent')).toBe(true);
    expect(new Set(out.map((m) => m.to))).toEqual(new Set([ofp.callsign]));
    expect(s.transports[0]?.t.sent).toHaveLength(out.length);
    expect(st.feed.some((e) => e.kind === 'system' && e.code === 'scenario_error')).toBe(false);

    await app.endFlight('TURNAROUND');
    expect(app.state().phase).toBe('TURNAROUND');
    await app.stopFlight();
    const end = app.state();
    expect(end.session).toBe('ready');
    expect(end.feed.at(-1)).toMatchObject({ kind: 'system', code: 'flight_stopped' });
  });

  it('disabled scenarios do not run; per_session ids carry over to the next flight', async () => {
    const s = await setup();
    const { app } = s;
    await app.setSimbriefUsername('pilot42');
    await app.updateSettings({ transport: 'offline' });
    await app.loadOfp();
    const list = await app.listScenarios();
    // 15 base + 12 commands (T12) + 8 command scenarios (T44) + slot_missed (T43) + 4 live-data (T13) + 2 launches (T28) + 24 irregular (T14, T44)
    // + 1 sim (T22) + 10 special events (T29) + atis_update and vdgs_divert (T45) + emergency_mayday and emergency_pan (T47)
    // + 4 irregular (T46) + connex_list (T30) + hold_fuel_watch (T50) + dep_fire
    expect(list).toHaveLength(91);
    expect(list.every((x) => x.enabled === x.enabledByDefault)).toBe(true);
    const off = list.find((x) => x.enabled);
    if (off === undefined) throw new Error('no enabled scenario');
    await app.setScenarioEnabled(off.id, false);
    expect(await guard(() => app.setScenarioEnabled('nope', true))).toMatchObject({ ok: false });
    s.sockets.last().hello();
    await app.startFlight();
    fly(s);
    expect(outbound(app.state().feed).some((m) => m.scenarioId === off.id)).toBe(false);
  });

  it('stopping drops telexes still in the queue', async () => {
    const s = await setup();
    const { app } = s;
    await app.setSimbriefUsername('pilot42');
    await app.setHoppieCode('LOGON0123456789');
    await app.loadOfp();
    s.sockets.last().hello();
    await app.startFlight();
    const mock = s.transports[0]?.t;
    if (mock === undefined) throw new Error('no transport');
    mock.halt('invalid logon code');
    fly(s, 0, 2400);
    const queued = outbound(app.state().feed);
    expect(queued.length).toBeGreaterThan(0);
    expect(queued.every((m) => m.delivery === 'queued')).toBe(true);
    expect(app.state().transport).toMatchObject({ status: 'halted', reason: 'invalid logon code' });
    await app.stopFlight();
    expect(outbound(app.state().feed).every((m) => m.delivery === 'dropped')).toBe(true);
  });
});

describe('late start', () => {
  it('5 min before STD: one telex at the start and a late_start note, not a burst', async () => {
    const s = await setup();
    const { app } = s;
    const start = ofp.times.schedOutMs - 5 * 60_000;
    s.clock.set(start);
    await app.setSimbriefUsername('pilot42');
    await app.updateSettings({ transport: 'offline' });
    await app.loadOfp();
    s.sockets.last().hello();
    await app.startFlight();
    const late = generateSyntheticFlight({ ofp, startMs: start });
    const socket = s.sockets.last();
    for (const snap of late.snapshots.slice(0, 600)) {
      s.clock.set(Math.max(s.clock.now(), snap.t));
      socket.frame({ type: 'telemetry', data: snap });
      app.tick(s.clock.now());
    }
    const feed = app.state().feed;
    expect(feed).toContainEqual(
      expect.objectContaining({ kind: 'system', code: 'late_start', params: { min: '15' } }),
    );
    // Documents, not a burst; an irregular reaction to the delay (crew duty, T14) may come too.
    const irregular = new Set(
      BASE_SCENARIOS_COMPILED.filter((c) => c.def.category === 'irregular').map((c) => c.id),
    );
    const docs = outbound(feed).filter((m) => !irregular.has(m.scenarioId));
    expect(docs.filter((m) => m.t === start)).toEqual([]);
    expect(docs[0]?.scenarioId).toBe('crew_info');
  });

  it('on time: no late_start note', async () => {
    const s = await setup();
    await s.app.setSimbriefUsername('pilot42');
    await s.app.updateSettings({ transport: 'offline' });
    await s.app.loadOfp();
    s.sockets.last().hello();
    await s.app.startFlight();
    fly(s, 0, 60);
    expect(s.app.state().feed.some((e) => e.kind === 'system' && e.code === 'late_start')).toBe(
      false,
    );
  });
});

describe('OFP date (docs/05 "Дата OFP")', () => {
  it('a plan for yesterday runs today at its times, the feed and the recording say so', async () => {
    const s = await setup();
    const DAY = 86_400_000;
    s.clock.set(ofp.times.schedOutMs + DAY - 40 * 60_000);
    await s.app.setSimbriefUsername('pilot42');
    await s.app.updateSettings({ transport: 'offline' });
    await s.app.loadOfp();
    s.sockets.last().hello();
    await s.app.startFlight();
    expect(s.app.state().flight?.schedOutMs).toBe(ofp.times.schedOutMs + DAY);
    const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    expect(s.app.state().feed).toContainEqual(
      expect.objectContaining({
        kind: 'system',
        code: 'ofp_date',
        params: {
          date: iso(ofp.times.schedOutMs + DAY),
          planned: iso(ofp.times.schedOutMs),
        },
      }),
    );
    await s.app.stopFlight();
    const rec = await readRecording(s.recordings);
    expect(rec.header.ofp.times.schedOutMs).toBe(ofp.times.schedOutMs + DAY);
  });

  it('within 12 h of STD: no shift, no note', async () => {
    const s = await setup();
    await s.app.setSimbriefUsername('pilot42');
    await s.app.updateSettings({ transport: 'offline' });
    await s.app.loadOfp();
    s.sockets.last().hello();
    await s.app.startFlight();
    expect(s.app.state().flight?.schedOutMs).toBe(ofp.times.schedOutMs);
    expect(s.app.state().feed.some((e) => e.kind === 'system' && e.code === 'ofp_date')).toBe(
      false,
    );
  });
});

describe('flight recording (T11)', () => {
  async function offlineFlight(s: Awaited<ReturnType<typeof setup>>) {
    await s.app.setSimbriefUsername('pilot42');
    await s.app.updateSettings({ transport: 'offline' });
    await s.app.loadOfp();
    s.sockets.last().hello();
    await s.app.startFlight();
  }

  it('the app version is in the header (T77), +dev outside the installer; none unknown', async () => {
    const about = (dev: boolean) => () =>
      ({ version: '0.2.0', dev, electron: '44', chrome: '1', variant: 'public' }) as const;
    for (const [s, want] of [
      [await setup({ about: about(false) }), '0.2.0'],
      [await setup({ about: about(true) }), '0.2.0+dev'],
      [await setup(), undefined],
    ] as const) {
      await offlineFlight(s);
      await s.app.stopFlight();
      expect((await readRecording(s.recordings)).header.appVersion).toBe(want);
    }
  });

  it('records the core inputs; the replay reproduces the live telexes exactly', async () => {
    const s = await setup();
    await offlineFlight(s);
    const feed0 = s.app.state().feed;
    expect(feed0.find((e) => e.kind === 'system' && e.code === 'recording')).toMatchObject({
      params: { file: expect.stringMatching(/^\d{8}-\d{6}-SJX822\.jsonl$/) },
    });
    fly(s);
    await s.app.endFlight('DONE');
    await s.app.stopFlight();

    const rec = await readRecording(s.recordings);
    expect(rec.header).toMatchObject({
      source: 'desktop',
      seed: null,
      station: 'OPS{flight}',
      profile: { id: 'default' },
      sessionFired: [],
    });
    expect(rec.header.ofp.callsign).toBe(ofp.callsign);
    const types = rec.events.map((e) => e.type);
    expect(types[0]).toBe('start');
    expect(types.at(-1)).toBe('stop');
    expect(types.filter((t) => t === 'tick')).toHaveLength(flight.snapshots.length);
    expect(types).toContain('end');

    const live = outbound(s.app.state().feed);
    const recorded = rec.events.flatMap((e) => (e.type === 'out' ? [e] : []));
    expect(recorded.map((e) => e.text)).toEqual(live.map((m) => m.text));

    const scenarios = BASE_SCENARIOS_COMPILED.filter((c) => rec.header.scenarios.includes(c.id));
    const r = replay(rec, { scenarios });
    expect(compareOutbound(r.recorded, r.outbound)).toEqual([]);
    expect(r.finalPhase).toBe('DONE');
  });

  it('can be switched off', async () => {
    const s = await setup();
    await s.app.updateSettings({ recordFlights: false });
    await offlineFlight(s);
    fly(s, 0, 30);
    await s.app.stopFlight();
    await expect(readdir(s.recordings)).rejects.toThrow();
    expect(s.app.state().feed.some((e) => e.kind === 'system' && e.code === 'recording')).toBe(
      false,
    );
  });

  it('a recording that cannot be opened or written never stops the flight', async () => {
    const s = await setup({
      openRecording: () => {
        throw new Error('disk full');
      },
    });
    await offlineFlight(s);
    fly(s, 0, 30);
    expect(s.app.state()).toMatchObject({ session: 'running', phase: 'BOARDING' });
    expect(s.app.state().feed).toContainEqual(
      expect.objectContaining({ code: 'recording_failed', params: { error: 'disk full' } }),
    );

    let writes = 0;
    let closed = 0;
    const t = await setup({
      openRecording: () => ({
        file: 'x.jsonl',
        write: () => {
          if (++writes > 5) throw new Error('EIO');
        },
        close: () => {
          closed++;
        },
      }),
    });
    await offlineFlight(t);
    fly(t, 0, 1500); // crew_info comes 20 min into the 65 min at the gate
    await t.app.stopFlight();
    const failed = t.app
      .state()
      .feed.filter((e) => e.kind === 'system' && e.code === 'recording_failed');
    expect(failed).toHaveLength(1);
    expect(writes).toBe(6);
    expect(closed).toBe(1);
    expect(outbound(t.app.state().feed).length).toBeGreaterThan(0);
  });

  it('opens the recordings folder on request', async () => {
    const s = await setup();
    expect(await s.app.openRecordings()).toBeNull();
    expect(s.revealed()).toBe(1);
  });
});

describe('pilot telexes (T12)', () => {
  it('from the network and typed in the app reach the core; recorded and replayed', async () => {
    const s = await setup();
    const { app } = s;
    expect(await guard(() => app.sendPilotMessage('ETA'))).toMatchObject({
      ok: false,
      error: { code: 'bad_state' },
    });
    await app.setSimbriefUsername('pilot42');
    await app.updateSettings({ transport: 'offline' });
    await app.loadOfp();
    s.sockets.last().hello();
    await app.startFlight();
    const mock = s.transports[0]?.t as MockTransport;
    const half = Math.floor(flight.snapshots.length / 2); // cruise
    fly(s, 0, half);

    expect(await guard(() => app.sendPilotMessage('   '))).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    await app.sendPilotMessage('req gate');
    fly(s, half, half + 1);
    mock.deliver({ from: ofp.callsign, to: 'OPS822', type: 'telex', packet: 'DIVERT-RJOO' });
    fly(s, half + 1, half + 3); // the transport reports it on a tick, the core reads it on the next
    expect(mock.lastExpectReplyMs).toBe(10 * 60_000);
    mock.deliver({ from: ofp.callsign, to: 'OPS822', type: 'telex', packet: 'TECH' });
    fly(s, half + 3);

    const feed = app.state().feed;
    expect(feed.flatMap((e) => (e.kind === 'inbound' ? [`${e.type} ${e.text}`] : []))).toEqual([
      'app req gate',
      'telex DIVERT-RJOO',
      'telex TECH',
    ]);
    const ids = outbound(feed).map((m) => m.scenarioId);
    expect(ids).toContain('cmd_req_gate');
    expect(ids.filter((id) => id === 'cmd_divert')).toHaveLength(3); // ask, TECH arm, stand
    expect(ids).not.toContain('arrival_info');

    await app.stopFlight();
    const files = await readdir(s.recordings);
    const parsed = parseJsonl(await readFile(join(s.recordings, files[0] as string), 'utf8'));
    if (parsed.kind !== 'recording') throw new Error('not a recording');
    const rec = parsed.recording;
    const inbound = rec.events.flatMap((e) => (e.type === 'tick' ? (e.inbound ?? []) : []));
    expect(inbound.map((m) => m.text)).toEqual(['req gate', 'DIVERT-RJOO', 'TECH']);
    const r = replay(rec, {
      scenarios: BASE_SCENARIOS_COMPILED.filter((c) => rec.header.scenarios.includes(c.id)),
    });
    expect(compareOutbound(r.recorded, r.outbound)).toEqual([]);
  });
});

describe('message hints (T57)', () => {
  it('the awaited answer is in the app state; messages carry the step hint, else the scenario one', async () => {
    const s = await setup();
    const { app } = s;
    await app.setSimbriefUsername('pilot42');
    await app.updateSettings({ transport: 'offline' });
    await app.loadOfp();
    s.sockets.last().hello();
    await app.startFlight();
    const mock = s.transports[0]?.t as MockTransport;
    const half = Math.floor(flight.snapshots.length / 2); // cruise
    fly(s, 0, half);
    expect(app.state().pendingReplies).toEqual([]);
    mock.deliver({ from: ofp.callsign, to: 'OPS822', type: 'telex', packet: 'DIVERT-RJOO' });
    fly(s, half, half + 3);

    const ask = outbound(app.state().feed).find((m) => m.scenarioId === 'cmd_divert');
    expect(ask?.hint?.en).toMatch(/^OPS acknowledges your DIVERT/);
    expect(ask?.hint?.ru).toMatch(/^OPS подтверждает ваш DIVERT/);
    const [pending, ...more] = app.state().pendingReplies;
    expect(more).toEqual([]);
    expect(pending).toMatchObject({
      scenarioId: 'cmd_divert',
      messageId: ask?.id,
      station: 'OPS822',
      options: ['WX', 'TECH', 'MEDICAL', 'FUEL', 'OTHER'],
      default: 'OTHER',
      minutesLeft: 10,
    });
    expect(pending?.hints?.['TECH']).toMatchObject({
      en: 'A technical problem with the aircraft.',
      ru: 'Техническая неисправность самолёта.',
    });

    mock.deliver({ from: ofp.callsign, to: 'OPS822', type: 'telex', packet: 'TECH' });
    fly(s, half + 3, half + 300);
    expect(app.state().pendingReplies).toEqual([]);
    const after = outbound(app.state().feed).filter((m) => m.scenarioId === 'cmd_divert');
    expect(after.map((m) => m.hint?.en.split(' ').slice(0, 3).join(' '))).toEqual([
      'OPS acknowledges your',
      'Maintenance control knows',
      'The stand at',
    ]);
    // A command answer without a step hint: the scenario's.
    await app.sendPilotMessage('REQ GATE');
    fly(s, half + 300, half + 400);
    const gate = outbound(app.state().feed).find((m) => m.scenarioId === 'cmd_req_gate_divert');
    expect(gate?.hint?.en).toMatch(/^Answer to REQ GATE while you divert/);
    await app.stopFlight();
    expect(app.state().pendingReplies).toEqual([]);
  });

  it('the setting is on by default and is a plain switch', async () => {
    const { app } = await setup();
    expect((await app.getSettings()).messageHints).toBe(true);
    expect((await app.updateSettings({ messageHints: false })).messageHints).toBe(false);
    expect((await guard(() => app.updateSettings({ messageHints: 'no' as never }))).ok).toBe(false);
  });
});

describe('i18n', () => {
  it('EN and RU have the same keys and placeholders', () => {
    const { en, ru } = MESSAGES;
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      expect(holes(ru[k]), k).toEqual(holes(en[k]));
    }
  });

  it('every language: only keys of EN, the same placeholders (T85)', () => {
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [lang, dict] of Object.entries(MESSAGES)) {
      for (const [k, v] of Object.entries(dict ?? {})) {
        const original = (MESSAGES.en as Readonly<Record<string, string>>)[k];
        expect(original, `${lang} ${k}`).toBeDefined();
        expect(holes(v as string), `${lang} ${k}`).toEqual(holes(original ?? ''));
      }
    }
  });

  it('a key missing in a language shows in English, without an error (T85)', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = translator('ru', { ru: { 'tab.flight': 'Рейс' } });
    expect(t('tab.flight')).toBe('Рейс');
    expect(t('tab.help')).toBe(MESSAGES.en['tab.help']);
    expect(t('zz.unknown' as never)).toBe('zz.unknown');
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });
});

describe('live data (T13)', () => {
  const fixtures = join(import.meta.dirname, '../../../packages/data-sources/test/fixtures');
  const fx = (name: string) => readFile(join(fixtures, name), 'utf8');

  async function dataHttp(): Promise<FakeHttp> {
    const files = {
      simbrief: await readFile(OFP_FIXTURE, 'utf8'),
      metar: await fx('metar.json'),
      taf: await fx('taf.json'),
      vatsim: await fx('vatsim-data.json'),
      eonet: await fx('eonet.json'),
      overpass: await fx('overpass-stands.json'),
      thespacedevs: await fx('launches.json'),
      // T29
      'noaa-scales': await fx('noaa-scales.json'),
      ovation: await fx('ovation-aurora.json'),
      isigmet: await fx('isigmet-va.json'),
      'earthquake.usgs': await fx('usgs-4.5-day.geojson'),
      'airports.csv': await fx('ourairports-airports.csv'),
      // Reserve airports to divert to (T50): the A35K of the OFP has a runway need.
      'runways.csv': await fx('ourairports-runways.csv'),
      'date.nager.at': await fx('nager-2026-de.json'),
      'jolpi.ca': await fx('jolpica-f1-last.json'),
      'nhle.com': await fx('nhl-score.json'),
    };
    return new FakeHttp((req) => {
      const key = (Object.keys(files) as (keyof typeof files)[]).find((k) => req.url.includes(k));
      return key === undefined ? { status: 404, body: '' } : { status: 200, body: files[key] };
    });
  }

  /** Like `fly`, but lets the data service's requests settle every 60 ticks. */
  async function flyAsync(s: Awaited<ReturnType<typeof setup>>): Promise<void> {
    const socket = s.sockets.last();
    for (const [i, snap] of flight.snapshots.entries()) {
      s.clock.set(Math.max(s.clock.now(), snap.t));
      socket.frame({ type: 'telemetry', data: snap });
      s.app.tick(s.clock.now());
      if (i % 60 === 0) await new Promise((r) => setTimeout(r, 0));
    }
  }

  it('GSX VDGS (T22): stale file removed at start, arrival text after landing, gone on stop', async () => {
    const vdgsDir = join(await tempDir(), 'VGDS');
    mkdirSync(vdgsDir, { recursive: true });
    writeFileSync(join(vdgsDir, VDGS_FILE), '{"stale":true}');
    writeFileSync(join(vdgsDir, 'other_addon.json'), '{}');
    // Live data: the gate comes from the OSM stands, there is no invented one (T43).
    const s = await setup({ vdgsDir, http: await dataHttp() });
    const { app } = s;
    expect(existsSync(join(vdgsDir, VDGS_FILE))).toBe(false);
    await app.setSimbriefUsername('pilot42');
    await app.updateSettings({ transport: 'offline' });
    await app.loadOfp();
    s.sockets.last().hello();
    await app.startFlight();
    await flyAsync(s);
    const file = JSON.parse(readFileSync(join(vdgsDir, VDGS_FILE), 'utf8'));
    expect(file.messages).toMatchObject([
      { id: 'acars_vdgs_arrival', conditions: { airports: ['RJBB'] } },
    ]);
    expect(
      app.state().feed.some((e) => e.kind === 'system' && e.code === 'sim_command_failed'),
    ).toBe(false);
    await app.stopFlight();
    expect(readdirSync(vdgsDir)).toEqual(['other_addon.json']);

    // The command is in the recording, and a replay produces it again.
    const rec = await readRecording(s.recordings);
    const cmds = rec.events.filter((e) => e.type === 'cmd');
    expect(cmds).toMatchObject([
      { scenarioId: 'vdgs_arrival', command: 'vdgs', data: { airport: 'RJBB' } },
    ]);
    const again = replay(rec, { scenarios: BASE_SCENARIOS_COMPILED });
    const replayed = again.timeline.flatMap((e) => (e.kind === 'cmd' ? [e.command] : []));
    expect(replayed.map((c) => ('vdgs' in c ? c.vdgs : null))).toEqual(
      cmds.map((c) => (c.type === 'cmd' ? c.data : null)),
    );
  });

  it('smoke (T34): runway coordinates from OurAirports go to the bridge; stopping the flight takes it down', async () => {
    const simbrief = await readFile(OFP_FIXTURE, 'utf8');
    const runways = await readFile(
      join(
        import.meta.dirname,
        '../../../packages/data-sources/test/fixtures/ourairports-runways.csv',
      ),
      'utf8',
    );
    const http = new FakeHttp((req) =>
      req.url.includes('runways.csv')
        ? { status: 200, body: runways }
        : { status: 200, body: simbrief },
    );
    const s = await setup({ http });
    const { app } = s;
    await app.setSimbriefUsername('pilot42');
    await app.updateSettings({ transport: 'offline' });
    await app.loadOfp();
    const socket = s.sockets.last();
    socket.hello(2, 1, ['ping', 'smoke_start', 'smoke_stop']);
    await app.startFlight();
    const smoke = (action: 'start' | 'stop', runway: string | null) =>
      ({
        command: 'smoke',
        action,
        airport: 'RJBB',
        runway,
        scenarioId: 'dest_fire',
        t: T0,
      }) as const;

    expect(app.sendSimCommand(smoke('start', '24R'))).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(socket.sent).toMatchObject([
      { type: 'command', command: 'smoke_start', args: { lat: 34.439917, lon: 135.223083 } },
    ]);

    // A point beside the runway (dest_fire, dep_fire): RJBB 24R flies about 230 true, so 1 NM to
    // its right is north-west of the middle.
    app.sendSimCommand({ ...smoke('start', '24R'), offset: { alongNm: 0, sideNm: 1 } });
    await new Promise((r) => setTimeout(r, 0));
    const moved = socket.sent[1] as { args: { lat: number; lon: number } };
    expect(distanceNm(moved.args, { lat: 34.439917, lon: 135.223083 })).toBeCloseTo(1, 2);
    expect(moved.args.lat).toBeGreaterThan(34.439917);
    expect(moved.args.lon).toBeLessThan(135.223083);
    socket.sent.splice(1);

    // A runway the file does not have: one line in the feed, nothing sent.
    app.sendSimCommand(smoke('start', '09'));
    await new Promise((r) => setTimeout(r, 0));
    expect(socket.sent).toHaveLength(1);
    expect(
      app.state().feed.filter((e) => e.kind === 'system' && e.code === 'sim_command_failed'),
    ).toMatchObject([
      {
        code: 'sim_command_failed',
        params: { command: 'smoke', detail: 'no coordinates for RJBB RWY 09' },
      },
    ]);

    await app.stopFlight();
    expect(socket.sent.map((m) => (m as { command?: string }).command)).toEqual([
      'smoke_start',
      'smoke_stop',
    ]);
  });

  describe('rescue services (T54)', () => {
    const fixtures = join(import.meta.dirname, '../../../packages/data-sources/test/fixtures');
    const settle = async () => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    };
    const rescue = (
      level: 'full' | 'standby' | 'medical' | null,
      airport = 'RJBB',
      runway: string | null = '24R',
      windFromDeg: number | null = null,
    ) =>
      ({
        command: 'rescue',
        action: level === null ? 'stop' : 'start',
        level,
        airport,
        runway,
        windFromDeg,
        scenarioId: 'emergency_mayday',
        t: T0,
      }) as const;
    type Sent = { command?: string; args?: Record<string, unknown> };

    async function start(opts: { airports?: string } = {}) {
      const simbrief = await readFile(OFP_FIXTURE, 'utf8');
      const runways = await readFile(join(fixtures, 'ourairports-runways.csv'), 'utf8');
      const airports =
        opts.airports ?? (await readFile(join(fixtures, 'ourairports-airports.csv'), 'utf8'));
      const http = new FakeHttp((req) =>
        req.url.includes('runways.csv')
          ? { status: 200, body: runways }
          : req.url.includes('airports.csv')
            ? { status: 200, body: airports }
            : { status: 200, body: simbrief },
      );
      const s = await setup({ http });
      await s.app.setSimbriefUsername('pilot42');
      await s.app.updateSettings({ transport: 'offline' });
      await s.app.loadOfp();
      const socket = s.sockets.last();
      socket.hello(2, 1, ['ping', 'rescue_start', 'rescue_stop', 'smoke_start', 'smoke_stop']);
      await s.app.startFlight();
      const sent = () => socket.sent as Sent[];
      return { ...s, socket, sent };
    }

    it('MAYDAY: the planned runway, 8 trucks for an A35K, large non-North-American models; stop takes them down', async () => {
      const { app, sent } = await start();
      app.sendSimCommand(rescue('full'));
      await settle();
      const [cmd] = sent();
      expect(cmd?.command).toBe('rescue_start');
      const a = cmd?.args as Record<string, number | string>;
      expect(a['level']).toBe('full');
      // RJBB 24R: its threshold, about 230° true, about 4000 m.
      expect(a['thrLat']).toBeCloseTo(34.45133, 4);
      expect(a['thrLon']).toBeCloseTo(135.24001, 4);
      expect(a['hdg']).toBeCloseTo(230.6, 0);
      expect(a['lengthM']).toBeGreaterThan(3900);
      expect(String(a['fire']).split('|')).toEqual(
        Array.from({ length: 4 }, () => ['ASO_Firetruck02', 'Truck Fire Airport Medium']).flat(),
      );
      expect(a['medic']).toBe('');
      expect(a['side']).toBe('right'); // no wind given
      expect(a['fireFlip']).toBe('0|1|0|1|0|1|0|1'); // Truck Fire Airport Medium is drawn reversed
      expect(checkSimCommand('rescue_start', a)).toBeNull();

      await app.stopFlight();
      expect(sent().map((m) => m.command)).toEqual(['rescue_start', 'rescue_stop']);
    });

    it('PAN, then MAYDAY: standby then full; a lower level later changes nothing; MEDICAL adds the ambulance', async () => {
      const { app, sent } = await start();
      app.sendSimCommand(rescue('standby'));
      await settle();
      app.sendSimCommand(rescue('full'));
      await settle();
      app.sendSimCommand(rescue('standby'));
      await settle();
      app.sendSimCommand(rescue('medical'));
      await settle();
      expect(sent().map((m) => m.args?.['level'])).toEqual(['standby', 'full', 'full']);
      expect(sent()[2]?.args?.['medic']).toBe('Van Asia High Roof Medic Japan');
      expect(sent()[1]?.args?.['medic']).toBe('');
    });

    it('a diversion airport without a planned runway: its longest; not large in North America → city trucks', async () => {
      const { app, sent } = await start({
        airports: '"id","ident","type"\n1,"KSFO","medium_airport"',
      });
      app.sendSimCommand(rescue('medical', 'KSFO', null));
      await settle();
      expect(sent()[0]?.args).toMatchObject({
        level: 'medical',
        fire: '',
        medic: 'Truck Utility NorthAm Medic',
      });
      app.sendSimCommand(rescue('full', 'KSFO', null));
      await settle();
      const a = sent()[1]?.args as Record<string, number | string>;
      expect(a['fire']).toBe(
        'Truck Fire Long 02|Microsoft_Truck_Fire_Long|Truck Fire Long 02|Microsoft_Truck_Fire_Long|Truck Fire Long 02|Microsoft_Truck_Fire_Long|Truck Fire Long 02|Microsoft_Truck_Fire_Long',
      );
      expect(a['medic']).toBe('Truck Utility NorthAm Medic');
      expect(a['hdg']).toBeCloseTo(118, -1); // 10L, the longest of KSFO in the file
    });

    it('without a planned runway: the longest one, landing into the METAR wind', async () => {
      const { app, sent } = await start();
      app.sendSimCommand(rescue('full', 'KSFO', null, 290));
      await settle();
      expect(sent()[0]?.args?.['hdg']).toBeCloseTo(298, -1); // 28R, the other end of 10L
      expect(sent()[0]?.args?.['side']).toBe('left'); // wind from 290, 8° left of course 298: upwind is left
    });

    it('no runway coordinates: a line in the feed; switched off: nothing at all; titles from the settings', async () => {
      const { app, sent } = await start();
      app.sendSimCommand(rescue('full', 'ZZZZ', null));
      await settle();
      expect(sent()).toEqual([]);
      expect(
        app.state().feed.filter((e) => e.kind === 'system' && e.code === 'sim_command_failed'),
      ).toMatchObject([
        { params: { command: 'rescue', detail: 'no runway coordinates for ZZZZ' } },
      ]);

      await app.updateSettings({
        rescueTitles: { ...DEFAULT_RESCUE_TITLES, fireLarge: ['FSDT_Firetruck_Panther_6x6_red'] },
      });
      app.sendSimCommand(rescue('standby'));
      await settle();
      expect(String(sent()[0]?.args?.['fire']).split('|')).toEqual(
        Array.from({ length: 8 }, () => 'FSDT_Firetruck_Panther_6x6_red'),
      );

      await app.updateSettings({ rescue: false });
      app.sendSimCommand(rescue('full'));
      await settle();
      expect(sent()).toHaveLength(1);
    });

    it('X-Plane (T18): no rescue command and no line in the feed', async () => {
      const { app, sent } = await start();
      await app.updateSettings({ simChoice: 'xplane' });
      app.sendSimCommand(rescue('full'));
      await settle();
      expect(sent()).toEqual([]);
      expect(
        app.state().feed.filter((e) => e.kind === 'system' && e.code === 'sim_command_failed'),
      ).toEqual([]);
    });

    it('"Automatic" (T59): rescue follows the sim the bridge reports, not the setting', async () => {
      const { app, sent, socket } = await start();
      expect((await app.getSettings()).simChoice).toBe('auto');
      const status = (source: string) =>
        socket.frame({
          type: 'status',
          sim: 'connected',
          running: true,
          paused: false,
          simRate: 1,
          source,
        });
      const changes = () =>
        app.state().feed.filter((e) => e.kind === 'system' && e.code === 'sim_changed');
      status('xplane');
      expect(app.state().bridge.source).toBe('xplane');
      app.sendSimCommand(rescue('full'));
      await settle();
      expect(sent()).toEqual([]);

      status('simconnect');
      expect(app.state().bridge.source).toBe('msfs');
      app.sendSimCommand(rescue('full'));
      await settle();
      expect(sent().map((m) => m.command)).toEqual(['rescue_start']);
      // The flight goes on; the change is one line in the feed (decision of 2026-10-23).
      expect(changes()).toMatchObject([{ params: { from: 'X-Plane 12', to: 'MSFS' } }]);
      expect(app.state().session).toBe('running');

      // Not connected: no source; the same sim again later is no new line.
      socket.frame({
        type: 'status',
        sim: 'connecting',
        running: false,
        paused: false,
        simRate: 1,
      });
      expect(app.state().bridge.source).toBeNull();
      status('simconnect');
      expect(changes()).toHaveLength(1);
    });

    it('settings: on by default, titles checked', async () => {
      const { app } = await start();
      const s = await app.getSettings();
      expect(s.rescue).toBe(true);
      expect(s.rescueTitles).toEqual(DEFAULT_RESCUE_TITLES);
      await expect(
        app.updateSettings({ rescueTitles: { ...DEFAULT_RESCUE_TITLES, fire: ['A|B'] } }),
      ).rejects.toThrow(/rescueTitles/);
      await expect(
        app.updateSettings({ rescueTitles: { ...DEFAULT_RESCUE_TITLES, fire: [' A'] } }),
      ).rejects.toThrow(/rescueTitles/);
      const { fire: _, ...missing } = DEFAULT_RESCUE_TITLES;
      await expect(
        app.updateSettings({ rescueTitles: missing as typeof DEFAULT_RESCUE_TITLES }),
      ).rejects.toThrow(/rescueTitles/);
    });
  });

  // Two whole flights through the controller and a replay: up to 10 s with the whole suite running
  // (T76); one flight cannot show both "off" and "on".
  it('data link (T31): off by default; on, messages are delayed, the stations are recorded and replay the same', async () => {
    const plain = await setup({ http: await dataHttp() });
    await plain.app.setSimbriefUsername('pilot42');
    await plain.app.updateSettings({ transport: 'offline' });
    await plain.app.loadOfp();
    plain.sockets.last().hello();
    await plain.app.startFlight();
    await flyAsync(plain);
    await plain.app.endFlight('DONE');
    await plain.app.stopFlight();
    const recPlain = await readRecording(plain.recordings);
    expect(recPlain.header.datalink).toBeUndefined();
    expect(recPlain.events.some((e) => e.type === 'tick' && e.data?.vhf !== undefined)).toBe(false);

    const http = await dataHttp();
    const s = await setup({ http });
    await s.app.setSimbriefUsername('pilot42');
    await s.app.updateSettings({ transport: 'offline', xatc: false, datalink: true });
    await s.app.loadOfp();
    s.sockets.last().hello();
    await s.app.startFlight();
    await flyAsync(s);
    await s.app.endFlight('DONE');
    await s.app.stopFlight();

    const rec = await readRecording(s.recordings);
    expect(rec.header.datalink).toEqual({ satcom: true });
    const vhf = rec.events.flatMap((e) => (e.type === 'tick' && e.data?.vhf ? e.data.vhf : []));
    expect(vhf.map((v) => v.icao)).toEqual(['RJBB']);
    const outs = rec.events.filter((e) => e.type === 'out');
    expect(outs.length).toBeGreaterThan(0);
    const r = replay(rec, {
      scenarios: BASE_SCENARIOS_COMPILED.filter((c) => rec.header.scenarios.includes(c.id)),
    });
    expect(compareOutbound(r.recorded, r.outbound)).toEqual([]);
    // Every message went through a link, so none is stamped before its scenario could start.
    expect(r.outbound.every((m) => m.link !== undefined)).toBe(true);
  });

  it('data link window (T32): the link state in the app state; the ICAO hex and the text option are recorded', async () => {
    const s = await setup({ http: await dataHttp() });
    await s.app.setSimbriefUsername('pilot42');
    await s.app.updateSettings({
      transport: 'offline',
      datalink: true,
      aircraftIcaoHex: '4249ea',
      datalinkHeaderInText: true,
    });
    await s.app.loadOfp();
    s.sockets.last().hello();
    expect(s.app.state().link).toBeNull();
    await s.app.startFlight();
    expect(s.app.state().link).toMatchObject({ kind: null, held: 0, inFlight: 0, last: null });
    await flyAsync(s);
    const link = s.app.state().link;
    expect(link?.last).not.toBeNull();
    await s.app.endFlight('DONE');
    await s.app.stopFlight();
    expect(s.app.state().link).toBeNull();

    const rec = await readRecording(s.recordings);
    expect(rec.header.datalink).toEqual({ satcom: true, icaoHex: '4249EA', headerInText: true });
    const r = replay(rec, {
      scenarios: BASE_SCENARIOS_COMPILED.filter((c) => rec.header.scenarios.includes(c.id)),
    });
    expect(compareOutbound(r.recorded, r.outbound)).toEqual([]);
    // On SATCOM with a known GES code the text starts with the header (the sample format).
    const withHeader = r.outbound.filter((m) => m.message.text.startsWith('AES:4249EA GES:'));
    expect(withHeader.length).toBeGreaterThan(0);
  });

  it('fetches after the OFP loads, feeds the core, is recorded and replays the same', async () => {
    const http = await dataHttp();
    const s = await setup({ http });
    await s.app.setSimbriefUsername('pilot42');
    await s.app.updateSettings({ transport: 'offline', xatc: false });
    await s.app.loadOfp();
    s.sockets.last().hello();
    await s.app.startFlight();
    await flyAsync(s);
    await s.app.endFlight('DONE');
    await s.app.stopFlight();

    const urls = http.requests.map((r) => r.url);
    expect(
      urls.some((u) => u.includes('aviationweather.gov/api/data/metar?ids=RCTP,RJBB,RJGG')),
    ).toBe(true);
    expect(urls.some((u) => u.startsWith('https://data.vatsim.net/'))).toBe(true);
    expect(urls.some((u) => u.startsWith('https://eonet.gsfc.nasa.gov/'))).toBe(true);
    expect(urls.some((u) => u.startsWith('https://overpass-api.de/'))).toBe(true);
    expect(urls.some((u) => u.startsWith('https://ll.thespacedevs.com/2.3.0/launches/'))).toBe(
      true,
    );
    // T29: all three groups are on by default.
    for (const host of [
      'services.swpc.noaa.gov',
      'aviationweather.gov/api/data/isigmet',
      'earthquake.usgs.gov',
      'ourairports-data/airports.csv',
      'date.nager.at/api/v3/PublicHolidays/2026/JP',
      'api.jolpi.ca',
      'api-web.nhle.com/v1/score/',
    ]) {
      expect(
        urls.some((u) => u.includes(host)),
        host,
      ).toBe(true);
    }
    expect(
      http.requests
        .filter((r) => !r.url.includes('simbrief'))
        .every((r) => r.headers?.['User-Agent']?.startsWith('ACARS-Link/')),
    ).toBe(true);

    const feed = s.app.state().feed;
    const out = outbound(feed);
    const text = (id: string) => out.find((m) => m.scenarioId === id)?.text ?? '';
    // The fixtures' RJBB METAR (live) instead of the OFP one.
    expect(text('dest_weather_live')).toMatch(/RJBB \d{6}Z/);
    expect(out.some((m) => m.scenarioId === 'dest_weather')).toBe(false);
    // A gate from the OSM fixture (refs 2, 5, 11, 12, 13, 41).
    const gate = /EXPECTED (?:GATE|STAND) (\w+)/.exec(text('gate_assignment'))?.[1];
    expect(['2', '5', '11', '12', '13', '41']).toContain(gate);
    expect(feed.some((e) => e.kind === 'system' && e.code === 'data_failed')).toBe(false);

    const rec = await readRecording(s.recordings);
    expect(rec.header.dataWaitMs).toBe(60_000);
    const data = rec.events.flatMap((e) =>
      e.type === 'tick' && e.data !== undefined ? [e.data] : [],
    );
    expect(data.some((d) => d.stands?.icao === 'RJBB')).toBe(true);
    expect(data.some((d) => d.wx?.['RJBB'] != null)).toBe(true);
    expect(data.some((d) => (d.launches?.length ?? 0) > 0)).toBe(true);
    const r = replay(rec, {
      scenarios: BASE_SCENARIOS_COMPILED.filter((c) => rec.header.scenarios.includes(c.id)),
    });
    expect(compareOutbound(r.recorded, r.outbound)).toEqual([]);
  });

  it('a failing source is one note in the feed, the flight goes on with the OFP', async () => {
    const ok = await dataHttp();
    const http = new FakeHttp((req) =>
      req.url.includes('aviationweather.gov/api/data/metar') ||
      req.url.includes('aviationweather.gov/api/data/taf')
        ? { status: 503, body: '' }
        : (ok.respond(req) as { status: number; body: string }),
    );
    const s = await setup({ http });
    await s.app.setSimbriefUsername('pilot42');
    await s.app.updateSettings({ transport: 'offline', xatc: false });
    await s.app.loadOfp();
    s.sockets.last().hello();
    await s.app.startFlight();
    await flyAsync(s);
    const feed = s.app.state().feed;
    const notes = feed.filter((e) => e.kind === 'system' && e.code === 'data_failed');
    expect(notes).toEqual([
      expect.objectContaining({
        params: { source: 'METAR/TAF (aviationweather.gov)', error: 'METAR: HTTP 503' },
      }),
    ]);
    expect(outbound(feed).some((m) => m.scenarioId === 'dest_weather')).toBe(true);
  });

  it('special-event groups off (T29): their sources are not asked, their scenarios not run', async () => {
    const http = await dataHttp();
    const s = await setup({ http });
    await s.app.setSimbriefUsername('pilot42');
    await s.app.updateSettings({
      transport: 'offline',
      specialSport: false,
      specialAviation: false,
      specialOther: false,
    });
    await s.app.loadOfp();
    s.sockets.last().hello();
    await s.app.startFlight();
    await flyAsync(s);
    await s.app.endFlight('DONE');
    await s.app.stopFlight();
    const urls = http.requests.map((r) => r.url);
    for (const host of [
      'swpc.noaa.gov',
      'isigmet',
      'usgs',
      // (airports.csv is still asked once for drone_activity, T38)
      'nager',
      'jolpi',
      'nhle',
    ]) {
      expect(
        urls.some((u) => u.includes(host)),
        host,
      ).toBe(false);
    }
    const rec = await readRecording(s.recordings);
    for (const id of SPECIAL_SCENARIOS.aviation) expect(rec.header.scenarios).not.toContain(id);
    expect(rec.header.scenarios).not.toContain('f1_result');
    expect(rec.header.scenarios).not.toContain('holiday_dest');
  });

  it('switched off: nothing but SimBrief is asked', async () => {
    const http = await dataHttp();
    const s = await setup({ http });
    await s.app.setSimbriefUsername('pilot42');
    await s.app.updateSettings({ transport: 'offline', liveData: false });
    await s.app.loadOfp();
    s.sockets.last().hello();
    await s.app.startFlight();
    await flyAsync(s);
    expect(http.requests.every((r) => r.url.includes('simbrief'))).toBe(true);
    const rec = await readRecording(s.recordings);
    expect(rec.header.dataWaitMs).toBeUndefined();
  });
});

describe('airline memory (T14)', () => {
  it('flags of a flight go to the next one; recorded; can be cleared', async () => {
    const dir = await tempDir();
    const { FlagsStore } = await import('../src/main/flags.js');
    const store = new FlagsStore(join(dir, 'airline-memory.json'));
    await store.set({
      mel_item: '49-11-01 APU INOP',
      mel_reg: ofp.aircraft.reg,
      mel_date: ofp.times.schedOutMs - 86_400_000,
    });
    const s = await setup({ flags: store });
    await s.app.setSimbriefUsername('pilot42');
    await s.app.updateSettings({ transport: 'offline', liveData: false });
    await s.app.loadOfp();
    s.sockets.last().hello();
    expect(s.app.state().memory).toEqual(['mel_date', 'mel_item', 'mel_reg']);
    await s.app.startFlight();
    expect(await guard(() => s.app.clearMemory())).toMatchObject({
      ok: false,
      error: { code: 'bad_state' },
    });
    fly(s);
    await s.app.endFlight('DONE');
    await s.app.stopFlight();
    const feed = s.app.state().feed;
    expect(feed).toContainEqual(
      expect.objectContaining({ code: 'memory', params: { names: 'mel_date, mel_item, mel_reg' } }),
    );
    // mel_carry_over closed the item after arrival: nothing left.
    const texts = outbound(feed).filter((m) => m.scenarioId === 'mel_carry_over');
    expect(texts.map((m) => m.text).join(' ')).toContain('MEL ITEM CLOSED');
    expect(await store.get()).toEqual({});
    expect(s.app.state().memory).toEqual([]);
    const rec = await readRecording(s.recordings);
    expect(rec.header.flags).toMatchObject({ mel_item: '49-11-01 APU INOP' });

    await store.set({ x: 1 });
    const t = await setup({ flags: store });
    expect(t.app.state().memory).toEqual(['x']);
    await t.app.clearMemory();
    expect(await store.get()).toEqual({});
  });
});

describe('irregular events by hand', () => {
  async function ready() {
    const s = await setup();
    await s.app.setSimbriefUsername('pilot42');
    await s.app.updateSettings({ transport: 'offline', liveData: false });
    await s.app.loadOfp();
    s.sockets.last().hello();
    return s;
  }

  it('a chance in percent replaces the file one for the next flight', async () => {
    const s = await ready();
    const info = (await s.app.listScenarios()).find((x) => x.id === 'dg_notoc');
    expect(info).toMatchObject({
      defaultChance: 6,
      chance: null,
      titleText: { en: 'Dangerous goods (NOTOC)', ru: 'Опасный груз (NOTOC)' },
      description: { en: expect.stringContaining('ACK'), ru: expect.stringContaining('ACK') },
    });
    const base = (await s.app.listScenarios()).find((x) => x.id === 'crew_info');
    expect(base).toMatchObject({
      titleText: { en: 'Crew information', ru: 'Информация об экипаже' },
      description: { en: 'Crew names and cabin crew head count.', ru: expect.any(String) },
    });
    const list = await s.app.setScenarioChance('dg_notoc', 100);
    expect(list.find((x) => x.id === 'dg_notoc')).toMatchObject({ chance: 100 });
    for (const bad of [
      ['crew_info', 50],
      ['dg_notoc', 'x'],
      ['dg_notoc', 120],
      ['ghost', 5],
    ] as const) {
      expect(await guard(() => s.app.setScenarioChance(bad[0], bad[1]))).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      });
    }
    await s.app.startFlight();
    fly(s);
    expect(outbound(s.app.state().feed).some((m) => m.scenarioId === 'dg_notoc')).toBe(true);
    await s.app.stopFlight();
    // The recording keeps the chance: the replay sends the same.
    const rec = await readRecording(s.recordings);
    // drone_activity: the destination country is unknown here (live data off) → the `*` row.
    expect(rec.header.probabilities).toEqual({ dg_notoc: 1, drone_activity: 0.009 });
    const r = replay(rec, {
      scenarios: BASE_SCENARIOS_COMPILED.filter((c) => rec.header.scenarios.includes(c.id)),
    });
    expect(compareOutbound(r.recorded, r.outbound)).toEqual([]);
    // 0 % switches it off without disabling it.
    const t = await ready();
    await t.app.setScenarioChance('dg_notoc', 0);
    await t.app.startFlight();
    fly(t);
    const second = outbound(t.app.state().feed);
    expect(second.length).toBeGreaterThan(0);
    expect(second.some((m) => m.scenarioId === 'dg_notoc')).toBe(false);
  });

  describe('drone_activity chance by destination country (T38)', () => {
    const fixtures = join(import.meta.dirname, '../../../packages/data-sources/test/fixtures');

    /** Simbrief plus OurAirports (RJBB = JP); every other source answers 404. */
    async function countryHttp(): Promise<FakeHttp> {
      const simbrief = await readFile(OFP_FIXTURE, 'utf8');
      const csv = await readFile(join(fixtures, 'ourairports-airports.csv'), 'utf8');
      return new FakeHttp((req) =>
        req.url.includes('airports.csv')
          ? { status: 200, body: csv }
          : req.url.includes('simbrief')
            ? { status: 200, body: simbrief }
            : { status: 404, body: '' },
      );
    }

    async function started(o: {
      liveData: boolean;
      droneRisk?: Record<string, number>;
      pct?: number;
    }) {
      const s = await setup({ http: await countryHttp() });
      await s.app.setSimbriefUsername('pilot42');
      await s.app.updateSettings({
        transport: 'offline',
        liveData: o.liveData,
        ...(o.droneRisk === undefined ? {} : { droneRisk: o.droneRisk }),
      });
      if (o.pct !== undefined) await s.app.setScenarioChance('drone_activity', o.pct);
      await s.app.loadOfp();
      s.sockets.last().hello();
      await s.app.startFlight();
      await s.app.stopFlight();
      return { s, rec: await readRecording(s.recordings) };
    }

    const p = (rec: Recording) => rec.header.probabilities?.['drone_activity'];

    it('the built-in table: JP is level D (×0.3 → 0.9 %); unknown country → the same `*`', async () => {
      const info = (await (await setup()).app.listScenarios()).find(
        (x) => x.id === 'drone_activity',
      );
      expect(info?.defaultChance).toBe(3);
      expect(info?.droneRiskDefault).toMatchObject({ RU: 5, DE: 2, US: 1, '*': 0.3 });
      expect(p((await started({ liveData: true })).rec)).toBeCloseTo(0.009, 10);
      expect(p((await started({ liveData: false })).rec)).toBeCloseTo(0.009, 10);
    });

    it('the user table replaces the built-in one; a manual percent goes through the factor', async () => {
      const own = { JP: 20, '*': 3 };
      expect(p((await started({ liveData: true, droneRisk: own })).rec)).toBeCloseTo(0.6, 10);
      // country unknown (live data off) → `*`
      expect(p((await started({ liveData: false, droneRisk: own })).rec)).toBeCloseTo(0.09, 10);
      expect(p((await started({ liveData: true, droneRisk: own, pct: 10 })).rec)).toBe(1);
      expect(p((await started({ liveData: true, droneRisk: { JP: 1 }, pct: 10 })).rec)).toBeCloseTo(
        0.1,
        10,
      );
      // other scenarios are not touched
      const { rec } = await started({ liveData: true, droneRisk: own });
      expect(Object.keys(rec.header.probabilities ?? {})).toEqual(['drone_activity']);
    });

    it('the recording keeps the chance; replay applies it, and a changed header changes the replay', async () => {
      const { s, rec } = await (async () => {
        const s = await setup({ http: await countryHttp() });
        await s.app.setSimbriefUsername('pilot42');
        await s.app.updateSettings({ transport: 'offline', droneRisk: { JP: 100 } });
        await s.app.loadOfp();
        s.sockets.last().hello();
        await s.app.startFlight();
        fly(s);
        await s.app.stopFlight();
        return { s, rec: await readRecording(s.recordings) };
      })();
      expect(p(rec)).toBe(1);
      const sent = outbound(s.app.state().feed).filter((m) => m.scenarioId === 'drone_activity');
      expect(sent.length).toBeGreaterThan(0);
      const scenarios = BASE_SCENARIOS_COMPILED.filter((c) => rec.header.scenarios.includes(c.id));
      const r = replay(rec, { scenarios });
      expect(compareOutbound(r.recorded, r.outbound)).toEqual([]);
      const off = replay(
        { ...rec, header: { ...rec.header, probabilities: { drone_activity: 0 } } },
        { scenarios },
      );
      expect(off.outbound.some((m) => m.scenarioId === 'drone_activity')).toBe(false);
    });
  });

  it('run now: starts at once or tells why not; recorded and replayed', async () => {
    const s = await ready();
    expect(s.app.state().irregular).toEqual([]);
    expect(await guard(() => s.app.forceScenario('vip_onboard'))).toMatchObject({
      ok: false,
      error: { code: 'bad_state' },
    });
    await s.app.startFlight();
    const list = s.app.state().irregular;
    expect(list.length).toBe(34);
    expect(list.find((x) => x.id === 'vip_onboard')?.title).toMatchObject({
      en: 'VIP on board',
      ru: 'VIP на борту',
    });
    expect(await guard(() => s.app.forceScenario('crew_info'))).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    fly(s, 0, 60); // boarding
    await s.app.forceScenario('vip_onboard');
    await s.app.forceScenario('medical_onboard'); // cruise only
    fly(s, 60, 62);
    const feed = s.app.state().feed;
    expect(feed).toContainEqual(
      expect.objectContaining({
        code: 'forced_started',
        params: { id: 'vip_onboard', detail: '' },
      }),
    );
    expect(feed).toContainEqual(
      expect.objectContaining({
        code: 'forced_conditions',
        params: expect.objectContaining({ id: 'medical_onboard' }),
      }),
    );
    expect(outbound(feed).some((m) => m.scenarioId === 'vip_onboard')).toBe(true);
    fly(s, 62);
    await s.app.stopFlight();
    const rec = await readRecording(s.recordings);
    const forced = rec.events.flatMap((e) => (e.type === 'tick' ? (e.force ?? []) : []));
    expect(forced).toEqual(['vip_onboard', 'medical_onboard']);
    const r = replay(rec, {
      scenarios: BASE_SCENARIOS_COMPILED.filter((c) => rec.header.scenarios.includes(c.id)),
    });
    expect(compareOutbound(r.recorded, r.outbound)).toEqual([]);
  });
});

describe('gap between messages', () => {
  it('one airline telex per minute by default; recorded and replayed the same', async () => {
    const s = await setup();
    await s.app.setSimbriefUsername('pilot42');
    await s.app.updateSettings({ transport: 'offline', liveData: false });
    await s.app.loadOfp();
    s.sockets.last().hello();
    await s.app.startFlight();
    fly(s);
    await s.app.stopFlight();
    const t = outbound(s.app.state().feed).map((m) => m.t);
    expect(t.length).toBeGreaterThan(5);
    for (let i = 1; i < t.length; i++) {
      expect((t[i] as number) - (t[i - 1] as number)).toBeGreaterThanOrEqual(60_000);
    }
    const rec = await readRecording(s.recordings);
    expect(rec.header.minGapMs).toBe(60_000);
    const r = replay(rec, {
      scenarios: BASE_SCENARIOS_COMPILED.filter((c) => rec.header.scenarios.includes(c.id)),
    });
    expect(compareOutbound(r.recorded, r.outbound)).toEqual([]);
  });

  it('0 sends at once', async () => {
    const s = await setup();
    await s.app.setSimbriefUsername('pilot42');
    await s.app.updateSettings({ transport: 'offline', liveData: false, messageGapSec: 0 });
    await s.app.loadOfp();
    s.sockets.last().hello();
    await s.app.startFlight();
    fly(s);
    expect((await readRecordingOrNull(s)).header.minGapMs).toBeUndefined();
  });

  it('next leg (T53): version 2 and the hub of the settings in the header, replay the same', async () => {
    const s = await setup();
    await s.app.setSimbriefUsername('pilot42');
    await s.app.updateSettings({ transport: 'offline', liveData: false, hubIcao: 'rjbb' });
    await s.app.loadOfp();
    s.sockets.last().hello();
    await s.app.startFlight();
    fly(s);
    const rec = await readRecordingOrNull(s);
    expect(rec.header.nextLegVersion).toBe(3);
    expect(rec.header.hub).toBe('RJBB');
    const r = replay(rec, {
      scenarios: BASE_SCENARIOS_COMPILED.filter((c) => rec.header.scenarios.includes(c.id)),
    });
    expect(compareOutbound(r.recorded, r.outbound)).toEqual([]);
  });
});

describe('turnaround setting', () => {
  it('off: next leg, aircraft change and welcome/turnaround are not in the flight', async () => {
    const s = await setup();
    await s.app.setSimbriefUsername('pilot42');
    await s.app.updateSettings({ transport: 'offline', liveData: false, turnaround: false });
    await s.app.loadOfp();
    s.sockets.last().hello();
    await s.app.startFlight();
    fly(s);
    const ids = (await readRecordingOrNull(s)).header.scenarios;
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ['next_leg', 'aircraft_change', 'welcome_turnaround']) {
      expect(ids).not.toContain(id);
    }
  });

  it('on (default): they are there', async () => {
    const s = await setup();
    await s.app.setSimbriefUsername('pilot42');
    await s.app.updateSettings({ transport: 'offline', liveData: false });
    await s.app.loadOfp();
    s.sockets.last().hello();
    await s.app.startFlight();
    fly(s);
    expect((await readRecordingOrNull(s)).header.scenarios).toContain('next_leg');
  });
});

async function readRecordingOrNull(s: Awaited<ReturnType<typeof setup>>) {
  await s.app.stopFlight();
  return readRecording(s.recordings);
}

describe('XATC station (T23)', () => {
  // Two rectangular FIRs across the RCTP → RJBB route, in the VATSpy formats.
  const box = (id: string, w: number, s: number, e: number, n: number) => ({
    type: 'Feature',
    properties: { id, oceanic: '0', label_lon: '0', label_lat: '0', region: 'APAC', division: 'X' },
    geometry: {
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [w, s],
            [e, s],
            [e, n],
            [w, n],
            [w, s],
          ],
        ],
      ],
    },
  });
  const geojson = JSON.stringify({
    type: 'FeatureCollection',
    features: [box('RCAA', 115, 18, 125.5, 30), box('RJJJ', 125.5, 20, 150, 45)],
  });
  const dat = '[FIRs]\nRCAA|Taipei||RCAA\nRJJJ|Fukuoka||RJJJ\n[UIRs]\n';

  async function xatcHttp(): Promise<FakeHttp> {
    const simbrief = await readFile(OFP_FIXTURE, 'utf8');
    return new FakeHttp((req) => {
      if (req.url.includes('simbrief')) return { status: 200, body: simbrief };
      if (req.url.endsWith('Boundaries.geojson')) return { status: 200, body: geojson };
      if (req.url.endsWith('VATSpy.dat')) return { status: 200, body: dat };
      return { status: 404, body: '' };
    });
  }

  it('polls the FIR station, answers the logon by CPDLC, hands over; recorded and replayed', async () => {
    const http = await xatcHttp();
    const s = await setup({ http });
    await s.app.setSimbriefUsername('pilot42');
    await s.app.updateSettings({ transport: 'offline', xatc: true });
    await s.app.loadOfp();
    s.sockets.last().hello();
    await s.app.startFlight();
    const mock = s.transports[0]?.t as MockTransport;
    const socket = s.sockets.last();
    // Lets the data service's requests settle now and then.
    const step = async (from: number, to: number) => {
      for (const [i, snap] of flight.snapshots.slice(from, to).entries()) {
        s.clock.set(Math.max(s.clock.now(), snap.t));
        socket.frame({ type: 'telemetry', data: snap });
        s.app.tick(s.clock.now());
        if (i % 60 === 0) await new Promise((r) => setTimeout(r, 0));
      }
    };
    await step(0, 2);
    await step(2, 5);
    expect(s.app.state().atc).toEqual({ station: 'XCAA', connected: null, dcl: 'XCTP' });
    expect(mock.listening).toEqual(['XCAA', 'XCTP']);

    mock.deliver({
      from: ofp.callsign,
      to: 'XCAA',
      type: 'cpdlc',
      packet: '/data2/0//Y/REQUEST LOGON',
    });
    await step(5, 8);
    expect(s.app.state().atc).toEqual({ station: 'XCAA', connected: 'XCAA', dcl: 'XCTP' });
    const sent = mock.sent.filter((m) => m.telex.cpdlc !== undefined);
    expect(sent.map((m) => [m.telex.from, m.telex.cpdlc, m.telex.message.text])).toEqual([
      ['XCAA', { min: 1, mrn: 0, ra: 'NE' }, 'LOGON ACCEPTED'],
      ['XCAA', { min: 2, mrn: null, ra: 'NE' }, 'CURRENT ATC UNIT@_@XCAA@_@TAIPEI CTL'],
    ]);

    const crossing = flight.snapshots.findIndex((x) => x.lon >= 125.5);
    await step(8, crossing + 2);
    expect(mock.listening).toEqual(['XCAA', 'XJJJ']);
    expect(mock.lastExpectReplyMs).toBe(180_000);
    expect(mock.sent.at(-1)?.telex.message.text).toBe('HANDOVER @XJJJ');
    fly(s, crossing + 2);
    await s.app.endFlight('DONE');
    await s.app.stopFlight();

    const codes = s.app.state().feed.flatMap((e) => (e.kind === 'system' ? [e.code] : []));
    for (const c of ['atc_station', 'atc_logon', 'atc_handover'] as const)
      expect(codes).toContain(c);

    const rec = await readRecording(s.recordings);
    expect(rec.header.xatc).toEqual({
      enabled: true,
      standAside: true,
      randomDirects: true,
      squawkTables: 'full',
    });
    const out = rec.events.flatMap((e) =>
      e.type === 'out' && e.packet !== undefined ? [e.packet] : [],
    );
    expect(out[0]).toBe('/data2/1/0/NE/LOGON ACCEPTED');
    const r = replay(rec, {
      scenarios: BASE_SCENARIOS_COMPILED.filter((c) => rec.header.scenarios.includes(c.id)),
    });
    expect(compareOutbound(r.recorded, r.outbound)).toEqual([]);
  });

  it('PDC (T24): request telex to X+origin, FSM and CLD by CPDLC, WILCO confirms; replayed', async () => {
    const http = await xatcHttp();
    const s = await setup({ http });
    await s.app.setSimbriefUsername('pilot42');
    await s.app.updateSettings({ transport: 'offline', xatc: true });
    await s.app.loadOfp();
    s.sockets.last().hello();
    await s.app.startFlight();
    const mock = s.transports[0]?.t as MockTransport;
    const socket = s.sockets.last();
    const step = async (from: number, to: number) => {
      for (const [i, snap] of flight.snapshots.slice(from, to).entries()) {
        s.clock.set(Math.max(s.clock.now(), snap.t));
        socket.frame({ type: 'telemetry', data: snap });
        s.app.tick(s.clock.now());
        if (i % 60 === 0) await new Promise((r) => setTimeout(r, 0));
      }
    };
    await step(0, 3);
    mock.deliver({
      from: ofp.callsign,
      to: 'XCTP',
      type: 'telex',
      packet: `REQUEST PREDEP CLEARANCE ${ofp.callsign} ${ofp.aircraft.icao} TO RJBB AT RCTP STAND 5 ATIS A`,
    });
    await step(3, 200);
    const dcl = mock.sent.filter((m) => m.telex.from === 'XCTP');
    expect(dcl.map((m) => m.telex.cpdlc?.ra)).toEqual(['NE', 'WU']);
    expect(dcl[1]?.telex.message.lines.join(' ')).toMatch(
      /^CLD \d{4} \d{6} RCTP PDC \d{3} @SJX822@ CLRD TO @RJBB@ OFF @05R@ VIA @MOLK1A@ SQUAWK @[0-7]{4}@ ATIS @A@$/,
    );
    mock.deliver({
      from: ofp.callsign,
      to: 'XCTP',
      type: 'cpdlc',
      packet: `/data2/9/${dcl[1]?.telex.cpdlc?.min}/N/WILCO`,
    });
    await step(200, 205);
    expect(mock.sent.at(-1)?.telex.message.text).toMatch(/CDA RECEIVED @CLEARANCE CONFIRMED$/);
    fly(s, 205);
    await s.app.endFlight('DONE');
    await s.app.stopFlight();
    const codes = s.app.state().feed.flatMap((e) => (e.kind === 'system' ? [e.code] : []));
    for (const c of ['atc_dcl_request', 'atc_dcl_clearance', 'atc_dcl_confirmed'] as const) {
      expect(codes).toContain(c);
    }
    const rec = await readRecording(s.recordings);
    const r = replay(rec, {
      scenarios: BASE_SCENARIOS_COMPILED.filter((c) => rec.header.scenarios.includes(c.id)),
    });
    expect(compareOutbound(r.recorded, r.outbound)).toEqual([]);
  });

  it('without live data: one note in the feed, no FIR station', async () => {
    const s = await setup({ http: await xatcHttp() });
    await s.app.setSimbriefUsername('pilot42');
    await s.app.updateSettings({ transport: 'offline', xatc: true, liveData: false });
    await s.app.loadOfp();
    s.sockets.last().hello();
    await s.app.startFlight();
    fly(s, 0, 10);
    const mock = s.transports[0]?.t as MockTransport;
    // Without FIR data only the DCL station of the origin listens.
    expect(mock.listening).toEqual(['XCTP']);
    expect(s.app.state().atc).toEqual({ station: null, connected: null, dcl: 'XCTP' });
    expect(s.app.state().feed.some((e) => e.kind === 'system' && e.code === 'atc_needs_data')).toBe(
      true,
    );
  });
});
