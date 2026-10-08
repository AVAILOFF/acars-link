import { create } from 'zustand';
import type {
  AcarsApi,
  AppError,
  AppState,
  CredentialsView,
  Result,
  ScenarioInfo,
  Settings,
} from '../../shared/api.js';

/**
 * UI state. Everything about the flight comes from the main process (`onState`); the store
 * only keeps what the UI shows and forwards user actions. No timers here (invariant 5).
 */

export type Tab = 'flight' | 'scenarios' | 'settings';
export type Busy =
  | 'load'
  | 'start'
  | 'stop'
  | 'end'
  | 'username'
  | 'code'
  | 'settings'
  | 'scenario'
  | 'recordings'
  | 'pilot';

interface Store {
  readonly app: AppState | null;
  readonly settings: Settings | null;
  readonly creds: CredentialsView | null;
  readonly scenarios: readonly ScenarioInfo[] | null;
  readonly error: AppError | null;
  readonly busy: Busy | null;
  /** Last successful save, to show "saved" next to the right field. */
  readonly saved: Busy | null;
  readonly tab: Tab;

  init(): Promise<() => void>;
  setTab(tab: Tab): void;
  dismissError(): void;
  loadOfp(): Promise<void>;
  startFlight(): Promise<void>;
  stopFlight(): Promise<void>;
  endFlight(to: 'TURNAROUND' | 'DONE'): Promise<void>;
  sendPilotMessage(text: string): Promise<boolean>;
  setScenario(id: string, enabled: boolean): Promise<void>;
  updateSettings(patch: Parameters<AcarsApi['updateSettings']>[0]): Promise<boolean>;
  setUsername(u: string): Promise<boolean>;
  setHoppieCode(code: string): Promise<boolean>;
  clearHoppieCode(): Promise<void>;
  openRecordings(): Promise<void>;
}

const api = (): AcarsApi => window.acars;

export const useStore = create<Store>()((set, get) => {
  /** Runs one action: marks it busy, stores the error or the result. */
  async function run<T>(
    busy: Busy,
    call: () => Promise<Result<T>>,
    ok?: (value: T) => void,
  ): Promise<boolean> {
    if (get().busy !== null) return false;
    set({ busy, error: null, saved: null });
    try {
      const r = await call();
      if (r.ok) {
        ok?.(r.value);
        set({ saved: busy });
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
    tab: 'flight',

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
      });
      return off;
    },
    setTab: (tab) => set({ tab, saved: null }),
    dismissError: () => set({ error: null }),

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
    sendPilotMessage: (text) => run('pilot', () => api().sendPilotMessage(text)),
    async setScenario(id, enabled) {
      await run(
        'scenario',
        () => api().setScenarioEnabled(id, enabled),
        (scenarios) => set({ scenarios }),
      );
    },
    updateSettings: (patch) =>
      run(
        'settings',
        () => api().updateSettings(patch),
        (settings) => set({ settings }),
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
    async openRecordings() {
      await run('recordings', () => api().openRecordings());
    },
  };
});
