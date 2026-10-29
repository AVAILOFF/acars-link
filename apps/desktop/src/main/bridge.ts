// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import {
  checkSimCommand,
  isTelemetrySnapshot,
  type SimCommandArgs,
  type SimCommandName,
  TELEMETRY_VERSION,
  type TelemetrySnapshot,
} from '@acars/core';
import type { BridgeView, Simulator } from '../shared/api.js';

/**
 * WebSocket client of the sim bridge (bridge/msfs/README.md): `hello`, then `status` on every
 * change and `telemetry` at ~1 Hz. Connects to 127.0.0.1 only (CLAUDE.md, invariant 10) and
 * reconnects with backoff 1, 2, 4, 8, 16, 30, 30 … s, like the bridge does towards the sim.
 *
 * Asks for protocol v2 (`?protocol=2`): the bridge then lists its commands in `hello` and
 * answers each `command` with an `ack`. A v1 bridge ignores the query and says `protocol: 1`;
 * telemetry works as before and commands end with `unavailable`.
 *
 * T65: the bridge the app starts wants the launch token in {@link BRIDGE_TOKEN_HEADER} (a header,
 * not the URL, so it stays out of error texts and request logs); a bridge started by hand ignores it.
 */

export const BRIDGE_PROTOCOL = 2;
/** Header with the launch token (bridge `AccessPolicy.TokenHeader`). */
export const BRIDGE_TOKEN_HEADER = 'X-Acars-Bridge-Token';
/** Bridge versions this client understands. */
export const BRIDGE_PROTOCOLS: readonly number[] = [1, 2];
export const RECONNECT_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
/** Longer than the bridge's own command timeout (10 s), so the bridge's answer normally wins. */
export const COMMAND_TIMEOUT_MS = 15_000;

/**
 * How a command ended. `error`: the bridge's code (`bad_frame`, `unknown_command`, `bad_args`,
 * `unavailable`, `rate_limited`, `failed`) or the client's own: `unavailable` (no v2 bridge
 * connected, or the command is not offered), `bad_args` (refused before sending), `timeout`,
 * `disconnected` (the connection dropped before the answer).
 */
export interface CommandResult {
  readonly id: string;
  readonly command: SimCommandName;
  readonly ok: boolean;
  readonly error: string | null;
  readonly detail: string | null;
}

