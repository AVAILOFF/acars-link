import {
  type CompiledScenario,
  type Ofp,
  selectProfile,
  stationCallsign,
  type TelemetrySnapshot,
} from '@acars/core';
import { loadScenarios, ScenarioLoadError } from '@acars/scenarios';
import type { HttpClient, Transport } from '@acars/transport';
import type {
  AppState,
  CredentialsView,
  FlightSummary,
  ScenarioInfo,
  Settings,
  SettingsPatch,
} from '../shared/api.js';
import { BridgeClient, type SocketLike, type Timers } from './bridge.js';
import { AppFailure } from './errors.js';
import { Feed } from './feed.js';
import type { OpenRecording, RecordingSink } from './recording.js';
import type { SecretStore } from './secrets.js';
import { FlightSession } from './session.js';
import type { SettingsStore } from './settings.js';
import { fetchOfp, normalizeSimbriefUsername } from './simbrief.js';

/**
 * Everything the app does, without Electron: credentials, settings, scenario selection, OFP,
 * start/stop and the state pushed to the UI. `main/index.ts` wires it to Electron and IPC.
 */

export type TransportFactory = (
  choice: { readonly kind: 'hoppie'; readonly logon: string } | { readonly kind: 'offline' },
) => Transport;

export interface ScenarioSource {
  readonly file: string;
  readonly source: string;
}

export interface AppControllerOptions {
  readonly secrets: SecretStore;
  readonly settings: SettingsStore;
  readonly scenarioSources: readonly ScenarioSource[];
  readonly http: HttpClient;
  readonly createTransport: TransportFactory;
  readonly createSocket: (url: string) => SocketLike;
  readonly timers: Timers;
  readonly now: () => number;
  /** Creates the JSONL recording of a flight (T11); null = no recordings. */
  readonly openRecording: OpenRecording | null;
  /** Shows the recordings folder (file manager). */
  readonly revealRecordings: () => Promise<void>;
  /** Called when the state may have changed (debounce/compare on the caller side). */
  readonly onChange: () => void;
}

/** Hoppie logon codes: printable ASCII without spaces (they go into a URL/form field). */
const LOGON_RE = /^[\x21-\x7e]{4,64}$/;

export class AppController {
  private readonly feed = new Feed();
  private readonly bridge: BridgeClient;
  private scenarios: readonly CompiledScenario[] = [];
  private scenarioError: string | null = null;
  private ofp: Ofp | null = null;
  private flight: FlightSummary | null = null;
  private session: FlightSession | null = null;
  /** `per_session` cooldowns live as long as the app (docs/05). */
  private sessionFired: readonly string[] = [];

  constructor(private readonly o: AppControllerOptions) {
    this.bridge = new BridgeClient({
      port: 0,
      createSocket: o.createSocket,
      timers: o.timers,
      now: o.now,
      onTelemetry: (s) => this.onTelemetry(s),
      onChange: o.onChange,
    });
    try {
      this.scenarios = loadScenarios(o.scenarioSources);
    } catch (e) {
      if (!(e instanceof ScenarioLoadError)) throw e;
      this.scenarioError = e.message;
    }
  }

  /** Starts the bridge connection with the saved port. */
  async init(): Promise<void> {
    const s = await this.o.settings.get();
    this.bridge.setPort(s.bridgePort);
    this.bridge.start();
  }

  dispose(): void {
    this.bridge.stop();
    this.session?.stop(this.o.now());
    this.session = null;
  }

  /** Main loop, ~1 Hz. */
  tick(now: number): void {
    this.session?.tick(now);
    this.o.onChange();
  }

  state(): AppState {
    const s = this.session;
    return {
      session: s !== null ? 'running' : this.flight !== null ? 'ready' : 'idle',
      flight: this.flight,
      phase: s?.phase ?? null,
      bridge: this.bridge.view,
      telemetry: s?.telemetry ?? null,
      transport: s?.transportView ?? null,
      feed: this.feed.entries,
    };
  }

  // --- settings & scenarios ---

  getSettings(): Promise<Settings> {
    return this.o.settings.get();
  }

  async updateSettings(patch: SettingsPatch): Promise<Settings> {
    const s = await this.o.settings.update(patch);
    this.bridge.setPort(s.bridgePort);
    if (this.ofp !== null && this.session === null) this.flight = this.summary(this.ofp, s);
    this.o.onChange();
    return s;
  }

  async listScenarios(): Promise<ScenarioInfo[]> {
    if (this.scenarioError !== null) throw new AppFailure('scenarios_invalid', this.scenarioError);
    const { scenarios: chosen } = await this.o.settings.get();
    return this.scenarios
      .map((c) => ({
        id: c.id,
        title: c.def.title,
        category: c.def.category,
        enabledByDefault: c.def.enabled_by_default,
        enabled: chosen[c.id] ?? c.def.enabled_by_default,
      }))
      .sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
  }

  /** Takes effect with the next flight. */
  async setScenarioEnabled(id: string, enabled: boolean): Promise<ScenarioInfo[]> {
    if (!this.scenarios.some((c) => c.id === id)) {
      throw new AppFailure('invalid_input', `unknown scenario ${id}`);
    }
    await this.o.settings.setScenario(id, enabled);
    return this.listScenarios();
  }

