import type { IpcMainInvokeEvent } from 'electron';
import { IPC } from '../shared/api.js';
import type { AppController } from './controller.js';
import { AppFailure, guard } from './errors.js';

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
): void {
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
  on(IPC.setScenarioChance, (id, percent) =>
    guard(() => app.setScenarioChance(str(id, 'scenario'), percent)),
  );
  on(IPC.forceScenario, (id) => guard(() => app.forceScenario(str(id, 'scenario'))));
  on(IPC.getCredentials, () => app.credentials());
  on(IPC.setSimbriefUsername, (u) => guard(() => app.setSimbriefUsername(u)));
  on(IPC.setHoppieCode, (code) => guard(() => app.setHoppieCode(code)));
  on(IPC.clearHoppieCode, () => guard(() => app.clearHoppieCode()));
  on(IPC.loadOfp, () => guard(() => app.loadOfp()));
  on(IPC.startFlight, () => guard(() => app.startFlight()));
  on(IPC.stopFlight, () => guard(() => app.stopFlight()));
  on(IPC.endFlight, (to) => guard(() => app.endFlight(to)));
  on(IPC.sendPilotMessage, (text) => guard(() => app.sendPilotMessage(text)));
  on(IPC.openRecordings, () => guard(() => app.openRecordings()));
  on(IPC.clearMemory, () => guard(() => app.clearMemory()));
}
