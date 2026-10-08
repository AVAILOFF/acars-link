import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TelemetrySnapshot } from '@acars/core';
import { describe, expect, it } from 'vitest';
import {
  BridgeClient,
  bridgeUrl,
  isTelemetrySnapshot,
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

function client(port = 47830) {
  const sockets = socketFactory();
  const timers = new FakeTimers();
  const telemetry: TelemetrySnapshot[] = [];
  let now = 1_000_000;
  const c = new BridgeClient({
    port,
    createSocket: sockets.create,
    timers,
    now: () => now,
    onTelemetry: (s) => telemetry.push(s),
    onChange: () => {},
  });
  return { c, sockets, timers, telemetry, tick: (ms: number) => (now += ms) };
}

describe('BridgeClient', () => {
  it('connects to 127.0.0.1 only', () => {
    expect(bridgeUrl(47830)).toBe('ws://127.0.0.1:47830/');
    expect(() => bridgeUrl(0)).toThrow();
    const { c, sockets } = client(47831);
    c.start();
    expect(sockets.last().url).toBe('ws://127.0.0.1:47831/');
  });

  it('hello → status → telemetry', () => {
    const { c, sockets, telemetry } = client();
    c.start();
    expect(c.view.link).toBe('connecting');
    const s = sockets.last();
    s.frame({ type: 'telemetry', data: SAMPLE }); // before hello: ignored
    s.hello();
    expect(c.view.link).toBe('open');
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
    s.hello(2, 1);
    expect(s.closed).toMatchObject({ code: 1002 });
    expect(c.view.link).toBe('closed');
    expect(c.view.detail).toMatch(/protocol 2/);
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
    expect(sockets.last().url).toBe('ws://127.0.0.1:47900/');
  });

  it('isTelemetrySnapshot accepts the reference sample', () => {
    expect(isTelemetrySnapshot(SAMPLE)).toBe(true);
    expect(isTelemetrySnapshot({ ...SAMPLE, aircraftTitle: 1 })).toBe(false);
  });
});
