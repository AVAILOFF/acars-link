import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateSyntheticFlight, ManualClock, parseSimbriefOfp } from '@acars/core';
import { HOPPIE_ENDPOINT, type HttpRequest, MockTransport } from '@acars/transport';
import { describe, expect, it } from 'vitest';
import { closeDialog } from '../src/main/close-dialog.js';
import { AppController, HOPPIE_CHECK_GAP_MS } from '../src/main/controller.js';
import { guard } from '../src/main/errors.js';
import { BASE_SCENARIOS } from '../src/main/scenario-sources.js';
import { SecretStore } from '../src/main/secrets.js';
import { defaultSettings, SettingsStore } from '../src/main/settings.js';
import { openActions } from '../src/renderer/src/actions.js';
import {
  errorText,
  MESSAGES,
  reasonKey,
  systemText,
  translator,
} from '../src/renderer/src/i18n.js';
import { ERROR_REASONS, type FeedEntry } from '../src/shared/api.js';
import {
  FakeCipher,
  FakeHttp,
  FakeTimers,
  OFP_FIXTURE,
  socketFactory,
  tempDir,
} from './support.js';

/** T56: flight life cycle (U-04), checks (U-06), error codes (U-14) and the rest of the audit. */

const ofpJson = await readFile(OFP_FIXTURE, 'utf8');
const ofp = parseSimbriefOfp(JSON.parse(ofpJson));
const flight = generateSyntheticFlight({ ofp, boardingSec: 65 * 60 });
const T0 = flight.snapshots[0]?.t ?? 0;

/** SimBrief answers the fixture; Hoppie answers `hoppie` (a body or an error). */
function http(o: { hoppie?: () => string | Error; simbrief?: () => string | Error } = {}) {
  return new FakeHttp((req: HttpRequest) => {
    const r = req.url.startsWith(HOPPIE_ENDPOINT)
      ? (o.hoppie ?? (() => 'ok'))()
      : (o.simbrief ?? (() => ofpJson))();
    return r instanceof Error ? r : { status: 200, body: r };
  });
}

