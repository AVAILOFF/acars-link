// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_EXE,
  BRIDGE_TOKEN_ENV,
  type BridgeExit,
  bridgeArgs,
  bridgeEnv,
  bridgeExePath,
  startBridge,
} from '../src/main/bridge-process.js';
import { tempDir } from './support.js';

describe('bridge process', () => {
  it('looks for the exe in resources/bridge', () => {
    expect(bridgeExePath('/res').replaceAll('\\', '/')).toBe(`/res/bridge/${BRIDGE_EXE}`);
  });

  it('does nothing when the exe is not there (dev run)', () => {
    expect(startBridge('/no/such/resources', 47830, 'auto', 'tok')).toBeNull();
  });

  it('"Automatic" is the bridge default (T59); MSFS and X-Plane are fixed with --source', () => {
    expect(bridgeArgs(47830, 'auto', 7)).toEqual(['--port', '47830', '--parent-pid', '7']);
    expect(bridgeArgs(47830, 'msfs', 7)).toEqual([
      '--port',
      '47830',
      '--parent-pid',
      '7',
      '--source',
      'simconnect',
    ]);
    expect(bridgeArgs(47831, 'xplane', 7)).toEqual([
      '--port',
      '47831',
      '--parent-pid',
      '7',
      '--source',
      'xplane',
    ]);
  });

  it('T80: the bridge is told the PID of the main process, so it stops with it', () => {
    for (const sim of ['auto', 'msfs', 'xplane'] as const) {
      const args = bridgeArgs(47830, sim, 4242);
      expect(args[args.indexOf('--parent-pid') + 1]).toBe('4242');
    }
  });

  // T67: Node itself stands in for the bridge exe; it refuses `--port` on stderr and exits.
  it.runIf(process.platform === 'win32')(
    'T67: the output of the bridge reaches the log line by line, the exit too',
    async () => {
      const res = await tempDir();
      mkdirSync(join(res, 'bridge'));
      copyFileSync(process.execPath, bridgeExePath(res));
      const lines: string[] = [];
      const logged: string[] = [];
      const exits: BridgeExit[] = [];
      const stop = startBridge(
        res,
        47830,
        'auto',
        'tok',
        (m) => logged.push(m),
        (stream, line) => lines.push(`${stream} ${line}`),
        (exit) => exits.push(exit),
      );
      expect(stop).not.toBeNull();
      // It exits on its own; `stop` would kill it before it writes.
      await vi.waitFor(() => expect(logged.at(-1)).toMatch(/^bridge exited/), { timeout: 20_000 });
      await stop?.();
      expect(lines.some((l) => l.startsWith('err ') && l.includes('--port'))).toBe(true);
      expect(logged.at(-1)).toMatch(/^bridge exited \(\d+\)$/);
      // T75: the exit code reaches the supervisor, once.
      expect(exits).toHaveLength(1);
      expect(exits[0]?.code).not.toBe(0);
      expect(exits[0]?.error).toBeNull();
    },
    30_000,
  );

  it('T65: the launch token goes in the environment, never on the command line', () => {
    expect(bridgeEnv({ PATH: 'p' }, 'tok-123')).toEqual({
      PATH: 'p',
      [BRIDGE_TOKEN_ENV]: 'tok-123',
    });
    for (const sim of ['auto', 'msfs', 'xplane'] as const) {
      expect(bridgeArgs(47830, sim, 7).join(' ')).not.toContain('tok-123');
    }
  });
});
