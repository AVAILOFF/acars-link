import { createRng, ManualClock } from '@acars/core';
import { describe, expect, it } from 'vitest';
import {
  HoppieTransport,
  type HttpClient,
  HttpTimeoutError,
  type TransportEvent,
} from '../src/index.js';
import { FakeHoppie, LOGON, setup, T0, telex } from './fake-hoppie.js';

function gaps(times: readonly number[]): number[] {
  return times.slice(1).map((t, i) => t - (times[i] as number));
}

function ofType<T extends TransportEvent['type']>(events: readonly TransportEvent[], type: T) {
  return events.filter((e): e is Extract<TransportEvent, { type: T }> => e.type === type);
}

describe('HoppieTransport: sending', () => {
  it('sends a telex from the station to the aircraft and reports SENT', async () => {
    const { server, transport, events, run } = setup();
    const id = transport.send(telex('PRELIMINARY LOADSHEET'));
    expect(transport.pending).toBe(1);
    await run(1_000);
    expect(server.seen).toHaveLength(1);
    expect(server.seen[0]?.params).toEqual({
      logon: LOGON,
      from: 'OPSDLH4',
      to: 'DLH4',
      type: 'telex',
      packet: 'PRELIMINARY LOADSHEET',
    });
    expect(server.seen[0]?.req.url.startsWith('https://www.hoppie.nl/')).toBe(true);
    expect(server.seen[0]?.req.timeoutMs).toBe(15_000);
    expect(events).toEqual([
      { type: 'SENT', id, t: T0 + 1_000 },
      { type: 'STATUS', t: T0 + 1_000, status: 'ok' },
    ]);
    expect(transport.pending).toBe(0);
    expect(transport.status).toBe('ok');
  });

  it('keeps order and at least 2 s between requests, never two in flight', async () => {
    const clock = new ManualClock(T0);
    const server = new FakeHoppie(clock);
    let release: (() => void) | undefined;
    let inFlight = 0;
    let maxInFlight = 0;
    const gated: HttpClient = {
      async request(req) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((r) => {
          release = r;
        });
        inFlight--;
        return server.request(req);
      },
    };
    const t = new HoppieTransport({ logon: LOGON, http: gated, clock, rng: createRng(1) });
    const ids = ['ONE', 'TWO', 'THREE'].map((s) => t.send(telex(s)));
    const events: TransportEvent[] = [];
    for (let i = 0; i < 20; i++) {
      clock.advance(500);
      t.tick();
      t.tick(); // a second tick while a request is in flight must not start another
      release?.();
      release = undefined;
      await t.idle();
      events.push(...t.takeEvents());
    }
    expect(maxInFlight).toBe(1);
    expect(server.seen.map((s) => s.params['packet'])).toEqual(['ONE', 'TWO', 'THREE']);
    expect(Math.min(...gaps(server.seen.map((s) => s.t)))).toBeGreaterThanOrEqual(2_000);
    expect(ofType(events, 'SENT').map((e) => e.id)).toEqual(ids);
    expect(t.pending).toBe(0);
  });

  it('retries network errors, timeouts and HTTP errors with growing jittered backoff', async () => {
    const { server, transport, events, run } = setup();
    const failures = [
      { reject: new HttpTimeoutError('timeout') },
      { reject: new Error('network error (ECONNRESET)') },
      { status: 503 },
      '<html>bad gateway</html>',
    ];
    server.handler = () => failures.shift() ?? 'ok';
    const id = transport.send(telex('GATE B12'));
    transport.send(telex('BEHIND'));
    await run(300_000);

    const retries = ofType(events, 'SEND_RETRY');
    expect(retries.map((r) => [r.attempt, r.reason])).toEqual([
      [1, 'timeout'],
      [2, 'network error (ECONNRESET)'],
      [3, 'http 503'],
      [4, 'unexpected response: <html>bad gateway</html>'],
    ]);
    for (const r of retries) {
      const exp = 5_000 * 2 ** (r.attempt - 1);
      expect(r.nextAt - r.t).toBeGreaterThanOrEqual(exp * 0.8);
      expect(r.nextAt - r.t).toBeLessThanOrEqual(exp * 1.2);
    }
    const telexes = server.ofType('telex');
    // Each attempt waits for its backoff; the telex behind waits for the head.
    for (const [i, r] of retries.entries()) {
      expect(telexes[i + 1]?.t).toBeGreaterThanOrEqual(r.nextAt);
    }
    expect(telexes.map((s) => s.params['packet'])).toEqual([
      'GATE B12',
      'GATE B12',
      'GATE B12',
      'GATE B12',
      'GATE B12',
      'BEHIND',
    ]);
    expect(ofType(events, 'SENT').map((e) => e.id)[0]).toBe(id);
    expect(ofType(events, 'STATUS').map((e) => e.status)).toEqual(['degraded', 'ok']);
  });

  it('gives up after maxAttempts and moves on to the next telex', async () => {
    const { server, transport, events, run } = setup({ retry: { maxAttempts: 3 } });
    server.handler = (p) => (p['packet'] === 'DOOMED' ? { status: 500 } : 'ok');
    const doomed = transport.send(telex('DOOMED'));
    const next = transport.send(telex('NEXT'));
    await run(120_000);
    expect(server.ofType('telex').filter((s) => s.params['packet'] === 'DOOMED')).toHaveLength(3);
    expect(ofType(events, 'SEND_FAILED')).toEqual([
      expect.objectContaining({ id: doomed, reason: 'http 500' }),
    ]);
    expect(ofType(events, 'SENT').map((e) => e.id)).toEqual([next]);
  });

  it('does not retry a server-side rejection of the telex', async () => {
    const { server, transport, events, run } = setup();
    server.handler = (p) => (p['type'] === 'telex' ? 'error {unknown station}' : 'ok');
    const id = transport.send(telex('X'));
    await run(60_000);
    expect(server.ofType('telex')).toHaveLength(1);
    expect(ofType(events, 'SEND_FAILED')).toEqual([
      { type: 'SEND_FAILED', id, t: T0 + 1_000, reason: 'unknown station' },
    ]);
  });

  it('waits for the 100 s callsign lock when another logon holds the station', async () => {
    const { server, transport, events, run } = setup();
    let first = true;
    server.handler = () => {
      if (!first) return 'ok';
      first = false;
      return 'error {callsign already in use}';
    };
    transport.send(telex('X'));
    await run(200_000);
    const [a, b] = server.ofType('telex');
    expect((b?.t ?? 0) - (a?.t ?? 0)).toBeGreaterThanOrEqual(110_000);
    expect(ofType(events, 'SEND_RETRY')[0]?.reason).toBe('callsign already in use');
  });

  it('halts on a bad logon code, keeps the telex and sends it after resume()', async () => {
    const { server, transport, events, run } = setup();
    server.handler = () => 'error {invalid logon code}';
    const id = transport.send(telex('X'));
    await run(600_000);
    expect(server.seen).toHaveLength(1);
    expect(transport.status).toBe('halted');
    expect(transport.pending).toBe(1);
    expect(ofType(events, 'STATUS')).toEqual([
      { type: 'STATUS', t: T0 + 1_000, status: 'halted', reason: 'invalid logon code' },
    ]);

    server.handler = () => 'ok';
    transport.resume();
    await run(1_000);
    expect(ofType(events, 'SENT').map((e) => e.id)).toEqual([id]);
  });

  it('never puts the logon code into events', async () => {
    const { server, transport, events, run } = setup();
    server.handler = (p) =>
      p['type'] === 'telex'
        ? { reject: new Error(`failed GET ?logon=${LOGON}&from=OPSDLH4`) }
        : `error {logon ${LOGON} rejected}`;
    transport.send(telex('X'));
    await run(30_000);
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(LOGON);
    expect(JSON.stringify(events)).toContain('***');
  });

  it('uses POST for a telex longer than the GET limit', async () => {
    const { server, transport, run } = setup();
    const text = Array.from({ length: 12 }, (_, i) => `LINE ${i} OF THE FINAL LOADSHEET`).join(' ');
    transport.send(telex(text));
    await run(1_000);
    expect(server.seen[0]?.req.method).toBe('POST');
    expect(server.seen[0]?.params['packet']).toBe(telex(text).message.text);
  });

  it('rejects bad callsigns, empty telexes and non-https endpoints', () => {
    const { transport } = setup();
    expect(() => transport.send(telex('X', 'OPS-1'))).toThrow(TypeError);
    expect(() => transport.send(telex('X', 'OPS1', 'dlh4'))).toThrow(TypeError);
    expect(() => transport.send(telex(''))).toThrow(/empty/); // the formatter refuses first
    expect(() => setup({ endpoint: 'http://www.hoppie.nl/acars/system/connect.html' })).toThrow(
      /https/,
    );
    expect(() => setup({ logon: ' ' })).toThrow(TypeError);
    expect(() => setup({ pollIntervalMs: [5_000, 10_000] })).toThrow(RangeError);
    expect(() => setup({ minRequestGapMs: 0 })).toThrow(RangeError);
  });
});

