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
  /** Write every flight to a JSONL recording (T11) in the user-data folder. */
  readonly recordFlights: boolean;
  /**
   * Fetch free external data (T13): METAR/TAF, VATSIM ATC, NASA EONET, OSM stands, launches. Off: the
   * messages use the OFP only and nothing but SimBrief and Hoppie is contacted.
   */
  readonly liveData: boolean;
  /** Play a sound when a new airline message appears in the feed. Off by default. */
  readonly soundOnMessage: boolean;
  /**
   * Minimum seconds between two airline telexes (0 = none). Aircraft poll Hoppie about once a
   * minute; closer messages arrive together. Default 60.
   */
  readonly messageGapSec: number;
  /**
   * ROPS ATC station (T23): a simulated CPDLC station per FIR on Hoppie (`X` + FIR, e.g.
   * XDGG) for the own aircraft. Needs live data (FIR boundaries). Off by default.
   */
  readonly rops: boolean;
  /** ROPS steps aside where a live VATSIM centre covers the FIR. Default on. */
  readonly ropsStandAside: boolean;
  /** ROPS sends up to 3 random Direct To per flight (T26). Default on. */
  readonly ropsRandomDirects: boolean;
  /**
   * Special events (T29) by group; a group that is off has its scenarios off and its sources not
   * asked. Default on. Sport: F1, NHL. Aviation: space weather, aurora, eclipse, volcanic ash,
   * air shows, aviation history. Other: public holiday, earthquake at the destination.
   */
  readonly specialSport: boolean;
  readonly specialAviation: boolean;
  readonly specialOther: boolean;
  /** Scenario id → enabled; absent ids use `enabled_by_default`. */
  readonly scenarios: Readonly<Record<string, boolean>>;
  /** Irregular scenario id → chance in percent (0–100); absent ids use the YAML `probability`. */
  readonly chances: Readonly<Record<string, number>>;
  /**
   * Chance multiplier of `drone_activity` by the destination country (T38): ISO 3166-1 alpha-2
   * code or `*` (any other) → factor. Empty = the table built into the app.
   */
  readonly droneRisk: Readonly<Record<string, number>>;
}

export type SettingsPatch = Partial<Omit<Settings, 'scenarios' | 'chances'>>;

export interface CredentialsView {
  readonly simbriefUsername: string;
  readonly hoppieCodeSet: boolean;
  /** False when the OS store (DPAPI / Keychain / libsecret) is not available. */
  readonly secureStorage: boolean;
}

/** A UI text in the app languages; `ru` null = use `en`. */
export interface UiText {
  readonly en: string;
  readonly ru: string | null;
}

export interface ScenarioInfo {
  readonly id: string;
  readonly title: string;
  /** Title and description in the UI languages (from the scenario file). */
  readonly titleText: UiText;
  readonly description: UiText | null;
  readonly category: ScenarioCategory;
  readonly enabledByDefault: boolean;
  readonly enabled: boolean;
  /** Chance from the scenario file, percent. */
  readonly defaultChance: number;
  /** The user's chance, percent; null = the default. Irregular scenarios only. */
  readonly chance: number | null;
  /** The built-in multiplier table (T38); only for `drone_activity`, else null. */
  readonly droneRiskDefault: Readonly<Record<string, number>> | null;
}

/** An irregular scenario of the running flight that can be started by hand. */
export interface ForceableScenario {
  readonly id: string;
  readonly title: UiText;
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
  /** Protocol of the connected bridge (after `hello`); v1 takes no commands. */
  readonly protocol: 1 | 2 | null;
  /** Sim commands the bridge offers (v2 `hello`). */
  readonly commands: readonly string[];
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
  /** Telexes the core holds back for the gap between messages (`messageGapSec`). */
  readonly outbox: number;
  readonly kind: 'hoppie' | 'mock';
  readonly status: TransportStatus;
  readonly pending: number;
  readonly reason: string | null;
}

/** ROPS station state (T23). */
export interface AtcView {
  /** Station to log on to (the FIR's), null before the FIR is known. */
  readonly station: string | null;
  /** Station the aircraft is logged on to. */
  readonly connected: string | null;
  /** Departure clearance station (T24) while it is open (on the ground), else null. */
  readonly dcl: string | null;
}

export type Delivery = 'queued' | 'sent' | 'retry' | 'failed' | 'dropped';

