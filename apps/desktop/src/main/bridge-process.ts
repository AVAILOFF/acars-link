import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Name of the self-contained bridge exe from `pnpm bridge:publish`. */
export const BRIDGE_EXE = 'acars-msfs-bridge.exe';

/** Where electron-builder puts the bridge (`extraResources`, electron-builder.yml). */
export function bridgeExePath(resourcesPath: string): string {
  return join(resourcesPath, 'bridge', BRIDGE_EXE);
}

/**
 * Starts the bundled bridge next to the app, hidden, and returns a stop function.
 * Returns null when there is no exe (dev run: the bridge is started by hand) or it cannot start.
 * If the port is already taken (a bridge started by hand), the new process exits on its own
 * and the app simply connects to the running one.
 */
export function startBridge(
  resourcesPath: string,
  port: number,
  log: (msg: string) => void = console.error,
): (() => void) | null {
  const exe = bridgeExePath(resourcesPath);
  if (!existsSync(exe)) return null;
  let child: ChildProcess;
  try {
    child = spawn(exe, ['--port', String(port)], {
      cwd: join(resourcesPath, 'bridge'),
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch (e) {
    log(`bridge did not start: ${String(e)}`);
    return null;
  }
  child.on('error', (e) => log(`bridge failed: ${e.message}`));
  child.on('exit', (code) => log(`bridge exited (${String(code)})`));
  return () => {
    if (child.exitCode === null) child.kill();
  };
}
