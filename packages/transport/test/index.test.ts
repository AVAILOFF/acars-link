import { DEFAULT_PROFILE, formatMessage, ManualClock } from '@acars/core';
import { describe, expect, it } from 'vitest';
import { MockTransport, TRANSPORT_PACKAGE, type Transport } from '../src/index.js';

describe('@acars/transport', () => {
  it('exports its package marker', () => {
    expect(TRANSPORT_PACKAGE).toBe('@acars/transport');
  });
});

describe('MockTransport', () => {
  const telex = (text: string) => ({
    from: 'OPSDLH4',
    to: 'DLH4',
    message: formatMessage(text, DEFAULT_PROFILE),
  });

  it('delivers queued telexes on tick, with scripted failures and inbound', () => {
    const clock = new ManualClock(1_000);
    const mock = new MockTransport(clock);
    const t: Transport = mock;
    const a = t.send(telex('ONE'));
    const b = t.send(telex('TWO'));
    mock.failNext('boom');
    mock.deliver({ from: 'DLH4', to: 'OPSDLH4', type: 'telex', packet: 'WILCO' });
    expect(t.pending).toBe(2);
    clock.advance(1_000);
    t.tick();
    expect(t.takeEvents()).toEqual([
      { type: 'SEND_FAILED', id: a, t: 2_000, reason: 'boom' },
      { type: 'STATUS', t: 2_000, status: 'ok' },
      { type: 'SENT', id: b, t: 2_000 },
      {
        type: 'INBOUND',
        t: 2_000,
        message: { from: 'DLH4', to: 'OPSDLH4', type: 'telex', packet: 'WILCO' },
      },
    ]);
    expect(mock.sent.map((s) => s.telex.message.text)).toEqual(['TWO']);
    expect(t.takeEvents()).toEqual([]);
  });

  it('halts and resumes like a real transport', () => {
    const clock = new ManualClock(0);
    const mock = new MockTransport(clock);
    mock.halt('invalid logon code');
    mock.send(telex('X'));
    mock.tick();
    expect(mock.sent).toHaveLength(0);
    mock.resume();
    mock.tick();
    expect(mock.sent).toHaveLength(1);
    expect(mock.takeEvents().map((e) => e.type)).toEqual(['STATUS', 'STATUS', 'SENT', 'STATUS']);
    expect(() => mock.send({ ...telex('X'), to: 'bad one' })).toThrow(TypeError);
  });
});
