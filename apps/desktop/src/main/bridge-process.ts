// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { SimChoice } from '../shared/api.js';

/** Name of the self-contained bridge exe from `pnpm bridge:publish`. */
export const BRIDGE_EXE = 'acars-msfs-bridge.exe';

/** Where electron-builder puts the bridge (`extraResources`, electron-builder.yml). */
export function bridgeExePath(resourcesPath: string): string {
  return join(resourcesPath, 'bridge', BRIDGE_EXE);
}

/**
 * Command line of the bridge (bridge/msfs/README.md): its default source is `auto` (T59, whichever sim runs);
 * a fixed choice is `--source simconnect` or `--source xplane` (T18).
 */
export function bridgeArgs(port: number, simulator: SimChoice): string[] {
  const args = ['--port', String(port)];
  if (simulator === 'auto') return args;
  return [...args, '--source', simulator === 'xplane' ? 'xplane' : 'simconnect'];
}

/** Environment variable with the launch token (bridge `AccessPolicy.TokenVariable`, T65). */
export const BRIDGE_TOKEN_ENV = 'ACARS_BRIDGE_TOKEN';

/**
 * Environment of the bridge: ours plus the launch token. Not a command-line argument: Windows can keep
 * command lines in the audit log (event 4688) and process tools show them; the environment stays inside
 * the process (T65).
 */
export function bridgeEnv(base: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  return { ...base, [BRIDGE_TOKEN_ENV]: token };
}

/**
 * Starts the bundled bridge next to the app, hidden, and returns a stop function that resolves once
 * the process has exited (so a new one can take the port). Returns null when there is no exe (dev
 * run: the bridge is started by hand) or it cannot start. If the port is already taken (a bridge
 * started by hand), the new process exits on its own and the app simply connects to the running one.
 * The bridge lets in only clients with `token` (T65). Its stdout and stderr go to `output` line by
 * line (T67: `bridge.log`); without `output` they are not opened.
 */
export function startBridge(
  resourcesPath: string,
  port: number,
  simulator: SimChoice,
  token: string,
  log: (msg: string) => void = console.error,
  output?: (stream: 'out' | 'err', line: string) => void,
): (() => Promise<void>) | null {
  const exe = bridgeExePath(resourcesPath);
  if (!existsSync(exe)) return null;
  let child: ChildProcess;
  try {
    child = spawn(exe, bridgeArgs(port, simulator), {
      cwd: join(resourcesPath, 'bridge'),
      windowsHide: true,
      env: bridgeEnv(process.env, token),
      stdio: output === undefined ? 'ignore' : ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    log(`bridge did not start: ${String(e)}`);
    return null;
  }
  if (output !== undefined) {
    lines(child.stdout, (line) => output('out', line));
    lines(child.stderr, (line) => output('err', line));
  }
  const exited = new Promise<void>((resolve) => {
    child.on('exit', (code) => {
      log(`bridge exited (${String(code)})`);
      resolve();
    });
    child.on('error', (e) => {
      log(`bridge failed: ${e.message}`);
      resolve();
    });
  });
  return () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    return exited;
  };
}

/** Reads a pipe to its end, always (a full pipe would stall the bridge), one call per line. */
function lines(stream: Readable | null, fn: (line: string) => void): void {
  if (stream === null) return;
  stream.setEncoding('utf8');
  createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY }).on('line', fn);
}
