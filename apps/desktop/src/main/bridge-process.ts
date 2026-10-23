import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Simulator } from '../shared/api.js';

/** Name of the self-contained bridge exe from `pnpm bridge:publish`. */
export const BRIDGE_EXE = 'acars-msfs-bridge.exe';

/** Where electron-builder puts the bridge (`extraResources`, electron-builder.yml). */
export function bridgeExePath(resourcesPath: string): string {
  return join(resourcesPath, 'bridge', BRIDGE_EXE);
}

/** Command line of the bridge (bridge/msfs/README.md): MSFS is its default source, X-Plane is `--source xplane` (T18). */
export function bridgeArgs(port: number, simulator: Simulator): string[] {
  const args = ['--port', String(port)];
  return simulator === 'xplane' ? [...args, '--source', 'xplane'] : args;
}

/**
 * Starts the bundled bridge next to the app, hidden, and returns a stop function that resolves once
 * the process has exited (so a new one can take the port). Returns null when there is no exe (dev
 * run: the bridge is started by hand) or it cannot start. If the port is already taken (a bridge
 * started by hand), the new process exits on its own and the app simply connects to the running one.
 */
export function startBridge(
  resourcesPath: string,
  port: number,
  simulator: Simulator = 'msfs',
  log: (msg: string) => void = console.error,
): (() => Promise<void>) | null {
  const exe = bridgeExePath(resourcesPath);
  if (!existsSync(exe)) return null;
  let child: ChildProcess;
  try {
    child = spawn(exe, bridgeArgs(port, simulator), {
      cwd: join(resourcesPath, 'bridge'),
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch (e) {
    log(`bridge did not start: ${String(e)}`);
    return null;
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