async function setup(h: FakeHttp = http()) {
  const dir = await tempDir();
  const clock = new ManualClock(T0);
  const sockets = socketFactory();
  const settings = new SettingsStore(join(dir, 'settings.json'), defaultSettings('en'));
  const app = new AppController({
    secrets: new SecretStore(join(dir, 'secrets.json'), new FakeCipher()),
    settings,
    scenarioSources: BASE_SCENARIOS,
    http: h,
    createTransport: () => new MockTransport(clock),
    createSocket: sockets.create,
    timers: new FakeTimers(),
    now: () => clock.now(),
    openRecording: null,
    revealRecordings: async () => {},
    onChange: () => {},
  });
  await app.init();
  await app.setSimbriefUsername('pilot42');
  return { app, clock, sockets, settings, http: h };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function startOffline(s: Setup, patch: Parameters<AppController['updateSettings']>[0] = {}) {
  await s.app.updateSettings({ transport: 'offline', ...patch });
  await s.app.loadOfp();
  s.sockets.last().hello();
  await s.app.startFlight();
}

function fly(s: Setup): void {
  for (const snap of flight.snapshots) {
    s.clock.set(Math.max(s.clock.now(), snap.t));
    s.sockets.last().frame({ type: 'telemetry', data: snap });
    s.app.tick(s.clock.now());
  }
}

/** The aircraft parked at the gate: one snapshot a second, the flight time goes on. */
function park(s: Setup, sec: number, until?: () => boolean): void {
  const last = flight.snapshots.at(-1);
  if (last === undefined) throw new Error('no snapshots');
  for (let i = 0; i < sec && until?.() !== true; i++) {
    s.clock.set(s.clock.now() + 1000);
    s.sockets.last().frame({ type: 'telemetry', data: { ...last, t: s.clock.now() } });
    s.app.tick(s.clock.now());
  }
}

/** OFP fetches so far (live data asks other hosts too). */
const ofpLoads = (s: Setup) => s.http.requests.filter((r) => r.url.includes('simbrief.com')).length;

const outbound = (feed: readonly FeedEntry[]) =>
  feed.flatMap((e) => (e.kind === 'outbound' ? [e] : []));

describe('closing the flight after the gate (U-04)', () => {
  it('"next OFP" after TURNAROUND waits for the queued messages, then closes and loads the OFP', async () => {
    const s = await setup();
    await startOffline(s, { messageGapSec: 60 });
    fly(s);
    expect(s.app.state().ending).toBeNull();
    expect(s.app.closeWouldLose).toBe(true);
    await s.app.endFlight('TURNAROUND');
    // Two answers at the gate: the second waits for the gap between messages.
    await s.app.sendPilotMessage('HELP');
    await s.app.sendPilotMessage('REQ GATE');
    park(s, 2);
    const ending = s.app.state().ending;
    expect(ending).toMatchObject({ to: 'TURNAROUND', closing: null });
    expect(ending?.messages).toBeGreaterThan(0);
    // The fuel watcher of the cruise (720 min) does not hold the flight.
    expect(ending?.scenarios).toBe(0);
    expect(s.app.closeWouldLose).toBe(true);

    const loads = ofpLoads(s);
    await s.app.closeFlight('next', false);
    expect(s.app.state()).toMatchObject({ session: 'running', ending: { closing: 'next' } });
    park(s, 180, () => s.app.state().session !== 'running');
    // Let the close (stop, then the OFP fetch) finish.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const st = s.app.state();
    expect(st.session).toBe('ready');
    expect(st.ending).toBeNull();
    expect(ofpLoads(s)).toBe(loads + 1);
    const out = outbound(st.feed);
    expect(out.every((m) => m.delivery === 'sent')).toBe(true);
    expect(out.filter((m) => m.scenarioId === 'cmd_req_gate')).toHaveLength(1);
    expect(st.feed.some((e) => e.kind === 'system' && e.code === 'flight_stopped')).toBe(true);
  });

  it('"close" after DONE with nothing waiting closes at once, no question on exit', async () => {
    const s = await setup();
    await startOffline(s);
    fly(s);
    await s.app.endFlight('DONE');
    park(s, 1);
    expect(s.app.state().ending).toMatchObject({ to: 'DONE', messages: 0, scenarios: 0 });
    expect(s.app.closeWouldLose).toBe(false);
    const loads = ofpLoads(s);
    await s.app.closeFlight('close', false);
    expect(s.app.state().session).toBe('ready');
    expect(ofpLoads(s)).toBe(loads);
  });

  it('"close now" drops what waits; closing before the gate is refused with a code', async () => {
    const s = await setup();
    await startOffline(s, { messageGapSec: 60 });
    expect(await guard(() => s.app.closeFlight('close', false))).toMatchObject({
      ok: false,
      error: { code: 'bad_state', reason: 'not_ended', params: { phase: 'PREFLIGHT' } },
    });
    fly(s);
    await s.app.endFlight('TURNAROUND');
    await s.app.sendPilotMessage('HELP');
    await s.app.sendPilotMessage('REQ GATE');
    park(s, 2);
    expect(s.app.state().ending?.messages).toBeGreaterThan(0);
    await s.app.closeFlight('close', true);
    expect(s.app.state().session).toBe('ready');
  });

  it('a failed next OFP leaves a feed line with the error code', async () => {
    let fail = false;
    const s = await setup(http({ simbrief: () => (fail ? new Error('offline') : ofpJson) }));
    await startOffline(s);
    fly(s);
    await s.app.endFlight('TURNAROUND');
    park(s, 1);
    fail = true;
    await s.app.closeFlight('next', false);
    const st = s.app.state();
    expect(st.session).toBe('ready');
    const line = st.feed.at(-1);
    expect(line).toMatchObject({
      kind: 'system',
      code: 'next_ofp_failed',
      params: { code: 'network', detail: 'offline' },
    });
    if (line?.kind !== 'system') throw new Error('no line');
    expect(systemText(translator('ru'), line.code, line.params)).toBe(
      'Рейс закрыт; следующий OFP не загрузился: Ошибка сети: offline',
    );
    expect(openActions(st.feed).map((e) => e.code)).toEqual(['next_ofp_failed']);
  });
});

describe('error codes (U-14)', () => {
  it('our failures carry a reason; RU text has no English', async () => {
    const s = await setup();
    const r = (p: Promise<unknown>) => guard(() => p);
    expect(await r(s.app.startFlight())).toMatchObject({
      error: { code: 'bad_state', reason: 'load_ofp_first' },
    });
    expect(await r(s.app.setHoppieCode('bad code'))).toMatchObject({
      error: { code: 'invalid_input', reason: 'logon_format' },
    });
    expect(await r(s.app.updateSettings({ bridgePort: 80 }))).toMatchObject({
      error: { code: 'invalid_input', reason: 'bridge_port', params: { field: 'bridgePort' } },
    });
    await startOffline(s);
    const running = await r(s.app.startFlight());
    expect(running).toMatchObject({ error: { code: 'bad_state', reason: 'flight_running' } });
    expect(await r(s.app.loadOfp())).toMatchObject({ error: { reason: 'stop_flight_first' } });
    expect(await r(s.app.endFlight('DONE'))).toMatchObject({
      error: { reason: 'not_on_block', params: { phase: 'PREFLIGHT' } },
    });
    if (running.ok) throw new Error('expected a failure');
    expect(errorText(translator('ru'), running.error)).toBe('Сейчас нельзя: идёт рейс');
    const onBlock = await r(s.app.endFlight('DONE'));
    if (onBlock.ok) throw new Error('expected a failure');
    expect(errorText(translator('ru'), onBlock.error)).toBe(
      `Сейчас нельзя: самолёт не на стоянке (фаза: ${MESSAGES.ru['phase.PREFLIGHT']})`,
    );
  });

  it('every reason has a text in EN and RU', () => {
    for (const lang of ['en', 'ru'] as const) {
      for (const reason of ERROR_REASONS) expect(MESSAGES[lang][reasonKey(reason)]).toBeTruthy();
    }
  });
});

describe('checks of the credentials (U-06)', () => {
  it('Hoppie: one ping with the code; a wrong code is `hoppie_logon`; at most one per 15 s', async () => {
    let answer = 'ok';
    const s = await setup(http({ hoppie: () => answer }));
    expect(await guard(() => s.app.checkHoppie())).toMatchObject({
      error: { code: 'no_hoppie_code' },
    });
    await s.app.setHoppieCode('LOGON0123456789');
    expect(await s.app.checkHoppie()).toBeNull();
    const ping = s.http.requests.at(-1);
    const url = new URL(ping?.url ?? '');
    expect(`${url.origin}${url.pathname}`).toBe(HOPPIE_ENDPOINT);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ type: 'ping', to: 'SERVER' });
    expect(await guard(() => s.app.checkHoppie())).toMatchObject({
      error: { code: 'bad_state', reason: 'check_too_soon' },
    });
    s.clock.set(s.clock.now() + HOPPIE_CHECK_GAP_MS);
    // The answer of hoppie.nl to a wrong code (checked 2026-10-22).
    answer = 'error {invalid logon code}';
    const bad = await guard(() => s.app.checkHoppie());
    expect(bad).toMatchObject({ error: { code: 'hoppie_logon', detail: 'invalid logon code' } });
    expect(JSON.stringify(bad)).not.toContain('LOGON0123456789');
    await startOffline(s);
    s.clock.set(s.clock.now() + HOPPIE_CHECK_GAP_MS);
    expect(await guard(() => s.app.checkHoppie())).toMatchObject({
      error: { reason: 'flight_running' },
    });
  });

  it('SimBrief: the latest OFP, not loaded', async () => {
    const s = await setup();
    expect(await s.app.checkSimbrief()).toEqual({
      callsign: ofp.callsign,
      origin: ofp.origin.icao,
      destination: ofp.destination.icao,
    });
    expect(s.app.state().session).toBe('idle');
  });
});

