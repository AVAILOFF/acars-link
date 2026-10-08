import type { FlightPhase, ScenarioCategory } from '@acars/core';
import type { TransportStatus } from '@acars/transport';

/**
 * Main ↔ renderer contract. The renderer gets this API from the preload script as
 * `window.acars`; it never sees the Hoppie logon code (CLAUDE.md, invariant 2), only
 * whether one is stored.
 */

export type Language = 'en' | 'ru';

/** `offline`: messages only appear in the feed, nothing goes to the network (MockTransport). */
export type TransportChoice = 'hoppie' | 'offline';

export interface Settings {
  readonly language: Language;
  readonly transport: TransportChoice;
  /** Station callsign template, docs/08 decision 6: `{flight}`, `{airline}`. */
  readonly stationTemplate: string;
  /** Port of the sim bridge on 127.0.0.1. */
  readonly bridgePort: number;
  /** Scenario id → enabled; absent ids use `enabled_by_default`. */
  readonly scenarios: Readonly<Record<string, boolean>>;
}

export type SettingsPatch = Partial<Omit<Settings, 'scenarios'>>;

export interface CredentialsView {
  readonly simbriefUsername: string;
  readonly hoppieCodeSet: boolean;
  /** False when the OS store (DPAPI / Keychain / libsecret) is not available. */
  readonly secureStorage: boolean;
}

export interface ScenarioInfo {
  readonly id: string;
  readonly title: string;
  readonly category: ScenarioCategory;
  readonly enabledByDefault: boolean;
  readonly enabled: boolean;
}

export interface FlightSummary {
  readonly callsign: string;
  readonly flightNumber: string | null;
  readonly origin: string;
  readonly destination: string;
  readonly aircraftIcao: string;
  readonly aircraftReg: string | null;
  readonly schedOutMs: number;
  readonly schedInMs: number;
  readonly requestId: string;
  /** Sender callsign of the airline messages (from the station template). */
  readonly station: string;
  /** Display profile chosen for the aircraft type. */
  readonly profileId: string;
  readonly lineWidth: number;
}

/** WebSocket link to the bridge, then the bridge's own link to the sim. */
export interface BridgeView {
  readonly link: 'connecting' | 'open' | 'closed';
  readonly sim: 'disconnected' | 'connecting' | 'connected' | null;
  readonly running: boolean;
  readonly paused: boolean;
  readonly simRate: number;
  /** Error text for `closed` (e.g. wrong protocol version). */
  readonly detail: string | null;
  readonly retryAt: number | null;
}

export interface TelemetryView {
  readonly t: number;
  readonly aircraftTitle: string;
  readonly onGround: boolean;
  readonly altFt: number;
  readonly gsKt: number;
  readonly vsFpm: number;
  readonly fuelKg: number;
}

export interface TransportView {
  readonly kind: 'hoppie' | 'mock';
  readonly status: TransportStatus;
  readonly pending: number;
  readonly reason: string | null;
}

export type Delivery = 'queued' | 'sent' | 'retry' | 'failed' | 'dropped';

/** System entries carry a code + params; the renderer translates them. */
export type SystemCode =
  | 'flight_started'
  | 'flight_stopped'
  | 'phase'
  | 'oooi'
  | 'telemetry_lost'
  | 'telemetry_restored'
  | 'discontinuity'
  | 'scenario_error'
  | 'transport_status';

export type FeedEntry =
  | {
      readonly kind: 'outbound';
      readonly id: string;
      readonly t: number;
      readonly from: string;
      readonly to: string;
      readonly scenarioId: string;
      readonly text: string;
      readonly delivery: Delivery;
      readonly detail: string | null;
    }
  | {
      readonly kind: 'inbound';
      readonly id: string;
      readonly t: number;
      readonly from: string;
      readonly to: string;
      readonly type: string;
      readonly text: string;
    }
  | {
      readonly kind: 'system';
      readonly id: string;
      readonly t: number;
      readonly code: SystemCode;
      readonly params: Readonly<Record<string, string>>;
    };

/**
 * - `idle`: no OFP;
 * - `ready`: OFP loaded, flight not started;
 * - `running`: the core and the transport tick.
 */
export type SessionState = 'idle' | 'ready' | 'running';

export interface AppState {
  readonly session: SessionState;
  readonly flight: FlightSummary | null;
  readonly phase: FlightPhase | null;
  readonly bridge: BridgeView;
  readonly telemetry: TelemetryView | null;
  readonly transport: TransportView | null;
  /** Newest last, capped. */
  readonly feed: readonly FeedEntry[];
}

export type ErrorCode =
  | 'invalid_input'
  | 'no_username'
  | 'no_hoppie_code'
  | 'secure_storage_unavailable'
  | 'simbrief_user'
  | 'simbrief_http'
  | 'network'
  | 'ofp_invalid'
  | 'bad_state'
  | 'scenarios_invalid'
  | 'internal';

export interface AppError {
  readonly code: ErrorCode;
  /** Technical detail (English); never contains secrets. */
  readonly detail: string;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AppError };

export interface AcarsApi {
  getState(): Promise<AppState>;
  /** Called on every state change; returns an unsubscribe function. */
  onState(listener: (state: AppState) => void): () => void;

  getSettings(): Promise<Settings>;
  updateSettings(patch: SettingsPatch): Promise<Result<Settings>>;
  listScenarios(): Promise<Result<ScenarioInfo[]>>;
  setScenarioEnabled(id: string, enabled: boolean): Promise<Result<ScenarioInfo[]>>;

  getCredentials(): Promise<CredentialsView>;
  setSimbriefUsername(username: string): Promise<Result<CredentialsView>>;
  /** The code goes one way only: renderer → main → OS store. */
  setHoppieCode(code: string): Promise<Result<CredentialsView>>;
  clearHoppieCode(): Promise<Result<CredentialsView>>;

  loadOfp(): Promise<Result<FlightSummary>>;
  startFlight(): Promise<Result<null>>;
  stopFlight(): Promise<Result<null>>;
  endFlight(to: 'TURNAROUND' | 'DONE'): Promise<Result<null>>;
}

/** IPC channel names (invoke) and the push channel. */
export const IPC = {
  getState: 'acars:get-state',
  state: 'acars:state',
  getSettings: 'acars:get-settings',
  updateSettings: 'acars:update-settings',
  listScenarios: 'acars:list-scenarios',
  setScenarioEnabled: 'acars:set-scenario-enabled',
  getCredentials: 'acars:get-credentials',
  setSimbriefUsername: 'acars:set-simbrief-username',
  setHoppieCode: 'acars:set-hoppie-code',
  clearHoppieCode: 'acars:clear-hoppie-code',
  loadOfp: 'acars:load-ofp',
  startFlight: 'acars:start-flight',
  stopFlight: 'acars:stop-flight',
  endFlight: 'acars:end-flight',
} as const;
