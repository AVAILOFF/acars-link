// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { randomBytes, randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { arch, release } from 'node:os';
import { basename, join } from 'node:path';
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
import { BridgeSupervisor } from './bridge-supervisor.js';
import { CLOSE_BUTTON, closeDialog } from './close-dialog.js';
import { AppController } from './controller.js';
import { FileDataCache } from './data-cache.js';
import { FlagsStore } from './flags.js';
import { registerIpc } from './ipc.js';
import { legalFile } from './legal.js';
import {
  BRIDGE_LOG,
  type Log,
  Logger,
  MAIN_LOG,
  NO_LOG,
  Redactor,
  RotatingFile,
  watchProcess,
} from './log.js';
import { FileLogbook } from './logbook.js';
import { migrateOldUserData, OLD_APP_DIR } from './migrate.js';
import { fileRecordings, fileResume, latestRecording, purgeOldConnex } from './recording.js';
import { BASE_SCENARIOS, SCENARIO_LOCALES } from './scenario-sources.js';
import { type Cipher, SecretStore } from './secrets.js';
import { defaultSettings, SettingsStore } from './settings.js';
import { holdSingleInstance } from './single-instance.js';
import { SMOKE_PACKAGE, SmokePackage } from './smoke-package.js';
import { PUBLIC_BUILD } from './variant.js';
import { gsxVdgsDir } from './vdgs.js';

/**
 * Electron main process: window, security settings, IPC and the 1 Hz main loop that drives
 * the core and the transport (business logic never runs on UI timers, invariant 5).
 */

const TICK_MS = 1_000;
const here = import.meta.dirname;
const devUrl = process.env['ELECTRON_RENDERER_URL'];
const rendererFile = join(here, '../renderer/index.html');

/**
 * T65: launch token of the bundled bridge, new on every app start (256 bits). Lives in memory only:
 * passed to the bridge in its environment and sent in the handshake header, never logged or recorded.
 */
const bridgeToken = randomBytes(32).toString('base64url');

/**
 * T67: masks the secrets in every log line. Knows the bridge token from the start and every secret
 * the secret store reads or saves; the logs themselves open once the user-data folder is known.
 */
const redactor = new Redactor();
redactor.add(bridgeToken);
let log: Log = NO_LOG;

const cipher: Cipher = {
  available: () => safeStorage.isAsyncEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptStringAsync(plain),
  decrypt: async (data) => (await safeStorage.decryptStringAsync(Buffer.from(data))).result,
};

/**
 * Node's WHATWG WebSocket (undici): sends no Origin and takes extra handshake headers
 * (`WebSocketInit.headers`, T65). The DOM typings know only `protocols`.
 */
