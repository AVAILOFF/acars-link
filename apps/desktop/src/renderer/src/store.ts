// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { create } from 'zustand';
import type {
  AcarsApi,
  AppError,
  AppState,
  CredentialsView,
  Result,
  ScenarioInfo,
  Settings,
  SimbriefCheck,
} from '../../shared/api.js';
import type { ReadyFix } from './welcome.js';

/**
 * UI state. Everything about the flight comes from the main process (`onState`); the store
 * only keeps what the UI shows and forwards user actions. No timers here (invariant 5).
 */

export type Tab = 'flight' | 'scenarios' | 'settings' | 'help';
export type Busy =
  | 'load'
  | 'start'
  | 'stop'
  | 'end'
  | 'close'
  | 'username'
  | 'code'
  | 'adbKey'
  | 'check'
  | 'settings'
  | 'scenario'
  | 'recordings'
  | 'memory'
  | 'force'
  | 'pilot';

/** Result of a "Check" button (U-06), shown next to its row. */
export type Checked =
  | { readonly what: 'simbrief'; readonly ofp: SimbriefCheck }
  | { readonly what: 'hoppie' };

interface Store {
  readonly app: AppState | null;
  readonly settings: Settings | null;
  readonly creds: CredentialsView | null;
  readonly scenarios: readonly ScenarioInfo[] | null;
  readonly error: AppError | null;
  readonly busy: Busy | null;
  /** Last successful save, to show "saved" next to the right field. */
  readonly saved: Busy | null;
  /** The settings row of the last successful save (U-08): its key, e.g. `bridgePort`. */
  readonly savedField: string | null;
  readonly checked: Checked | null;
  readonly tab: Tab;
  /** "Advanced settings" are unfolded (U-07); kept while the app runs. */
  readonly advancedOpen: boolean;
  /** The welcome dialog is open (T70): on a new profile, or again from Help. */
  readonly welcome: boolean;
  /** Index in `TOUR_STOPS` of the interface tour (T70); null = no tour. */
  readonly tour: number | null;
  /** A settings input to scroll to and focus once the settings page shows (T70). */
  readonly focusField: string | null;

  init(): Promise<() => void>;
  setTab(tab: Tab): void;
  setAdvancedOpen(open: boolean): void;
  openWelcome(): void;
  /** Closes the welcome and saves that it was seen; `tour` starts the interface tour. */
  finishWelcome(tour?: boolean): Promise<void>;
  /** Opens the "Messages" tab at the given tour stop; null ends the tour. */
  setTour(stop: number | null): void;
  /** The settings page at one field (a readiness item, T70). */
  openField(fix: ReadyFix): void;
  clearFocusField(): void;
  dismissError(): void;
  loadOfp(): Promise<void>;
  startFlight(): Promise<void>;
  stopFlight(): Promise<void>;
  endFlight(to: 'TURNAROUND' | 'DONE'): Promise<void>;
  closeFlight(then: 'next' | 'close', now: boolean): Promise<void>;
  sendPilotMessage(text: string): Promise<boolean>;
  setScenario(id: string, enabled: boolean): Promise<void>;
  setScenarios(ids: readonly string[], enabled: boolean): Promise<void>;
  setChance(id: string, percent: number | null): Promise<void>;
  forceScenario(id: string): Promise<void>;
  /** `field` names the row for the "saved" mark; default: the first key of the patch. */
  updateSettings(
    patch: Parameters<AcarsApi['updateSettings']>[0],
    field?: string,
  ): Promise<boolean>;
  setUsername(u: string): Promise<boolean>;
  setHoppieCode(code: string): Promise<boolean>;
  clearHoppieCode(): Promise<void>;
  setAerodataboxKey(key: string): Promise<boolean>;
  clearAerodataboxKey(): Promise<void>;
  checkSimbrief(): Promise<void>;
  checkHoppie(): Promise<void>;
  openRecordings(): Promise<void>;
  clearMemory(): Promise<void>;
}

const api = (): AcarsApi => window.acars;

