// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { describe, expect, it } from 'vitest';
import {
  BridgeSupervisor,
  EXIT_PORT_IN_USE,
  RESTART_LIMIT,
  RESTART_MAX_MS,
  RESTART_WINDOW_MS,
  restartDecision,
  type SpawnHooks,
  TAIL_LINES,
} from '../src/main/bridge-supervisor.js';
import type { BridgeProcessView, SimChoice } from '../src/shared/api.js';
import { FakeTimers } from './support.js';

/** T75: the bundled bridge is started again after it stops by itself, and left alone when it cannot start. */

describe('restartDecision', () => {
  const at = (...times: number[]) => restartDecision(times, times.at(-1) ?? 0);
  const stops = (n: number, t0 = 1_000_000) => Array.from({ length: n }, (_, i) => t0 + i * 10_000);

  it('pauses 1, 2, 4, 8, 16 s for the first five stops, the sixth in 5 minutes gives up', () => {
    const delays = [1, 2, 3, 4, 5].map((n) => at(...stops(n)));
    expect(delays).toEqual(
      [1000, 2000, 4000, 8000, 16000].map((delayMs) => ({ restart: true, delayMs })),
    );
    expect(at(...stops(RESTART_LIMIT + 1))).toEqual({ restart: false });
  });

  it('stops outside the 5 minute window do not count: back to 1 s', () => {
    const t0 = 1_000_000;
    const later = t0 + 2000 + RESTART_WINDOW_MS + 1;
    expect(restartDecision([t0, t0 + 1000, t0 + 2000, later], later)).toEqual({
      restart: true,
      delayMs: 1000,
    });
  });

  it('the pause never exceeds 30 s', () => {
    expect(RESTART_MAX_MS).toBe(30_000);
  });
});

/** A supervisor on a fake process factory, fake timers and a manual clock. */
function setup() {
  const timers = new FakeTimers();
  let now = 1_000_000;
  const spawns: {
    port: number;
    simulator: SimChoice;
    hooks: SpawnHooks;
    stopped: boolean;
  }[] = [];
  let noExe = false;
  const statuses: (BridgeProcessView | null)[] = [];
  let restarted = 0;
  const sup = new BridgeSupervisor({
    spawn: (port, simulator, hooks) => {
      if (noExe) return null;
      const p = { port, simulator, hooks, stopped: false };
      spawns.push(p);
      return async () => {
        p.stopped = true;
      };
    },
    timers,
    now: () => now,
    redact: (t) => t.replaceAll('SECRET', '***'),
    onStatus: (s) => statuses.push(s),
    onRestarted: () => restarted++,
  });
  return {
    sup,
    timers,
    spawns,
    statuses,
    restarted: () => restarted,
    last: () => spawns.at(-1) as (typeof spawns)[number],
    crash: (code: number | null = 1) => spawns.at(-1)?.hooks.onExit({ code, error: null }),
    advance: (ms: number) => {
      now += ms;
    },
    setNoExe: (v: boolean) => {
      noExe = v;
    },
    status: () => statuses.at(-1),
  };
}

