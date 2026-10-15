import { contextBridge, ipcRenderer } from 'electron';
import { type AcarsApi, type AppState, IPC } from '../shared/api.js';

/** The only bridge between the sandboxed renderer and the main process. */
const api: AcarsApi = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  onState: (listener) => {
    const handler = (_: unknown, state: AppState) => listener(state);
    ipcRenderer.on(IPC.state, handler);
    return () => {
      ipcRenderer.removeListener(IPC.state, handler);
    };
  },
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.updateSettings, patch),
  listScenarios: () => ipcRenderer.invoke(IPC.listScenarios),
  setScenarioEnabled: (id, enabled) => ipcRenderer.invoke(IPC.setScenarioEnabled, id, enabled),
  getCredentials: () => ipcRenderer.invoke(IPC.getCredentials),
  setSimbriefUsername: (u) => ipcRenderer.invoke(IPC.setSimbriefUsername, u),
  setHoppieCode: (code) => ipcRenderer.invoke(IPC.setHoppieCode, code),
  clearHoppieCode: () => ipcRenderer.invoke(IPC.clearHoppieCode),
  setAerodataboxKey: (key) => ipcRenderer.invoke(IPC.setAerodataboxKey, key),
  clearAerodataboxKey: () => ipcRenderer.invoke(IPC.clearAerodataboxKey),
  loadOfp: () => ipcRenderer.invoke(IPC.loadOfp),
  startFlight: () => ipcRenderer.invoke(IPC.startFlight),
  stopFlight: () => ipcRenderer.invoke(IPC.stopFlight),
  endFlight: (to) => ipcRenderer.invoke(IPC.endFlight, to),
  sendPilotMessage: (text) => ipcRenderer.invoke(IPC.sendPilotMessage, text),
  openRecordings: () => ipcRenderer.invoke(IPC.openRecordings),
  clearMemory: () => ipcRenderer.invoke(IPC.clearMemory),
  setScenarioChance: (id, percent) => ipcRenderer.invoke(IPC.setScenarioChance, id, percent),
  forceScenario: (id) => ipcRenderer.invoke(IPC.forceScenario, id),
};

contextBridge.exposeInMainWorld('acars', api);
