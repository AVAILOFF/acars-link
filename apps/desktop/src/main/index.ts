// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { randomInt } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRng } from '@acars/core';
import { ROUTES_CACHE_PREFIX, ROUTES_RETENTION_MS } from '@acars/data-sources';
import { fetchHttpClient, HoppieTransport, MockTransport } from '@acars/transport';
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  safeStorage,
  session,
  shell,
} from 'electron';
import { type AppState, IPC, type SimChoice } from '../shared/api.js';
import type { SocketLike } from './bridge.js';
import { startBridge } from './bridge-process.js';
import { CLOSE_BUTTON, closeDialog } from './close-dialog.js';
import { AppController } from './controller.js';
import { FileDataCache } from './data-cache.js';
import { FlagsStore } from './flags.js';
import { registerIpc } from './ipc.js';
import { migrateOldUserData, OLD_APP_DIR } from './migrate.js';
import { fileRecordings, fileResume, purgeOldConnex } from './recording.js';
import { BASE_SCENARIOS } from './scenario-sources.js';
import { type Cipher, SecretStore } from './secrets.js';
import { defaultSettings, SettingsStore } from './settings.js';
import { holdSingleInstance } from './single-instance.js';
import { gsxVdgsDir } from './vdgs.js';

/**
 * Electron main process: window, security settings, IPC and the 1 Hz main loop that drives
 * the core and the transport (business logic never runs on UI timers, invariant 5).
 */

const TICK_MS = 1_000;
const here = import.meta.dirname;
const devUrl = process.env['ELECTRON_RENDERER_URL'];
const rendererFile = join(here, '../renderer/index.html');

const cipher: Cipher = {
  available: () => safeStorage.isAsyncEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptStringAsync(plain),
  decrypt: async (data) => (await safeStorage.decryptStringAsync(Buffer.from(data))).result,
};

let win: BrowserWindow | null = null;
let lastSent = '';

function pushState(state: AppState): void {
  if (win === null || win.isDestroyed()) return;
  const json = JSON.stringify(state);
  if (json === lastSent) return;
  lastSent = json;
  win.webContents.send(IPC.state, state);
}

/** Only our own page may call the API. */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  if (devUrl !== undefined && url.startsWith(devUrl)) return true;
  try {
    return (
      new URL(url).protocol === 'file:' &&
      decodeURIComponent(new URL(url).pathname)
        .replaceAll('\\', '/')
        .endsWith('/renderer/index.html')
    );
  } catch {
    return false;
  }
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 860,
    minHeight: 600,
    backgroundColor: '#0d1117',
    title: 'ACARS Link',
    // Packaged: the window takes the exe icon (electron-builder.yml); dev runs electron.exe.
    ...(app.isPackaged ? {} : { icon: join(here, '../../build/icon.ico') }),
    // One piece with the app: no menu bar; the window buttons sit in the top bar (--shell-1).
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#1e2128', symbolColor: '#ffffff', height: 52 },
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  // No pop-ups, no navigation away from the app; external links open in the browser.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  // A dead or hung renderer must not leave a blank window; the flight runs in this process.
  const reload = (why: string) => {
    console.error(`renderer ${why}, reloading the window`);
    if (w.isDestroyed()) return;
    lastSent = '';
    w.webContents.reload();
  };
  w.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit') reload(`gone (${details.reason})`);
  });
  w.on('unresponsive', () => reload('unresponsive'));
  if (devUrl !== undefined) void w.loadURL(devUrl);
  else void w.loadFile(rendererFile);
  return w;
}

async function main(): Promise<void> {
  // T66: a second start quits here, before any network request or bridge, and shows our window.
  if (!holdSingleInstance(app, () => win)) return;
  await app.whenReady();
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));

  const userData = app.getPath('userData');
  // The rename «ACARS Sim» → «ACARS Link» moved the user data; bring it over once.
  try {
    await migrateOldUserData(join(app.getPath('appData'), OLD_APP_DIR), userData);
  } catch (e) {
    console.error('user data migration failed:', e instanceof Error ? e.message : e);
  }
  const recordings = join(userData, 'recordings');
  // T30 C9: AeroDataBox data older than 7 days leave the recordings.
  purgeOldConnex(recordings, Date.now());
  // T55 R5: AeroDataBox route statistics older than 7 days leave the data cache.
  const dataCache = new FileDataCache(join(userData, 'cache'));
  await dataCache.purgeOlder(ROUTES_CACHE_PREFIX, ROUTES_RETENTION_MS, Date.now());
  const http = fetchHttpClient();
  const clock = { now: () => Date.now() };
  const settingsStore = new SettingsStore(
    join(userData, 'settings.json'),
    defaultSettings(app.getLocale()),
  );
  // Installed build only (dev: the bridge is started by hand). One start at a time: the old process
  // leaves the port before the new one takes it.
  let stopBridge: (() => Promise<void>) | null = null;
  let bridgeQueue = Promise.resolve();
  const restartBridge = (port: number, simulator: SimChoice) => {
    if (!app.isPackaged) return;
    bridgeQueue = bridgeQueue.then(async () => {
      await stopBridge?.();
      stopBridge = startBridge(process.resourcesPath, port, simulator);
    });
  };
  let controller: AppController | null = null;
  const onChange = () => {
    if (controller !== null) pushState(controller.state());
  };
  controller = new AppController({
    secrets: new SecretStore(join(userData, 'secrets.json'), cipher),
    settings: settingsStore,
    scenarioSources: BASE_SCENARIOS,
    http,
    createTransport: (choice) =>
      choice.kind === 'hoppie'
        ? new HoppieTransport({
            logon: choice.logon,
            http,
            clock,
            // Poll jitter only; flight determinism comes from the core seed.
            rng: createRng(randomInt(2 ** 31)),
          })
        : new MockTransport(clock),
    // Node's WHATWG WebSocket; the bridge accepts clients without an Origin header.
    createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as never) },
    now: clock.now,
    openRecording: fileRecordings(recordings),
    resume: fileResume(recordings),
    revealRecordings: async () => {
      await mkdir(recordings, { recursive: true });
      const error = await shell.openPath(recordings);
      if (error !== '') throw new Error(error);
    },
    onChange,
    dataCache,
    flags: new FlagsStore(join(userData, 'airline-memory.json')),
    vdgsDir: gsxVdgsDir(app.getPath('appData')),
    onBridgeConfig: (port, simulator) => restartBridge(port, simulator),
  });
  const ctl = controller;
  registerIpc(ipcMain, ctl, isTrustedSender);
  await ctl.init();
  // Installed build: the bridge exe lies in resources/bridge; start it before the client connects.
  const boot = await settingsStore.get();
  restartBridge(boot.bridgePort, boot.simChoice);

  win = createWindow();
  // U-03: ask before the window takes the flight away; T64: it goes on at the next start.
  win.on('close', (e) => {
    const w = win;
    if (w === null || !ctl.closeWouldLose) return;
    if (dialog.showMessageBoxSync(w, closeDialog(ctl.language, ctl.canResume)) !== CLOSE_BUTTON) {
      e.preventDefault();
    }
  });
  win.on('closed', () => {
    win = null;
    lastSent = '';
  });
  const loop = setInterval(() => ctl.tick(Date.now()), TICK_MS);

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    clearInterval(loop);
    ctl.dispose();
    void stopBridge?.();
  });
}

void main();