/** System entries carry a code + params; the renderer translates them. */
export type SystemCode =
  | 'flight_started'
  | 'flight_stopped'
  | 'late_start'
  | 'recording'
  | 'recording_failed'
  | 'phase'
  | 'oooi'
  | 'telemetry_lost'
  | 'telemetry_restored'
  | 'discontinuity'
  | 'scenario_error'
  | 'reply_timeout'
  | 'data_failed'
  | 'memory'
  | 'forced_started'
  | 'forced_conditions'
  | 'forced_running'
  | 'forced_unknown'
  | 'data_restored'
  | 'transport_status'
  | 'sim_command_failed'
  | 'atc_station'
  | 'atc_logon'
  | 'atc_logon_refused'
  | 'atc_logon_wrong'
  | 'atc_handover'
  | 'atc_logoff'
  | 'atc_live'
  | 'atc_unsupported'
  | 'atc_emergency'
  | 'atc_level_check'
  | 'atc_misrouted_pdc'
  | 'atc_misrouted_pdc_closed'
  | 'atc_misrouted_logon'
  | 'atc_misrouted_logon_fir'
  | 'atc_misrouted_fir'
  | 'atc_misrouted_dcl'
  | 'flt_nbr_hint'
  | 'atc_request'
  | 'atc_auto'
  | 'atc_needs_data'
  | 'atc_dcl_request'
  | 'atc_dcl_clearance'
  | 'atc_dcl_confirmed'
  | 'atc_dcl_unable'
  | 'atc_dcl_rejected'
  | 'atc_ocl_received'
  | 'atc_ocl_not_required'
  | 'atc_ocl_rejected'
  | 'atc_ocl_clearance'
  | 'atc_ocl_confirmed'
  | 'atc_ocl_cancelled';

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
      /** Hoppie message type, or `app` for a message typed in the app (T12). */
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
  /** ROPS station of the running flight (T23); null = off or no flight. */
  readonly atc: AtcView | null;
  /** Newest last, capped. */
  readonly feed: readonly FeedEntry[];
  /** Names of the airline-memory flags kept for the next flight (T14). */
  readonly memory: readonly string[];
  /** Irregular scenarios of the running flight ("run now"); empty when no flight runs. */
  readonly irregular: readonly ForceableScenario[];
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
  /** Chance of an irregular scenario in percent (0–100), null = back to the file's. */
  setScenarioChance(id: string, percent: number | null): Promise<Result<ScenarioInfo[]>>;

  getCredentials(): Promise<CredentialsView>;
  setSimbriefUsername(username: string): Promise<Result<CredentialsView>>;
  /** The code goes one way only: renderer → main → OS store. */
  setHoppieCode(code: string): Promise<Result<CredentialsView>>;
  clearHoppieCode(): Promise<Result<CredentialsView>>;

  loadOfp(): Promise<Result<FlightSummary>>;
  startFlight(): Promise<Result<null>>;
  stopFlight(): Promise<Result<null>>;
  endFlight(to: 'TURNAROUND' | 'DONE'): Promise<Result<null>>;
  /**
   * A telex "from the pilot" typed in the app (T12), for aircraft without free-text telex:
   * goes to the core as if the aircraft had sent it; nothing goes to the network.
   */
  sendPilotMessage(text: string): Promise<Result<null>>;
  /** Starts an irregular scenario of the running flight now (its conditions must hold). */
  forceScenario(id: string): Promise<Result<null>>;
  /** Opens the recordings folder in the OS file manager. */
  openRecordings(): Promise<Result<null>>;
  /** Forgets the airline memory (T14 flags: open MEL items, follow-ups); not during a flight. */
  clearMemory(): Promise<Result<null>>;
}

/** IPC channel names (invoke) and the push channel. */
export const IPC = {
  getState: 'acars:get-state',
  state: 'acars:state',
  getSettings: 'acars:get-settings',
  updateSettings: 'acars:update-settings',
  listScenarios: 'acars:list-scenarios',
  setScenarioEnabled: 'acars:set-scenario-enabled',
  setScenarioChance: 'acars:set-scenario-chance',
  forceScenario: 'acars:force-scenario',
  getCredentials: 'acars:get-credentials',
  setSimbriefUsername: 'acars:set-simbrief-username',
  setHoppieCode: 'acars:set-hoppie-code',
  clearHoppieCode: 'acars:clear-hoppie-code',
  loadOfp: 'acars:load-ofp',
  startFlight: 'acars:start-flight',
  stopFlight: 'acars:stop-flight',
  endFlight: 'acars:end-flight',
  sendPilotMessage: 'acars:send-pilot-message',
  openRecordings: 'acars:open-recordings',
  clearMemory: 'acars:clear-memory',
} as const;