/** The part of the WHATWG WebSocket the client uses (Node/Electron global `WebSocket`). */
export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { readonly data: unknown }) => void) | null;
  onclose: ((ev: { readonly code: number; readonly reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface BridgeClientOptions {
  readonly port: number;
  /** Opens a socket to `url` with these extra request headers. */
  readonly createSocket: (url: string, headers: Readonly<Record<string, string>>) => SocketLike;
  /** Launch token of the bundled bridge (T65); absent or null = none sent. */
  readonly token?: string | null;
  readonly timers: Timers;
  readonly now: () => number;
  readonly onTelemetry: (s: TelemetrySnapshot) => void;
  /** Any change of {@link BridgeClient.view}. */
  readonly onChange: () => void;
  /** Every command sent with {@link BridgeClient.sendCommand} ends here exactly once. */
  readonly onCommandResult?: (r: CommandResult) => void;
}

export function bridgeUrl(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError(`bad port ${port}`);
  return `ws://127.0.0.1:${port}/?protocol=${BRIDGE_PROTOCOL}`;
}

/** Handshake headers: the launch token, if any. */
export function bridgeHeaders(token: string | null | undefined): Record<string, string> {
  return token === null || token === undefined || token === ''
    ? {}
    : { [BRIDGE_TOKEN_HEADER]: token };
}

interface Pending {
  readonly command: SimCommandName;
  readonly timer: unknown;
}

const INITIAL_VIEW: BridgeView = {
  link: 'closed',
  sim: null,
  running: false,
  paused: false,
  simRate: 1,
  detail: null,
  retryAt: null,
  protocol: null,
  commands: [],
  source: null,
};

/** Bridge source names (`hello.source`, `status.source`) → simulator; `auto`, `fake` and others → null. */
export function simOfSource(source: unknown): Simulator | null {
  return source === 'simconnect' ? 'msfs' : source === 'xplane' ? 'xplane' : null;
}

export class BridgeClient {
  private socket: SocketLike | null = null;
  private retry: unknown = null;
  private attempt = 0;
  private helloSeen = false;
  /** `hello.source` of a bridge with a fixed source (T59); null for `auto`. */
  private helloSim: Simulator | null = null;
  private stopped = true;
  private port: number;
  private v: BridgeView = INITIAL_VIEW;
  private seq = 0;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly o: BridgeClientOptions) {
    this.port = o.port;
  }

  get view(): BridgeView {
    return this.v;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearRetry();
    this.dropSocket();
    this.set({ ...INITIAL_VIEW });
  }

  /**
   * Sends a command to the sim; returns its id. The outcome always comes once through
   * `onCommandResult`: at once if it cannot be sent, else on the bridge's `ack`, a timeout or a
   * dropped connection. Never resent.
   */
  sendCommand(command: SimCommandName, args: SimCommandArgs = {}): string {
    this.seq++;
    const id = `c${this.seq}`;
    const why = checkSimCommand(command, args);
    if (why !== null) {
      this.finish(id, command, 'bad_args', why);
      return id;
    }
    const socket = this.socket;
    if (socket === null || this.v.protocol !== 2) {
      this.finish(id, command, 'unavailable', 'bridge takes no commands (not connected or v1)');
      return id;
    }
    if (!this.v.commands.includes(command)) {
      this.finish(id, command, 'unavailable', `bridge does not offer ${command}`);
      return id;
    }
    try {
      socket.send(JSON.stringify({ type: 'command', id, command, args }));
    } catch (e) {
      this.finish(id, command, 'disconnected', e instanceof Error ? e.message : String(e));
      return id;
    }
    const timer = this.o.timers.set(() => {
      this.pending.delete(id);
      this.finish(id, command, 'timeout', null);
    }, COMMAND_TIMEOUT_MS);
    this.pending.set(id, { command, timer });
    return id;
  }

  /** Commands sent and not answered yet. */
  get pendingCommands(): number {
    return this.pending.size;
  }

  private onAck(m: Record<string, unknown>): void {
    const id = m['id'];
    if (typeof id !== 'string') return; // a frame the bridge could not read: not one of ours
    const p = this.pending.get(id);
    if (p === undefined) return;
    this.pending.delete(id);
    this.o.timers.clear(p.timer);
    if (m['ok'] === true) {
      this.o.onCommandResult?.({ id, command: p.command, ok: true, error: null, detail: null });
      return;
    }
    const error = typeof m['error'] === 'string' ? m['error'] : 'failed';
    this.finish(id, p.command, error, typeof m['detail'] === 'string' ? m['detail'] : null);
  }

  private failPending(error: string): void {
    const all = [...this.pending];
    this.pending.clear();
    for (const [id, p] of all) {
      this.o.timers.clear(p.timer);
      this.finish(id, p.command, error, null);
    }
  }

  private finish(id: string, command: SimCommandName, error: string, detail: string | null): void {
    this.o.onCommandResult?.({ id, command, ok: false, error, detail });
  }

  /** Reconnects to another port right away. */
  setPort(port: number): void {
    if (port === this.port) return;
    this.port = port;
    if (this.stopped) return;
    this.clearRetry();
    this.dropSocket();
    this.attempt = 0;
    this.connect();
  }

  private connect(): void {
    this.retry = null;
    this.helloSeen = false;
    this.set({ ...INITIAL_VIEW, link: 'connecting' });
    let socket: SocketLike;
    try {
      socket = this.o.createSocket(bridgeUrl(this.port), bridgeHeaders(this.o.token));
    } catch (e) {
      this.scheduleRetry(e instanceof Error ? e.message : String(e));
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket === socket) this.set({ ...this.v, link: 'open' });
    };
    socket.onmessage = (ev) => {
      if (this.socket === socket) this.onFrame(ev.data);
    };
    socket.onerror = () => {
      // `close` follows and schedules the retry.
    };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.failPending('disconnected');
      this.scheduleRetry(this.v.detail ?? (ev.reason === '' ? null : ev.reason));
    };
  }

  private onFrame(data: unknown): void {
    let msg: unknown;
    try {
      msg = typeof data === 'string' ? JSON.parse(data) : null;
    } catch {
      msg = null;
    }
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as Record<string, unknown>;
    if (m['type'] === 'hello') {
      const protocol = m['protocol'];
      if (
        typeof protocol !== 'number' ||
        !BRIDGE_PROTOCOLS.includes(protocol) ||
        m['telemetryVersion'] !== TELEMETRY_VERSION
      ) {
        this.fail(
          `incompatible bridge: protocol ${String(protocol)}, telemetry ${String(m['telemetryVersion'])}`,
        );
        return;
      }
      const offered: unknown[] =
        protocol === 2 && Array.isArray(m['commands']) ? m['commands'] : [];
      this.helloSeen = true;
      this.helloSim = simOfSource(m['source']);
      this.attempt = 0;
      this.set({
        ...this.v,
        protocol: protocol === 2 ? 2 : 1,
        commands: offered.filter((c): c is string => typeof c === 'string'),
      });
      return;
    }
    if (!this.helloSeen) return;
    if (m['type'] === 'status') {
      const sim = m['sim'];
      this.set({
        ...this.v,
        sim: sim === 'connected' || sim === 'connecting' ? sim : 'disconnected',
        // T59: `status.source` (bridge `auto`); a bridge before T59 has a fixed source in `hello` only.
        source: sim === 'connected' ? (simOfSource(m['source']) ?? this.helloSim) : null,
        running: m['running'] === true,
        paused: m['paused'] === true,
        simRate: typeof m['simRate'] === 'number' && m['simRate'] > 0 ? m['simRate'] : 1,
      });
    } else if (m['type'] === 'telemetry' && isTelemetrySnapshot(m['data'])) {
      this.o.onTelemetry(m['data']);
    } else if (m['type'] === 'ack') {
      this.onAck(m);
    }
  }

  /** Protocol error: close and retry later with the error shown. */
  private fail(detail: string): void {
    this.set({ ...this.v, detail });
    const s = this.socket;
    this.socket = null;
    this.failPending('disconnected');
    s?.close(1002, 'protocol');
    this.scheduleRetry(detail);
  }

  private scheduleRetry(detail: string | null): void {
    if (this.stopped) return;
    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 30_000;
    this.attempt++;
    this.set({ ...INITIAL_VIEW, link: 'closed', detail, retryAt: this.o.now() + delay });
    this.retry = this.o.timers.set(() => this.connect(), delay);
  }

  private clearRetry(): void {
    if (this.retry !== null) this.o.timers.clear(this.retry);
    this.retry = null;
  }

  private dropSocket(): void {
    const s = this.socket;
    this.socket = null;
    this.failPending('disconnected');
    if (s === null) return;
    s.onopen = s.onmessage = s.onerror = s.onclose = null;
    s.close();
  }

  private set(v: BridgeView): void {
    this.v = v;
    this.o.onChange();
  }
}