export const useStore = create<Store>()((set, get) => {
  /** Runs one action: marks it busy, stores the error or the result. */
  async function run<T>(
    busy: Busy,
    call: () => Promise<Result<T>>,
    ok?: (value: T) => void,
    field: string | null = null,
  ): Promise<boolean> {
    if (get().busy !== null) return false;
    set({ busy, error: null, saved: null, savedField: null, checked: null });
    try {
      const r = await call();
      if (r.ok) {
        ok?.(r.value);
        set({ saved: busy, savedField: field });
        return true;
      }
      set({ error: r.error });
      return false;
    } finally {
      set({ busy: null });
    }
  }

  return {
    app: null,
    settings: null,
    creds: null,
    scenarios: null,
    error: null,
    busy: null,
    saved: null,
    savedField: null,
    checked: null,
    tab: 'flight',
    advancedOpen: false,
    welcome: false,
    tour: null,
    focusField: null,

    async init() {
      const off = api().onState((app) => set({ app }));
      const [app, settings, creds, scenarios] = await Promise.all([
        api().getState(),
        api().getSettings(),
        api().getCredentials(),
        api().listScenarios(),
      ]);
      set({
        app,
        settings,
        creds,
        scenarios: scenarios.ok ? scenarios.value : [],
        error: scenarios.ok ? null : scenarios.error,
        welcome: !settings.welcomeDone,
      });
      return off;
    },
    setTab: (tab) => set({ tab, saved: null, savedField: null, checked: null }),
    setAdvancedOpen: (advancedOpen) => set({ advancedOpen }),
    dismissError: () => set({ error: null }),
    openWelcome: () => set({ welcome: true, tour: null }),
    async finishWelcome(tour = false) {
      set({ welcome: false });
      if (tour) get().setTour(0);
      if (get().settings?.welcomeDone !== false) return;
      // Not through `run`: closing must save even while another action is busy.
      const r = await api().updateSettings({ welcomeDone: true });
      if (r.ok) set({ settings: r.value });
      else set({ error: r.error });
    },
    setTour: (stop) => {
      if (stop !== null && get().tab !== 'flight') get().setTab('flight');
      set({ tour: stop });
    },
    openField: (fix) => {
      get().setTab('settings');
      set({ focusField: fix.field, ...(fix.advanced ? { advancedOpen: true } : {}) });
    },
    clearFocusField: () => set({ focusField: null }),

    async loadOfp() {
      await run('load', () => api().loadOfp());
    },
    async startFlight() {
      await run('start', () => api().startFlight());
    },
    async stopFlight() {
      await run('stop', () => api().stopFlight());
    },
    async endFlight(to) {
      await run('end', () => api().endFlight(to));
    },
    async closeFlight(then, now) {
      await run('close', () => api().closeFlight(then, now));
    },
    sendPilotMessage: (text) => run('pilot', () => api().sendPilotMessage(text)),
    async setScenario(id, enabled) {
      await run(
        'scenario',
        () => api().setScenarioEnabled(id, enabled),
        (scenarios) => set({ scenarios }),
      );
    },
    async setScenarios(ids, enabled) {
      await run(
        'scenario',
        () => api().setScenariosEnabled(ids, enabled),
        (scenarios) => set({ scenarios }),
      );
    },
    async setChance(id, percent) {
      await run(
        'scenario',
        () => api().setScenarioChance(id, percent),
        (scenarios) => set({ scenarios }),
      );
    },
    async forceScenario(id) {
      await run('force', () => api().forceScenario(id));
    },
    updateSettings: (patch, field) =>
      run(
        'settings',
        () => api().updateSettings(patch),
        (settings) => set({ settings }),
        field ?? Object.keys(patch)[0] ?? null,
      ),
    setUsername: (u) =>
      run(
        'username',
        () => api().setSimbriefUsername(u),
        (creds) => set({ creds }),
      ),
    setHoppieCode: (code) =>
      run(
        'code',
        () => api().setHoppieCode(code),
        (creds) => set({ creds }),
      ),
    async clearHoppieCode() {
      await run(
        'code',
        () => api().clearHoppieCode(),
        (creds) => set({ creds }),
      );
    },
    setAerodataboxKey: (key) =>
      run(
        'adbKey',
        () => api().setAerodataboxKey(key),
        (creds) => set({ creds }),
      ),
    async clearAerodataboxKey() {
      await run(
        'adbKey',
        () => api().clearAerodataboxKey(),
        (creds) => set({ creds }),
      );
    },
    async checkSimbrief() {
      await run(
        'check',
        () => api().checkSimbrief(),
        (ofp) => set({ checked: { what: 'simbrief', ofp } }),
      );
    },
    async checkHoppie() {
      await run(
        'check',
        () => api().checkHoppie(),
        () => set({ checked: { what: 'hoppie' } }),
      );
    },
    async openRecordings() {
      await run('recordings', () => api().openRecordings());
    },
    async clearMemory() {
      await run('memory', () => api().clearMemory());
    },
  };
});