describe('HoppieTransport: polling', () => {
  it('does not poll before the station sent its first telex', async () => {
    const { server, run } = setup();
    await run(600_000, 5_000);
    expect(server.seen).toHaveLength(0);
  });

  it('polls the station every 45–75 s after its first telex and reports inbound', async () => {
    const { server, transport, events, run } = setup();
    let polls = 0;
    server.handler = (p) => {
      if (p['type'] !== 'poll') return 'ok';
      polls++;
      return polls === 2 ? 'ok {DLH4 telex {REQ GATE}} {DLH4 telex {THX}}' : 'ok';
    };
    transport.send(telex('HELLO'));
    await run(3_600_000);

    const pollReqs = server.ofType('poll');
    expect(pollReqs.length).toBeGreaterThanOrEqual(48);
    expect(pollReqs.length).toBeLessThanOrEqual(80);
    expect(pollReqs[0]?.params).toEqual({
      logon: LOGON,
      from: 'OPSDLH4',
      to: 'SERVER',
      type: 'poll',
      packet: '',
    });
    const all = [server.ofType('telex')[0]?.t ?? 0, ...pollReqs.map((s) => s.t)];
    for (const g of gaps(all)) {
      expect(g).toBeGreaterThanOrEqual(45_000);
      expect(g).toBeLessThanOrEqual(76_000);
    }
    // Randomized, not a fixed beat.
    expect(new Set(gaps(all)).size).toBeGreaterThan(5);
    expect(ofType(events, 'INBOUND').map((e) => e.message)).toEqual([
      { from: 'DLH4', to: 'OPSDLH4', type: 'telex', packet: 'REQ GATE' },
      { from: 'DLH4', to: 'OPSDLH4', type: 'telex', packet: 'THX' },
    ]);
  });

  it('skips a failed poll until the next full interval, no immediate retry', async () => {
    const { server, transport, events, run } = setup();
    server.handler = (p) => (p['type'] === 'poll' ? { reject: new HttpTimeoutError('t') } : 'ok');
    transport.send(telex('HELLO'));
    await run(600_000);
    const all = [server.ofType('telex')[0]?.t ?? 0, ...server.ofType('poll').map((s) => s.t)];
    expect(Math.min(...gaps(all))).toBeGreaterThanOrEqual(45_000);
    expect(transport.status).toBe('degraded');
    expect(ofType(events, 'STATUS').map((e) => [e.status, e.reason])).toEqual([
      ['ok', undefined],
      ['degraded', 'timeout'],
    ]);
  });

  it('polls every 20 s while a reply is expected, then returns to normal', async () => {
    const { server, transport, run } = setup();
    transport.send(telex('CONFIRM FUEL'));
    await run(1_000);
    transport.expectReply(60_000);
    await run(240_000);
    const polls = server.ofType('poll').map((s) => s.t - T0);
    expect(polls.slice(0, 3)).toEqual([21_000, 41_000, 61_000]);
    for (const g of gaps(polls.slice(2))) expect(g).toBeGreaterThanOrEqual(45_000);
  });

  it('caps expectReply at 3 minutes', async () => {
    const { server, transport, run } = setup();
    transport.send(telex('X'));
    await run(1_000);
    transport.expectReply(3_600_000);
    await run(600_000);
    const fast = gaps(server.ofType('poll').map((s) => s.t)).filter((g) => g === 20_000);
    expect(fast.length).toBeLessThanOrEqual(9);
    expect(fast.length).toBeGreaterThanOrEqual(7);
  });

  it('sends queued telexes before a due poll', async () => {
    const { server, transport, clock, run } = setup();
    transport.send(telex('ONE'));
    await run(1_000);
    clock.advance(80_000); // poll is now overdue
    transport.send(telex('TWO'));
    await run(1_000);
    expect(server.seen.map((s) => s.params['type'])).toEqual(['telex', 'telex']);
    await run(3_000);
    expect(server.seen.map((s) => s.params['type'])).toEqual(['telex', 'telex', 'poll']);
  });

  it('halts on a bad logon code in a poll', async () => {
    const { server, transport, run } = setup();
    server.handler = (p) => (p['type'] === 'poll' ? 'error {illegal logon code}' : 'ok');
    transport.send(telex('X'));
    await run(600_000);
    expect(server.ofType('poll')).toHaveLength(1);
    expect(transport.status).toBe('halted');
  });
});