const NodeWebSocket = WebSocket as unknown as new (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>> },
) => SocketLike;

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
    log.error(`renderer ${why}, reloading the window`);
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
  const logDir = join(userData, 'logs');
  const mainLog = new RotatingFile(join(logDir, MAIN_LOG));
  const bridgeFile = new RotatingFile(join(logDir, BRIDGE_LOG));
  log = new Logger(mainLog, redactor);
  const bridgeLog = new Logger(bridgeFile, redactor);
  watchProcess(process, log);
  const about = {
    app: `ACARS Link ${app.getVersion()}${app.isPackaged ? '' : ' (dev)'}`,
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node,
    os: `${process.platform} ${release()} ${arch()}`,
    locale: app.getLocale(),
    build: PUBLIC_BUILD ? 'public' : 'personal',
  };
  log.info(
    `start: ${about.app}, Electron ${about.electron}, Node ${about.node}, ${about.os}, ${about.locale}`,
  );
  // The rename «ACARS Sim» → «ACARS Link» moved the user data; bring it over once.
  try {
    await migrateOldUserData(join(app.getPath('appData'), OLD_APP_DIR), userData);
  } catch (e) {
    log.error('user data migration failed', e);
  }
  const recordings = join(userData, 'recordings');
  // T30 C9: AeroDataBox data older than 7 days leave the recordings.
  purgeOldConnex(recordings, Date.now());
  // T55 R5: AeroDataBox route statistics older than 7 days leave the data cache.
  const dataCache = new FileDataCache(join(userData, 'cache'));
  await dataCache.purgeOlder(ROUTES_CACHE_PREFIX, ROUTES_RETENTION_MS, Date.now());
  const http = fetchHttpClient();
  const clock = { now: () => Date.now() };
  const secrets = new SecretStore(join(userData, 'secrets.json'), cipher, (v) => redactor.add(v));
  // The redactor learns the stored secrets before anything can log them.
  for (const key of ['hoppieLogon', 'aerodataboxKey', 'simbriefUsername'] as const) {
    await secrets.get(key).catch(() => null);
  }
  const settingsStore = new SettingsStore(
    join(userData, 'settings.json'),
    defaultSettings(app.getLocale()),
  );
  let controller: AppController | null = null;
  // Installed build only (dev: the bridge is started by hand). T75: the supervisor starts the process
  // again when it stops by itself and tells the app why when it cannot.
  const supervisor = new BridgeSupervisor({
    spawn: (port, simulator, hooks) =>
      startBridge(
        process.resourcesPath,
        port,
        simulator,
        bridgeToken,
        (msg) => log.warn(msg),
        (stream, line) => {
          if (stream === 'err') bridgeLog.warn(line);
          else bridgeLog.info(line);
          hooks.onLine(stream, line);
        },
        hooks.onExit,
      ),
    timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as never) },
    now: () => Date.now(),
    redact: (text) => redactor.redact(text),
    onStatus: (status) => controller?.setBridgeProcess(status),
    onRestarted: () => controller?.noteBridgeRestarted(),
    log,
  });
  // One start at a time: the old process leaves the port before the new one takes it.
  let bridgeQueue = Promise.resolve();
  const restartBridge = (port: number, simulator: SimChoice) => {
    if (!app.isPackaged) return;
    bridgeQueue = bridgeQueue.then(async () => {
      await supervisor.stop();
      log.info(`bridge: starting on port ${port}, simulator ${simulator}`);
      if (!supervisor.start(port, simulator)) log.warn('bridge: not started (no exe)');
    });
  };
  /** The save dialog in Documents (T67 diagnostics, T69 flight report); null = cancelled. */
  const chooseSavePath = async (defaultName: string, kind: string, ext: string) => {
    const options = {
      defaultPath: join(app.getPath('documents'), defaultName),
      filters: [{ name: kind, extensions: [ext] }],
    };
    const r =
      win === null
        ? await dialog.showSaveDialog(options)
        : await dialog.showSaveDialog(win, options);
    return r.canceled || r.filePath === undefined || r.filePath === '' ? null : r.filePath;
  };
  const onChange = () => {
    if (controller !== null) pushState(controller.state());
  };
  controller = new AppController({
    secrets,
    settings: settingsStore,
    scenarioSources: BASE_SCENARIOS,
    scenarioLocales: SCENARIO_LOCALES,
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
    createSocket: (url, headers) => new NodeWebSocket(url, { headers }),
    bridgeToken,
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
    log,
    diagnostics: {
      logFiles: () => [...mainLog.files(), ...bridgeFile.files()],
      latestRecording: () => latestRecording(recordings),
      about: () => about,
      redact: (text) => redactor.redact(text),
      choosePath: (defaultName) => chooseSavePath(defaultName, 'ZIP', 'zip'),
      reveal: (file) => shell.showItemInFolder(file),
    },
    logbook: new FileLogbook(join(userData, 'logbook.json'), clock.now),
    reportExport: {
      choosePath: (defaultName) => chooseSavePath(defaultName, 'JSON', 'json'),
      reveal: (file) => shell.showItemInFolder(file),
    },
    about: () => ({
      version: app.getVersion(),
      dev: !app.isPackaged,
      electron: about.electron,
      chrome: about.chrome,
      variant: PUBLIC_BUILD ? 'public' : 'personal',
    }),
    openLegal: async (doc) => {
      const file = legalFile(doc, {
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        desktopDir: join(here, '../..'),
      });
      if (!existsSync(file)) throw new Error(`file not found: ${basename(file)}`);
      const error = await shell.openPath(file);
      if (error !== '') throw new Error(error);
    },
    // T104: installed — resources/acars-smoke (electron-builder.yml); from the sources — the built package in the repository.
    smokePackage: new SmokePackage({
      localAppData: process.env['LOCALAPPDATA'] ?? join(app.getPath('home'), 'AppData', 'Local'),
      appData: app.getPath('appData'),
      bundleDir: app.isPackaged
        ? join(process.resourcesPath, SMOKE_PACKAGE)
        : join(here, '../../../../bridge/msfs/package/dist', SMOKE_PACKAGE),
    }),
  });
  const ctl = controller;
  registerIpc(ipcMain, ctl, isTrustedSender, log);
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
    log.info('quit');
    clearInterval(loop);
    ctl.dispose();
    void supervisor.stop();
  });
}

void main();
