// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { Clock } from '@acars/core';
import { isValidCallsign } from './hoppie/protocol.js';
import type {
  InboundMessage,
  OutgoingTelex,
  Transport,
  TransportEvent,
  TransportStatus,
} from './types.js';

export interface MockSent {
  readonly id: string;
  readonly t: number;
  readonly telex: OutgoingTelex;
}

/**
 * In-memory transport for tests and offline runs: every queued telex is "delivered" on the
 * next `tick()`, scripted failures and pilot messages are injected by the test.
 */
export class MockTransport implements Transport {
  readonly kind = 'mock' as const;
  /** Delivered telexes, oldest first. */
  readonly sent: MockSent[] = [];
  private readonly queue: { id: string; telex: OutgoingTelex }[] = [];
  private readonly inbox: InboundMessage[] = [];
  private events: TransportEvent[] = [];
  private failures: string[] = [];
  private current: TransportStatus = 'idle';
  private seq = 0;
  /** Last {@link Transport.expectReply} duration, for assertions. */
  lastExpectReplyMs: number | null = null;
  /** ATC callsigns from the last {@link Transport.listen}, for assertions. */
  listening: readonly string[] = [];

  constructor(private readonly clock: Clock) {}

  get status(): TransportStatus {
    return this.current;
  }

  get pending(): number {
    return this.queue.length;
  }

  send(telex: OutgoingTelex): string {
    for (const cs of [telex.from, telex.to]) {
      if (!isValidCallsign(cs)) throw new TypeError(`invalid callsign "${cs}"`);
    }
    this.seq++;
    const id = `mock-${this.seq}`;
    this.queue.push({ id, telex });
    return id;
  }

  expectReply(durationMs: number): void {
    this.lastExpectReplyMs = durationMs;
  }

  listen(callsigns: readonly string[]): void {
    for (const cs of callsigns) {
      if (!isValidCallsign(cs)) throw new TypeError(`invalid callsign "${cs}"`);
    }
    this.listening = [...callsigns];
  }

  /** The next queued telexes fail permanently with these reasons, one each. */
  failNext(...reasons: string[]): void {
    this.failures.push(...reasons);
  }

  /** A message from the network, reported on the next tick. */
  deliver(message: InboundMessage): void {
    this.inbox.push(message);
  }

  /** Simulates a fatal error (e.g. bad logon code). */
  halt(reason: string): void {
    this.setStatus('halted', reason);
  }

  tick(): void {
    if (this.current === 'halted') return;
    const t = this.clock.now();
    for (const q of this.queue.splice(0)) {
      const reason = this.failures.shift();
      if (reason === undefined) {
        this.sent.push({ id: q.id, t, telex: q.telex });
        this.events.push({ type: 'SENT', id: q.id, t });
      } else {
        this.events.push({ type: 'SEND_FAILED', id: q.id, t, reason });
      }
      this.setStatus('ok');
    }
    for (const message of this.inbox.splice(0)) this.events.push({ type: 'INBOUND', t, message });
  }

  takeEvents(): TransportEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  resume(): void {
    if (this.current === 'halted') this.setStatus('idle');
  }

  idle(): Promise<void> {
    return Promise.resolve();
  }

  private setStatus(status: TransportStatus, reason?: string): void {
    if (status === this.current) return;
    this.current = status;
    const t = this.clock.now();
    this.events.push(
      reason === undefined ? { type: 'STATUS', t, status } : { type: 'STATUS', t, status, reason },
    );
  }
}
