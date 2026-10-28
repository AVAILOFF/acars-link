// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpClient, HttpRequest } from '@acars/transport';
import type { SocketLike, Timers } from '../src/main/bridge.js';
import type { Cipher } from '../src/main/secrets.js';

export const OFP_FIXTURE = join(
  import.meta.dirname,
  '../../../packages/core/test/fixtures/ofp/rctp-rjbb-a35k-kgs.json',
);

export const tempDir = () => mkdtemp(join(tmpdir(), 'acars-desktop-'));

/** Reversible stand-in for the OS store; the output never contains the plain text. */
export class FakeCipher implements Cipher {
  ok = true;
  async available() {
    return this.ok;
  }
  async encrypt(plain: string) {
    return Buffer.from(`enc:${Buffer.from(plain).toString('hex').split('').reverse().join('')}`);
  }
  async decrypt(data: Uint8Array) {
    const s = Buffer.from(data).toString();
    if (!s.startsWith('enc:')) throw new Error('bad data');
    return Buffer.from(s.slice(4).split('').reverse().join(''), 'hex').toString();
  }
}

export class FakeHttp implements HttpClient {
  readonly requests: HttpRequest[] = [];
  constructor(public respond: (req: HttpRequest) => { status: number; body: string } | Error) {}
  async request(req: HttpRequest) {
    this.requests.push(req);
    const r = this.respond(req);
    if (r instanceof Error) throw r;
    return r;
  }
}

export async function simbriefOk(): Promise<FakeHttp> {
  const body = await readFile(OFP_FIXTURE, 'utf8');
  return new FakeHttp(() => ({ status: 200, body }));
}

export class FakeSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  closed: { code?: number; reason?: string } | null = null;
  /** Frames the client sent, parsed. */
  readonly sent: unknown[] = [];
  /** Set to make `send` throw. */
  sendError: Error | null = null;
  constructor(readonly url: string) {}
  send(data: string) {
    if (this.sendError !== null) throw this.sendError;
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string) {
    this.closed = {
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    };
  }
  open() {
    this.onopen?.();
  }
  frame(obj: unknown) {
    this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) });
  }
  drop(reason = '') {
    this.onclose?.({ code: 1006, reason });
  }
  /** Bridge `hello`; v2 lists `commands`, v1 has no such field. */
  hello(protocol = 2, telemetryVersion = 1, commands: readonly string[] = ['ping']) {
    this.open();
    this.frame({
      type: 'hello',
      protocol,
      telemetryVersion,
      bridge: 'acars-msfs-bridge',
      version: 't',
      source: 'fake',
      ...(protocol >= 2 ? { commands } : {}),
    });
  }
}

export class FakeTimers implements Timers {
  readonly pending: { fn: () => void; ms: number; id: number }[] = [];
  private seq = 0;
  set(fn: () => void, ms: number) {
    this.seq++;
    this.pending.push({ fn, ms, id: this.seq });
    return this.seq;
  }
  clear(h: unknown) {
    const i = this.pending.findIndex((p) => p.id === h);
    if (i >= 0) this.pending.splice(i, 1);
  }
  /** Runs the oldest timer; returns its delay. */
  runNext(): number {
    const p = this.pending.shift();
    if (p === undefined) throw new Error('no timer pending');
    p.fn();
    return p.ms;
  }
}

export function socketFactory() {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    create: (url: string) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    last: () => {
      const s = sockets.at(-1);
      if (s === undefined) throw new Error('no socket');
      return s;
    },
  };
}