  // --- credentials ---

  async credentials(): Promise<CredentialsView> {
    const { secrets } = this.o;
    return {
      simbriefUsername: (await secrets.get('simbriefUsername')) ?? '',
      hoppieCodeSet: await secrets.has('hoppieLogon'),
      secureStorage: await secrets.available(),
    };
  }

  async setSimbriefUsername(input: unknown): Promise<CredentialsView> {
    await this.o.secrets.set('simbriefUsername', normalizeSimbriefUsername(input));
    return this.credentials();
  }

  async setHoppieCode(input: unknown): Promise<CredentialsView> {
    const code = typeof input === 'string' ? input.trim() : '';
    if (!LOGON_RE.test(code)) {
      throw new AppFailure('invalid_input', 'logon code: 4..64 characters without spaces');
    }
    await this.o.secrets.set('hoppieLogon', code);
    return this.credentials();
  }

  async clearHoppieCode(): Promise<CredentialsView> {
    await this.o.secrets.delete('hoppieLogon');
    return this.credentials();
  }

  // --- flight ---

  async loadOfp(): Promise<FlightSummary> {
    if (this.session !== null) throw new AppFailure('bad_state', 'stop the flight first');
    const username = await this.o.secrets.get('simbriefUsername');
    if (username === null || username === '') throw new AppFailure('no_username', 'not set');
    const ofp = await fetchOfp(this.o.http, username);
    const summary = this.summary(ofp, await this.o.settings.get());
    this.ofp = ofp;
    this.flight = summary;
    this.o.onChange();
    return summary;
  }

  async startFlight(): Promise<null> {
    if (this.session !== null) throw new AppFailure('bad_state', 'flight already running');
    const ofp = this.ofp;
    if (ofp === null) throw new AppFailure('bad_state', 'load the OFP first');
    if (this.scenarioError !== null) throw new AppFailure('scenarios_invalid', this.scenarioError);
    const settings = await this.o.settings.get();
    const flight = this.summary(ofp, settings);
    let transport: Transport;
    if (settings.transport === 'hoppie') {
      const logon = await this.o.secrets.get('hoppieLogon');
      if (logon === null) throw new AppFailure('no_hoppie_code', 'not set');
      transport = this.o.createTransport({ kind: 'hoppie', logon });
    } else {
      transport = this.o.createTransport({ kind: 'offline' });
    }
    const enabled = this.scenarios.filter(
      (c) => settings.scenarios[c.id] ?? c.def.enabled_by_default,
    );
    const now = this.o.now();
    let recording: RecordingSink | null = null;
    if (settings.recordFlights && this.o.openRecording !== null) {
      try {
        recording = this.o.openRecording(ofp.callsign, now);
      } catch (e) {
        this.feed.system(now, 'recording_failed', {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    this.session = new FlightSession({
      ofp,
      scenarios: enabled,
      profile: selectProfile({ icao: ofp.aircraft.icao }),
      stationTemplate: settings.stationTemplate,
      transport,
      feed: this.feed,
      sessionFired: this.sessionFired,
      now,
      recording,
    });
    this.flight = flight;
    this.o.onChange();
    return null;
  }

  async stopFlight(): Promise<null> {
    const s = this.session;
    if (s === null) throw new AppFailure('bad_state', 'no flight running');
    s.stop(this.o.now());
    this.sessionFired = s.sessionFired;
    this.session = null;
    this.o.onChange();
    return null;
  }

  async endFlight(to: unknown): Promise<null> {
    const s = this.session;
    if (s === null) throw new AppFailure('bad_state', 'no flight running');
    if (to !== 'TURNAROUND' && to !== 'DONE') throw new AppFailure('invalid_input', 'end flight');
    if (s.phase !== 'ON_BLOCK') throw new AppFailure('bad_state', `phase ${s.phase}`);
    s.endFlight(to, this.o.now());
    this.o.onChange();
    return null;
  }

  async openRecordings(): Promise<null> {
    try {
      await this.o.revealRecordings();
    } catch (e) {
      throw new AppFailure('internal', e instanceof Error ? e.message : String(e));
    }
    return null;
  }

  private onTelemetry(s: TelemetrySnapshot): void {
    this.session?.pushTelemetry(s);
  }

  private summary(ofp: Ofp, settings: Settings): FlightSummary {
    const profile = selectProfile({ icao: ofp.aircraft.icao });
    let station: string;
    try {
      station = stationCallsign(settings.stationTemplate, ofp);
    } catch (e) {
      throw new AppFailure('invalid_input', e instanceof Error ? e.message : String(e));
    }
    return {
      callsign: ofp.callsign,
      flightNumber: ofp.flightNumber,
      origin: ofp.origin.icao,
      destination: ofp.destination.icao,
      aircraftIcao: ofp.aircraft.icao,
      aircraftReg: ofp.aircraft.reg,
      schedOutMs: ofp.times.schedOutMs,
      schedInMs: ofp.times.schedInMs,
      requestId: ofp.source.requestId,
      station,
      profileId: profile.id,
      lineWidth: profile.lineWidth,
    };
  }
}
