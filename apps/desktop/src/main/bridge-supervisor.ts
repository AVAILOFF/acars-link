// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { BridgeProcessView, SimChoice } from '../shared/api.js';
import type { Timers } from './bridge.js';
import type { BridgeExit } from './bridge-process.js';
import { type Log, NO_LOG } from './log.js';

/**
 * Supervision of the bundled bridge process (T75). An exit nobody asked for starts it again after
 * 1, 2, 4 … 30 s, at most 5 times in 5 minutes; then it stays stopped ("the bridge does not start")
 * until the app or the bridge settings are restarted. Exit code 4 (the port is taken by another
 * program) is not repeated at all. The flight is not touched: the app only waits for the bridge.
 */

/** Exit code of the bridge when it cannot take its port (`bridge/msfs` `ExitCodes.PortInUse`). */
export const EXIT_PORT_IN_USE = 4;
/** Restarts allowed within the window. */
export const RESTART_LIMIT = 5;
export const RESTART_WINDOW_MS = 5 * 60_000;
export const RESTART_BASE_MS = 1_000;
export const RESTART_MAX_MS = 30_000;
/** Last lines of the bridge output kept for the "does not start" message. */
export const TAIL_LINES = 6;
const TAIL_LINE_MAX = 200;

export type RestartDecision =
  | { readonly restart: true; readonly delayMs: number }
  | { readonly restart: false };

/**
 * `exits`: the times of the unexpected exits so far, the one that just happened last. Pure: time comes
 * in as data. The pause doubles with every exit inside the window; the sixth in a row gives up.
 */
export function restartDecision(exits: readonly number[], now: number): RestartDecision {
  const recent = exits.filter((t) => now - t < RESTART_WINDOW_MS).length;
  if (recent > RESTART_LIMIT) return { restart: false };
  return {
    restart: true,
    delayMs: Math.min(RESTART_BASE_MS * 2 ** Math.max(recent - 1, 0), RESTART_MAX_MS),
  };
}

/** What `startBridge` offers a supervisor: the output of the process and its exit. */
export interface SpawnHooks {
  readonly onLine: (stream: 'out' | 'err', line: string) => void;
  readonly onExit: (exit: BridgeExit) => void;
}

/** Starts one bridge process; returns its stop function, or null when it cannot (no exe). */
export type SpawnBridge = (
  port: number,
  simulator: SimChoice,
  hooks: SpawnHooks,
) => (() => Promise<void>) | null;

export interface SupervisorOptions {
  readonly spawn: SpawnBridge;
  readonly timers: Timers;
  readonly now: () => number;
  /** Masks secrets in the lines shown to the user (the log does the same on its way). */
  readonly redact?: (text: string) => string;
  /** The state changed; null = nothing to report (running, or not supervised). */
  readonly onStatus: (status: BridgeProcessView | null) => void;
  /** The process was started again after an exit. */
  readonly onRestarted: () => void;
  readonly log?: Log;
}

export class BridgeSupervisor {
  private stopFn: (() => Promise<void>) | null = null;
  private port = 0;
  private simulator: SimChoice = 'auto';
  /** Which process the callbacks belong to: an exit of an older one is not news. */
  private generation = 0;
  private stopping = false;
  private exits: number[] = [];
  private timer: unknown = null;
  private tail: string[] = [];

  constructor(private readonly o: SupervisorOptions) {}

  /**
   * Starts the bridge anew (also the first time): forgets earlier failures. False when there is no exe
   * to start (a dev run: the bridge is started by hand).
   */
  start(port: number, simulator: SimChoice): boolean {
    this.port = port;
    this.simulator = simulator;
    this.exits = [];
    this.tail = [];
    this.stopping = false;
    this.o.onStatus(null);
    this.launch();
    return this.stopFn !== null;
  }

  /** Stops the process and any pending restart; resolves once the process has gone. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.generation++;
    this.clearTimer();
    const stop = this.stopFn;
    this.stopFn = null;
    await stop?.();
    this.o.onStatus(null);
  }

  private launch(): void {
    const generation = ++this.generation;
    this.stopFn = this.o.spawn(this.port, this.simulator, {
      onLine: (_stream, line) => {
        if (generation === this.generation) this.note(line);
      },
      onExit: (exit) => {
        if (generation === this.generation) this.exited(exit);
      },
    });
  }

  private note(line: string): void {
    const text = (this.o.redact?.(line) ?? line).trim();
    if (text === '') return;
    this.tail.push(text.length > TAIL_LINE_MAX ? `${text.slice(0, TAIL_LINE_MAX)}…` : text);
    if (this.tail.length > TAIL_LINES) this.tail.shift();
  }

  private exited(exit: BridgeExit): void {
    if (this.stopping) return;
    const log = this.o.log ?? NO_LOG;
    this.stopFn = null;
    if (exit.code === EXIT_PORT_IN_USE) {
      log.warn(`bridge: port ${this.port} is in use by another program, not restarting`);
      this.o.onStatus({ kind: 'port_in_use', port: this.port });
      return;
    }
    const now = this.o.now();
    this.exits = [...this.exits.filter((t) => now - t < RESTART_WINDOW_MS), now];
    const decision = restartDecision(this.exits, now);
    if (!decision.restart) {
      const lastLines = this.tail.join('\n');
      log.error(`bridge: keeps stopping (${RESTART_LIMIT} restarts in 5 minutes), giving up`);
      this.o.onStatus({ kind: 'failed', lastLines });
      return;
    }
    log.warn(
      `bridge: stopped unexpectedly (${exit.error ?? `code ${String(exit.code)}`}), ` +
        `starting again in ${decision.delayMs / 1000} s`,
    );
    this.o.onStatus({ kind: 'restarting', attempt: this.exits.length });
    this.clearTimer();
    this.timer = this.o.timers.set(() => {
      this.timer = null;
      if (this.stopping) return;
      this.o.onStatus(null);
      this.launch();
      if (this.stopFn === null) {
        // The exe is gone (removed, or the system refused to start it): nothing more to wait for.
        log.error('bridge: could not be started again');
        this.o.onStatus({ kind: 'failed', lastLines: this.tail.join('\n') });
        return;
      }
      this.o.onRestarted();
    }, decision.delayMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.o.timers.clear(this.timer);
    this.timer = null;
  }
}
