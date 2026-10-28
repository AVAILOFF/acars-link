// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { createRng, DEFAULT_PROFILE, formatMessage, ManualClock } from '@acars/core';
import {
  HoppieTransport,
  type HoppieTransportOptions,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  type OutgoingTelex,
  type TransportEvent,
} from '../src/index.js';

export const LOGON = 'sEcReT9logon';
export const T0 = Date.UTC(2026, 9, 8, 8, 0, 0);

export interface Seen {
  readonly t: number;
  readonly req: HttpRequest;
  readonly params: Readonly<Record<string, string>>;
}

/** What the fake server does with one request. */
export type Reply = string | { status: number; body?: string } | { reject: Error };
export type Handler = (params: Readonly<Record<string, string>>) => Reply;

/** Fake Hoppie server: records every request (with the clock time) and answers via a handler. */
export class FakeHoppie implements HttpClient {
  readonly seen: Seen[] = [];
  handler: Handler = () => 'ok';

  constructor(private readonly clock: ManualClock) {}

  async request(req: HttpRequest): Promise<HttpResponse> {
    const url = new URL(req.url);
    const params: Record<string, string> = Object.fromEntries(url.searchParams);
    if (req.body !== undefined)
      Object.assign(params, Object.fromEntries(new URLSearchParams(req.body)));
    this.seen.push({ t: this.clock.now(), req, params });
    const reply = this.handler(params);
    if (typeof reply === 'string') return { status: 200, body: reply };
    if ('reject' in reply) throw reply.reject;
    return { status: reply.status, body: reply.body ?? '' };
  }

  ofType(type: string): Seen[] {
    return this.seen.filter((s) => s.params['type'] === type);
  }
}

export function setup(options: Partial<HoppieTransportOptions> = {}, seed = 'T09') {
  const clock = new ManualClock(T0);
  const server = new FakeHoppie(clock);
  const transport = new HoppieTransport({
    logon: LOGON,
    http: server,
    clock,
    rng: createRng(seed),
    ...options,
  });
  const events: TransportEvent[] = [];
  /** Advances the clock in `stepMs` steps for `ms`, ticking and settling every step. */
  async function run(ms: number, stepMs = 1_000): Promise<void> {
    for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
      clock.advance(stepMs);
      transport.tick();
      await transport.idle();
      events.push(...transport.takeEvents());
    }
  }
  return { clock, server, transport, events, run };
}

export function telex(text: string, from = 'OPSDLH4', to = 'DLH4'): OutgoingTelex {
  return { from, to, message: formatMessage(text, DEFAULT_PROFILE) };
}
