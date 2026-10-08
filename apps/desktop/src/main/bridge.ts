import { isTelemetrySnapshot, TELEMETRY_VERSION, type TelemetrySnapshot } from '@acars/core';
import type { BridgeView } from '../shared/api.js';

/**
 * WebSocket client of the sim bridge (bridge/msfs/README.md, protocol v1): `hello`, then
 * `status` on every change and `telemetry` at ~1 Hz. Connects to 127.0.0.1 only
 * (CLAUDE.md, invariant 10) and reconnects with backoff 1, 2, 4, 8, 16, 30, 30 … s, like the
 * bridge does towards the sim.
 */

export const BRIDGE_PROTOCOL = 1;
export const RECONNECT_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

/** The part of the WHATWG WebSocket the client uses (Node/Electron global `WebSocket`). */
export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { readonly data: unknown }) => void) | null;
  onclose: ((ev: { readonly code: number; readonly reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(code?: number, reason?: string): void;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface BridgeClientOptions {
  readonly port: number;
  readonly createSocket: (url: string) => SocketLike;
  readonly timers: Timers;
  readonly now: () => number;
  readonly onTelemetry: (s: TelemetrySnapshot) => void;
  /** Any change of {@link BridgeClient.view}. */
  readonly onChange: () => void;
}

export function bridgeUrl(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError(`bad port ${port}`);
  return `ws://127.0.0.1:${port}/`;
}

const INITIAL_VIEW: BridgeView = {
  link: 'closed',
  sim: null,
  running: false,
  paused: false,
  simRate: 1,
  detail: null,
  retryAt: null,
};

export class BridgeClient {
  private socket: SocketLike | null = null;
  private retry: unknown = null;
  private attempt = 0;
  private helloSeen = false;
  private stopped = true;
  private port: number;
  private v: BridgeView = INITIAL_VIEW;

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
      socket = this.o.createSocket(bridgeUrl(this.port));
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
      if (m['protocol'] !== BRIDGE_PROTOCOL || m['telemetryVersion'] !== TELEMETRY_VERSION) {
        this.fail(
          `incompatible bridge: protocol ${String(m['protocol'])}, telemetry ${String(m['telemetryVersion'])}`,
        );
        return;
      }
      this.helloSeen = true;
      this.attempt = 0;
      return;
    }
    if (!this.helloSeen) return;
    if (m['type'] === 'status') {
      const sim = m['sim'];
      this.set({
        ...this.v,
        sim: sim === 'connected' || sim === 'connecting' ? sim : 'disconnected',
        running: m['running'] === true,
        paused: m['paused'] === true,
        simRate: typeof m['simRate'] === 'number' && m['simRate'] > 0 ? m['simRate'] : 1,
      });
    } else if (m['type'] === 'telemetry' && isTelemetrySnapshot(m['data'])) {
      this.o.onTelemetry(m['data']);
    }
  }

  /** Protocol error: close and retry later with the error shown. */
  private fail(detail: string): void {
    this.set({ ...this.v, detail });
    const s = this.socket;
    this.socket = null;
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
    if (s === null) return;
    s.onopen = s.onmessage = s.onerror = s.onclose = null;
    s.close();
  }

  private set(v: BridgeView): void {
    this.v = v;
    this.o.onChange();
  }
}