describe('BridgeSupervisor', () => {
  it('an exit nobody asked for starts the bridge again after 1 s, then 2 s; port and simulator stay', () => {
    const s = setup();
    expect(s.sup.start(47831, 'xplane')).toBe(true);
    expect(s.spawns).toHaveLength(1);

    s.crash(1);
    expect(s.status()).toEqual({ kind: 'restarting', attempt: 1 });
    expect(s.timers.pending.map((p) => p.ms)).toEqual([1000]);
    expect(s.spawns).toHaveLength(1); // not before the pause is over

    s.timers.runNext();
    expect(s.spawns).toHaveLength(2);
    expect(s.last()).toMatchObject({ port: 47831, simulator: 'xplane' });
    expect(s.status()).toBeNull();
    expect(s.restarted()).toBe(1);

    s.advance(5_000);
    s.crash(null);
    expect(s.timers.pending.map((p) => p.ms)).toEqual([2000]);
  });

  it('an error that keeps the process from starting counts as a stop too', () => {
    const s = setup();
    s.sup.start(47830, 'auto');
    s.last().hooks.onExit({ code: null, error: 'spawn UNKNOWN' });
    expect(s.status()).toEqual({ kind: 'restarting', attempt: 1 });
  });

  it('gives up after 5 restarts in 5 minutes, with the last lines of its output (secrets masked)', () => {
    const s = setup();
    s.sup.start(47830, 'auto');
    for (let n = 0; n < RESTART_LIMIT; n++) {
      s.advance(10_000);
      s.crash(1);
      expect(s.status()).toMatchObject({ kind: 'restarting' });
      s.timers.runNext();
    }
    expect(s.spawns).toHaveLength(1 + RESTART_LIMIT);
    for (let i = 1; i <= TAIL_LINES + 2; i++) {
      s.last().hooks.onLine('err', i === TAIL_LINES + 2 ? 'last SECRET line' : `line ${i}`);
    }
    s.last().hooks.onLine('out', '   ');
    s.advance(10_000);
    s.crash(1);

    const failed = s.status();
    expect(failed).toMatchObject({ kind: 'failed' });
    const lines = (failed as { lastLines: string }).lastLines.split('\n');
    expect(lines).toHaveLength(TAIL_LINES);
    expect(lines.at(-1)).toBe('last *** line');
    expect(lines[0]).toBe('line 3'); // 8 lines came, the last 6 stay
    expect(s.timers.pending).toEqual([]); // no more tries
    expect(s.spawns).toHaveLength(1 + RESTART_LIMIT);
  });

  it('exit code 4 (the port is taken): said so, never started again', () => {
    const s = setup();
    s.sup.start(47830, 'auto');
    s.crash(EXIT_PORT_IN_USE);
    expect(s.status()).toEqual({ kind: 'port_in_use', port: 47830 });
    expect(s.timers.pending).toEqual([]);
    expect(s.spawns).toHaveLength(1);
  });

  it('a stop asked for is not an unexpected exit; a pending restart is cancelled', async () => {
    const s = setup();
    s.sup.start(47830, 'auto');
    const first = s.last();
    await s.sup.stop();
    expect(first.stopped).toBe(true);
    first.hooks.onExit({ code: 1, error: null }); // the process ends after the stop
    expect(s.timers.pending).toEqual([]);
    expect(s.status()).toBeNull();

    s.sup.start(47830, 'auto');
    s.crash(1);
    expect(s.timers.pending).toHaveLength(1);
    await s.sup.stop();
    expect(s.timers.pending).toEqual([]);
    expect(s.spawns).toHaveLength(2);
    expect(s.restarted()).toBe(0);
  });

  it('start() again (new port or simulator in the settings) forgets earlier failures', () => {
    const s = setup();
    s.sup.start(47830, 'auto');
    for (let n = 0; n <= RESTART_LIMIT; n++) {
      s.crash(1);
      if (s.timers.pending.length > 0) s.timers.runNext();
    }
    expect(s.status()).toMatchObject({ kind: 'failed' });

    s.sup.start(47832, 'msfs');
    expect(s.status()).toBeNull();
    expect(s.last()).toMatchObject({ port: 47832, simulator: 'msfs' });
    s.crash(1);
    expect(s.timers.pending.map((p) => p.ms)).toEqual([1000]);
  });

  it('the exit of an older process is not news once a newer one runs', () => {
    const s = setup();
    s.sup.start(47830, 'auto');
    const old = s.last();
    s.crash(1);
    s.timers.runNext();
    old.hooks.onExit({ code: 1, error: null });
    old.hooks.onLine('err', 'stale');
    expect(s.timers.pending).toEqual([]);
    expect(s.spawns).toHaveLength(2);
  });

  it('no exe (a dev run): nothing to supervise', () => {
    const s = setup();
    s.setNoExe(true);
    expect(s.sup.start(47830, 'auto')).toBe(false);
    expect(s.status()).toBeNull();
  });

  it('the exe disappears between two tries: given up with the message, not a silent hang', () => {
    const s = setup();
    s.sup.start(47830, 'auto');
    s.crash(1);
    s.setNoExe(true);
    s.timers.runNext();
    expect(s.status()).toMatchObject({ kind: 'failed' });
    expect(s.restarted()).toBe(0);
  });

  it('a bridge that ran long enough starts again from 1 s', () => {
    const s = setup();
    s.sup.start(47830, 'auto');
    s.crash(1);
    s.timers.runNext();
    s.advance(RESTART_WINDOW_MS + 1000);
    s.crash(1);
    expect(s.timers.pending.map((p) => p.ms)).toEqual([1000]);
  });
});
