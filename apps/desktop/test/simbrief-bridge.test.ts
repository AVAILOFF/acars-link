// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isTelemetrySnapshot, type TelemetrySnapshot } from '@acars/core';
import { describe, expect, it } from 'vitest';
import {
  BRIDGE_TOKEN_HEADER,
  BridgeClient,
  bridgeHeaders,
  bridgeUrl,
  COMMAND_TIMEOUT_MS,
  type CommandResult,
  RECONNECT_DELAYS_MS,
} from '../src/main/bridge.js';
import { fetchOfp, normalizeSimbriefUsername, simbriefUrl } from '../src/main/simbrief.js';
import { FakeHttp, FakeTimers, simbriefOk, socketFactory } from './support.js';

const SAMPLE: TelemetrySnapshot = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../reference/telemetry.sample.json'), 'utf8'),
);

describe('SimBrief', () => {
  it('builds the json=v2 URL over https with the username encoded', () => {
    expect(simbriefUrl('a&b=c')).toBe(
      'https://www.simbrief.com/api/xml.fetcher.php?username=a%26b%3Dc&json=v2',
    );
  });

  it('normalizes usernames', () => {
    expect(normalizeSimbriefUsername('  pilot42 ')).toBe('pilot42');
    for (const bad of ['', '   ', 'two words', 'x'.repeat(65), 42, null]) {
      expect(() => normalizeSimbriefUsername(bad), String(bad)).toThrow();
    }
  });

  it('parses the latest OFP', async () => {
    const http = await simbriefOk();
    const ofp = await fetchOfp(http, 'pilot42');
    expect(ofp.origin.icao).toBe('RCTP');
    expect(ofp.destination.icao).toBe('RJBB');
    expect(http.requests[0]).toMatchObject({ method: 'GET', timeoutMs: 20_000 });
  });

  it('unknown user (HTTP 400, fetch.status) → simbrief_user', async () => {
    const http = new FakeHttp(() => ({
      status: 400,
      body: '{"fetch":{"userid":"","static_id":"","status":"Error: Unknown UserID","time":"0.0003"}}',
    }));
    await expect(fetchOfp(http, 'nobody')).rejects.toMatchObject({
      code: 'simbrief_user',
      detail: 'Error: Unknown UserID',
    });
  });

  it('other failures: HTTP, not JSON, network, bad OFP', async () => {
    await expect(
      fetchOfp(new FakeHttp(() => ({ status: 503, body: '<html>' })), 'u'),
    ).rejects.toMatchObject({ code: 'simbrief_http' });
    await expect(
      fetchOfp(new FakeHttp(() => ({ status: 500, body: '{}' })), 'u'),
    ).rejects.toMatchObject({ code: 'simbrief_http', detail: 'HTTP 500' });
    await expect(
      fetchOfp(new FakeHttp(() => new Error('network error (ENOTFOUND)')), 'u'),
    ).rejects.toMatchObject({ code: 'network' });
    await expect(
      fetchOfp(new FakeHttp(() => ({ status: 200, body: '{"fetch":{"status":"Success"}}' })), 'u'),
    ).rejects.toMatchObject({ code: 'ofp_invalid' });
  });
});

function client(port = 47830, token: string | null = null) {
  const sockets = socketFactory();
  const timers = new FakeTimers();
  const telemetry: TelemetrySnapshot[] = [];
  const results: CommandResult[] = [];
  let now = 1_000_000;
  const c = new BridgeClient({
    port,
    createSocket: sockets.create,
    token,
    timers,
    now: () => now,
    onTelemetry: (s) => telemetry.push(s),
    onChange: () => {},
    onCommandResult: (r) => results.push(r),
  });
  return { c, sockets, timers, telemetry, results, tick: (ms: number) => (now += ms) };
}

