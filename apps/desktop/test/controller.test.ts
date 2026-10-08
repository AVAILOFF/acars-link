import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateSyntheticFlight, ManualClock, parseSimbriefOfp } from '@acars/core';
import { MockTransport } from '@acars/transport';
import { describe, expect, it } from 'vitest';
import { AppController, type TransportFactory } from '../src/main/controller.js';
import { guard } from '../src/main/errors.js';
import { BASE_SCENARIOS } from '../src/main/scenario-sources.js';
import { SecretStore } from '../src/main/secrets.js';
import { defaultSettings, SettingsStore } from '../src/main/settings.js';
import { MESSAGES } from '../src/renderer/src/i18n.js';
import type { FeedEntry } from '../src/shared/api.js';
import {
  FakeCipher,
  FakeTimers,
  OFP_FIXTURE,
  simbriefOk,
  socketFactory,
  tempDir,
} from './support.js';

const ofp = parseSimbriefOfp(JSON.parse(await readFile(OFP_FIXTURE, 'utf8')));
const flight = generateSyntheticFlight({ ofp });
const T0 = flight.snapshots[0]?.t ?? 0;

async function setup() {
  const dir = await tempDir();
  const clock = new ManualClock(T0);
  const sockets = socketFactory();
  const transports: { choice: Parameters<TransportFactory>[0]; t: MockTransport }[] = [];
  const secretsFile = join(dir, 'secrets.json');
  const app = new AppController({
    secrets: new SecretStore(secretsFile, new FakeCipher()),
    settings: new SettingsStore(join(dir, 'settings.json'), defaultSettings('en')),
    scenarioSources: BASE_SCENARIOS,
    http: await simbriefOk(),
    // The mock stands in for Hoppie too; the test checks which logon it was given.
    createTransport: (choice) => {
      const t = new MockTransport(clock);
      transports.push({ choice, t });
      return t;
    },
    createSocket: sockets.create,
    timers: new FakeTimers(),
    now: () => clock.now(),
    onChange: () => {},
  });
  await app.init();
  return { app, clock, sockets, transports, secretsFile };
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

const outbound = (feed: readonly FeedEntry[]) =>
  feed.flatMap((e) => (e.kind === 'outbound' ? [e] : []));

describe('AppController', () => {
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
    expect(list).toHaveLength(15);
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
      expect.objectContaining({ kind: 'system', code: 'late_start', params: { min: '30' } }),
    );
    expect(
      outbound(feed)
        .filter((m) => m.t === start)
        .map((m) => m.scenarioId),
    ).toEqual(['crew_info']);
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

describe('i18n', () => {
  it('EN and RU have the same keys and placeholders', () => {
    const { en, ru } = MESSAGES;
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      expect(holes(ru[k]), k).toEqual(holes(en[k]));
    }
  });
});