describe('scenarios screen (U-10)', () => {
  it('pilot commands are flagged, always on and not switchable; a category switches at once', async () => {
    const s = await setup();
    // A switch of an older version turned a command off: it runs anyway.
    await s.settings.setScenario('cmd_req_gate', false);
    const list = await s.app.listScenarios();
    const gate = list.find((x) => x.id === 'cmd_req_gate');
    expect(gate).toMatchObject({ command: true, enabled: true });
    expect(list.filter((x) => x.command).length).toBeGreaterThan(10);
    expect(await guard(() => s.app.setScenarioEnabled('cmd_req_gate', false))).toMatchObject({
      error: { reason: 'command_scenario' },
    });
    const docs = list.filter((x) => x.category === 'docs' && !x.command).map((x) => x.id);
    const after = await s.app.setScenariosEnabled(docs, false);
    expect(after.filter((x) => docs.includes(x.id)).every((x) => !x.enabled)).toBe(true);
    expect(await guard(() => s.app.setScenariosEnabled(['cmd_help'], false))).toMatchObject({
      error: { reason: 'command_scenario' },
    });

    await startOffline(s);
    fly(s);
    await s.app.sendPilotMessage('REQ GATE');
    park(s, 2);
    expect(outbound(s.app.state().feed).some((m) => m.scenarioId === 'cmd_req_gate')).toBe(true);
  });
});