describe('BridgeClient', () => {
  it('connects to 127.0.0.1 only', () => {
    expect(bridgeUrl(47830)).toBe('ws://127.0.0.1:47830/?protocol=2');
    expect(() => bridgeUrl(0)).toThrow();
    const { c, sockets } = client(47831);
    c.start();
    expect(sockets.last().url).toBe('ws://127.0.0.1:47831/?protocol=2');
    expect(sockets.last().headers).toEqual({});
  });

  it('T65: sends the launch token in a header on every connection, never in the URL', () => {
    const { c, sockets, timers } = client(47830, 'tok-abc');
    c.start();
    expect(sockets.last().headers).toEqual({ [BRIDGE_TOKEN_HEADER]: 'tok-abc' });
    expect(sockets.last().url).not.toContain('tok-abc');
    sockets.last().drop();
    timers.runNext();
    expect(sockets.sockets).toHaveLength(2);
    expect(sockets.last().headers).toEqual({ [BRIDGE_TOKEN_HEADER]: 'tok-abc' });
    expect(bridgeHeaders('')).toEqual({});
  });

  it('hello → status → telemetry', () => {
    const { c, sockets, telemetry } = client();
    c.start();
    expect(c.view.link).toBe('connecting');
    const s = sockets.last();
    s.frame({ type: 'telemetry', data: SAMPLE }); // before hello: ignored
    expect(c.view.version).toBeNull();
    s.hello();
    expect(c.view.link).toBe('open');
    expect(c.view.version).toBe('t'); // T74: shown in "About"
    s.frame({ type: 'status', sim: 'connected', running: true, paused: true, simRate: 4 });
    expect(c.view).toMatchObject({ sim: 'connected', running: true, paused: true, simRate: 4 });
    s.frame({ type: 'telemetry', data: SAMPLE });
    s.frame({ type: 'telemetry', data: { ...SAMPLE, v: 2 } });
    s.frame({ type: 'telemetry', data: { ...SAMPLE, engN2: ['x'] } });
    s.frame('not json');
    expect(telemetry).toEqual([SAMPLE]);
  });

  it('reconnects with backoff 1, 2, 4 … 30 s, reset after a good hello', () => {
    const { c, sockets, timers } = client();
    c.start();
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      sockets.last().drop();
      expect(c.view.link).toBe('closed');
      delays.push(timers.runNext());
    }
    expect(delays).toEqual([...RECONNECT_DELAYS_MS, 30_000, 30_000]);
    sockets.last().hello();
    sockets.last().drop();
    expect(timers.runNext()).toBe(1_000);
  });

  it('closes on an incompatible bridge and shows why', () => {
    const { c, sockets, timers } = client();
    c.start();
    const s = sockets.last();
    s.hello(3, 1);
    expect(s.closed).toMatchObject({ code: 1002 });
    expect(c.view.link).toBe('closed');
    expect(c.view.detail).toMatch(/protocol 3/);
    expect(timers.pending).toHaveLength(1);
  });

  it('stop() closes the socket and cancels retries; setPort reconnects', () => {
    const { c, sockets, timers } = client();
    c.start();
    sockets.last().drop();
    c.stop();
    expect(timers.pending).toHaveLength(0);
    c.start();
    const first = sockets.last();
    c.setPort(47900);
    expect(first.closed).not.toBeNull();
    expect(sockets.last().url).toBe('ws://127.0.0.1:47900/?protocol=2');
  });

  it('works with a v1 bridge: telemetry flows, commands are unavailable and nothing is sent', () => {
    const { c, sockets, telemetry, results } = client();
    c.start();
    const s = sockets.last();
    s.hello(1);
    expect(c.view).toMatchObject({ link: 'open', protocol: 1, commands: [] });
    s.frame({ type: 'telemetry', data: SAMPLE });
    expect(telemetry).toEqual([SAMPLE]);
    c.sendCommand('ping');
    expect(s.sent).toEqual([]);
    expect(results).toMatchObject([{ command: 'ping', ok: false, error: 'unavailable' }]);
  });

  it('v2: sends a command and reports the ack once', () => {
    const { c, sockets, timers, results } = client();
    c.start();
    const s = sockets.last();
    s.hello(2, 1, ['ping']);
    expect(c.view).toMatchObject({ protocol: 2, commands: ['ping'] });

    const id = c.sendCommand('ping');
    expect(s.sent).toEqual([{ type: 'command', id, command: 'ping', args: {} }]);
    expect(c.pendingCommands).toBe(1);
    s.frame({ type: 'ack', id: 'someone-else', ok: true }); // not ours: ignored
    s.frame({ type: 'ack', id: null, ok: false, error: 'bad_frame' });
    expect(results).toEqual([]);
    s.frame({ type: 'ack', id, ok: true });
    s.frame({ type: 'ack', id, ok: true }); // duplicate: ignored
    expect(results).toEqual([{ id, command: 'ping', ok: true, error: null, detail: null }]);
    expect(c.pendingCommands).toBe(0);
    expect(timers.pending).toHaveLength(0); // the timeout was cleared

    const id2 = c.sendCommand('ping');
    s.frame({ type: 'ack', id: id2, ok: false, error: 'unavailable', detail: 'sim not connected' });
    expect(results[1]).toEqual({
      id: id2,
      command: 'ping',
      ok: false,
      error: 'unavailable',
      detail: 'sim not connected',
    });
  });

  it('v2: timeout, dropped connection, refused args, command not offered, send error', () => {
    const { c, sockets, timers, results } = client();
    c.start();
    let s = sockets.last();
    s.hello();

    const late = c.sendCommand('ping');
    expect(timers.runNext()).toBe(COMMAND_TIMEOUT_MS);
    expect(results.pop()).toMatchObject({ id: late, ok: false, error: 'timeout' });
    s.frame({ type: 'ack', id: late, ok: true }); // after the timeout: ignored
    expect(results).toEqual([]);

    const lost = c.sendCommand('ping');
    s.drop();
    expect(results.pop()).toMatchObject({ id: lost, ok: false, error: 'disconnected' });
    expect(c.view.protocol).toBeNull();
    c.sendCommand('ping');
    expect(results.pop()).toMatchObject({ error: 'unavailable' });

    timers.runNext(); // reconnect
    s = sockets.last();
    s.hello();
    c.sendCommand('ping', { x: 1 });
    expect(results.pop()).toMatchObject({ error: 'bad_args', detail: 'ping takes no arguments' });
    expect(s.sent).toEqual([]);

    s.hello(2, 1, []);
    c.sendCommand('ping');
    expect(results.pop()).toMatchObject({
      error: 'unavailable',
      detail: 'bridge does not offer ping',
    });

    s.hello();
    s.sendError = new Error('socket not open');
    c.sendCommand('ping');
    expect(results.pop()).toMatchObject({ error: 'disconnected', detail: 'socket not open' });
    expect(c.pendingCommands).toBe(0);
  });

  it('stop() fails pending commands', () => {
    const { c, sockets, results } = client();
    c.start();
    sockets.last().hello();
    const id = c.sendCommand('ping');
    c.stop();
    expect(results).toMatchObject([{ id, error: 'disconnected' }]);
  });

  it('isTelemetrySnapshot accepts the reference sample', () => {
    expect(isTelemetrySnapshot(SAMPLE)).toBe(true);
    expect(isTelemetrySnapshot({ ...SAMPLE, aircraftTitle: 1 })).toBe(false);
  });
});