describe('HoppieTransport: determinism and etiquette over a long flight', () => {
  async function flight(seed: string) {
    const s = setup({}, seed);
    let n = 0;
    s.server.handler = () => {
      n++;
      return n % 7 === 0 ? { status: 502 } : 'ok';
    };
    for (let i = 0; i < 30; i++) s.transport.send(telex(`MSG ${i}`));
    await s.run(4 * 3_600_000, 1_000);
    return s;
  }

  it('same seed → same request times; no bursts, polls ≥ 20 s apart', async () => {
    const a = await flight('LH400');
    const b = await flight('LH400');
    expect(a.server.seen.map((s) => s.t)).toEqual(b.server.seen.map((s) => s.t));
    expect(ofType(a.events, 'SENT')).toHaveLength(30);
    const times = a.server.seen.map((s) => s.t);
    expect(Math.min(...gaps(times))).toBeGreaterThanOrEqual(2_000);
    expect(Math.min(...gaps(a.server.ofType('poll').map((s) => s.t)))).toBeGreaterThanOrEqual(
      45_000,
    );
    // ~4 h at ≥ 45 s: no more than 4 * 80 polls.
    expect(a.server.ofType('poll').length).toBeLessThanOrEqual(320);
  });

  it('depends on the injected clock only', () => {
    const clock = new ManualClock(T0);
    const t = new HoppieTransport({
      logon: LOGON,
      http: new FakeHoppie(clock),
      clock,
      rng: createRng(1),
    });
    t.tick();
    expect(t.status).toBe('idle');
  });
});
