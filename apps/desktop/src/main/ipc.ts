// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { IpcMainInvokeEvent } from 'electron';
import { IPC } from '../shared/api.js';
import type { AppController } from './controller.js';
import { AppFailure, guard as guardResult } from './errors.js';
import { type Log, NO_LOG } from './log.js';

/**
 * IPC handlers. The renderer is treated as untrusted input: every call checks the sender
 * frame and the argument types; the controller validates the values.
 */

export interface IpcLike {
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void;
}

export function registerIpc(
  ipc: IpcLike,
  app: AppController,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
  log: Log = NO_LOG,
): void {
  // T67: an expected failure is one log line; anything else with its stack.
  const failed = (e: unknown) => {
    if (e instanceof AppFailure) log.warn(`request failed: ${e.message}`);
    else log.error('request failed', e);
  };
  const guard = <T>(fn: () => T | Promise<T>) => guardResult(fn, failed);
  const on = (channel: string, fn: (...args: unknown[]) => unknown) => {
    ipc.handle(channel, (event, ...args) => {
      if (!isTrustedSender(event)) throw new Error('untrusted sender');
      return fn(...args);
    });
  };
  const str = (x: unknown, what: string): string => {
    if (typeof x !== 'string') throw new AppFailure('invalid_input', `${what}: expected text`);
    return x;
  };

  on(IPC.getState, () => app.state());
  on(IPC.getSettings, () => app.getSettings());
  on(IPC.updateSettings, (patch) => guard(() => app.updateSettings(patch as never)));
  on(IPC.listScenarios, () => guard(() => app.listScenarios()));
  on(IPC.setScenarioEnabled, (id, enabled) =>
    guard(() => {
      if (typeof enabled !== 'boolean') throw new AppFailure('invalid_input', 'enabled');
      return app.setScenarioEnabled(str(id, 'scenario'), enabled);
    }),
  );
  on(IPC.setScenariosEnabled, (ids, enabled) =>
    guard(() => {
      if (typeof enabled !== 'boolean') throw new AppFailure('invalid_input', 'enabled');
      return app.setScenariosEnabled(ids, enabled);
    }),
  );
  on(IPC.setScenarioChance, (id, percent) =>
    guard(() => app.setScenarioChance(str(id, 'scenario'), percent)),
  );
  on(IPC.forceScenario, (id) => guard(() => app.forceScenario(str(id, 'scenario'))));
  on(IPC.getCredentials, () => app.credentials());
  on(IPC.setSimbriefUsername, (u) => guard(() => app.setSimbriefUsername(u)));
  on(IPC.setHoppieCode, (code) => guard(() => app.setHoppieCode(code)));
  on(IPC.clearHoppieCode, () => guard(() => app.clearHoppieCode()));
  on(IPC.setAerodataboxKey, (key) => guard(() => app.setAerodataboxKey(key)));
  on(IPC.clearAerodataboxKey, () => guard(() => app.clearAerodataboxKey()));
  on(IPC.checkSimbrief, () => guard(() => app.checkSimbrief()));
  on(IPC.checkHoppie, () => guard(() => app.checkHoppie()));
  on(IPC.loadOfp, () => guard(() => app.loadOfp()));
  on(IPC.startFlight, () => guard(() => app.startFlight()));
  on(IPC.stopFlight, () => guard(() => app.stopFlight()));
  on(IPC.endFlight, (to) => guard(() => app.endFlight(to)));
  on(IPC.closeFlight, (then, now) => guard(() => app.closeFlight(then, now)));
  on(IPC.resumeFlight, () => guard(() => app.resumeFlight()));
  on(IPC.discardResume, () => guard(() => app.discardResume()));
  on(IPC.sendPilotMessage, (text) => guard(() => app.sendPilotMessage(text)));
  on(IPC.openRecordings, () => guard(() => app.openRecordings()));
  on(IPC.clearMemory, () => guard(() => app.clearMemory()));
  on(IPC.exportDiagnostics, (withRecording) => guard(() => app.exportDiagnostics(withRecording)));
  on(IPC.exportReport, () => guard(() => app.exportReport()));
}