describe('time from the simulator (U-16)', () => {
  it('the flight shows that it waits for the sim time', async () => {
    const s = await setup();
    await startOffline(s, { simTime: true });
    const first = flight.snapshots[0];
    if (first === undefined) throw new Error('no snapshots');
    s.sockets.last().frame({ type: 'telemetry', data: first });
    s.app.tick(s.clock.now());
    expect(s.app.state().waitingSimTime).toBe(true);
    s.sockets.last().frame({ type: 'telemetry', data: { ...first, simUtcMs: first.t } });
    s.app.tick(s.clock.now());
    expect(s.app.state().waitingSimTime).toBe(false);
  });
});

describe('window close question (U-03)', () => {
  it('has a text in both languages; the default keeps the flight', () => {
    for (const lang of ['en', 'ru'] as const) {
      const d = closeDialog(lang);
      expect(d.message).not.toBe('');
      expect(d.buttons).toHaveLength(2);
      expect(d.cancelId).toBe(1);
    }
    expect(closeDialog('ru').message).toMatch(/[а-я]/);
  });
});

describe('action lines in the feed (U-15)', () => {
  const sys = (id: string, code: string, params: Record<string, string> = {}): FeedEntry =>
    ({ kind: 'system', id, t: 0, code, params }) as FeedEntry;

  it('stay open until settled: telemetry back, the network OK, the flight over', () => {
    const feed = [
      sys('1', 'flight_started'),
      sys('2', 'atc_needs_data'),
      sys('3', 'telemetry_lost'),
      sys('4', 'transport_status', { status: 'degraded', reason: 'timeout' }),
      sys('5', 'phase', { from: 'CLIMB', to: 'CRUISE' }),
    ];
    expect(openActions(feed).map((e) => e.id)).toEqual(['2', '3', '4']);
    const settled = [
      ...feed,
      sys('6', 'telemetry_restored', { gapSec: '5' }),
      sys('7', 'transport_status', { status: 'ok', reason: '' }),
    ];
    expect(openActions(settled).map((e) => e.id)).toEqual(['2']);
    expect(openActions([...settled, sys('8', 'flight_stopped', { phase: 'CRUISE' })])).toEqual([]);
  });
});
