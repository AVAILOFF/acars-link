// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { writeFile } from 'node:fs/promises';
import {
  alignOfpDay,
  type CompiledScenario,
  classifyFlight,
  type FlightKind,
  type FlightReport,
  isFlightKind,
  type Ofp,
  type SimCommand,
  selectProfile,
  stationCallsign,
  type TelemetrySnapshot,
} from '@acars/core';
import { type DataCache, ExternalDataService } from '@acars/data-sources';
import { encodeLine, type Recording } from '@acars/replay';
import {
  DRONE_RISK_DEFAULT,
  droneProbability,
  type LocaleSource,
  loadScenarios,
  ScenarioLoadError,
} from '@acars/scenarios';
import type { HttpClient, Transport } from '@acars/transport';
import type {
  AboutInfo,
  AppState,
  BridgeProcessView,
  CredentialsView,
  EndingView,
  FlightKindView,
  FlightReportView,
  FlightSummary,
  Language,
  LegalDoc,
  ResumeOffer,
  ScenarioInfo,
  Settings,
  SettingsPatch,
  SimbriefCheck,
  SimChoice,
  Simulator,
  SmokePackageView,
  UiText,
} from '../shared/api.js';
import { activeSim, LEGAL_DOCS } from '../shared/api.js';
import { BridgeClient, type SocketLike, type Timers } from './bridge.js';
import { normalizeHoppieCode, normalizeRapidApiKey, pingHoppie } from './credentials.js';
import { type DiagnosticsSource, diagnosticsEntries, diagnosticsFileName } from './diagnostics.js';
import { AppFailure, toAppError } from './errors.js';
import { Feed } from './feed.js';
import type { Flags, FlagsStore } from './flags.js';
import { uiText } from './hints.js';
import { type Log, NO_LOG } from './log.js';
import type { LogbookStore } from './logbook.js';
import type { FlightResume, OpenRecording, RecordingSink, UnfinishedFlight } from './recording.js';
import type { SecretStore } from './secrets.js';
import { FlightSession, ResumeError } from './session.js';
import type { SettingsStore } from './settings.js';
import { SimEffects } from './sim-effects.js';
import { fetchOfp, normalizeSimbriefUsername } from './simbrief.js';
import { specialGroupOn, specialGroups } from './special.js';
import { PUBLIC_BUILD, SQUAWK_TABLES } from './variant.js';
import { zip } from './zip.js';

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
  /** Translations of the scenarios' UI texts (T85, `packages/scenarios/locales/<lang>.yaml`); absent = English only. */
  readonly scenarioLocales?: readonly LocaleSource[];
  readonly http: HttpClient;
  readonly createTransport: TransportFactory;
  readonly createSocket: (url: string, headers: Readonly<Record<string, string>>) => SocketLike;
  /** Launch token of the bundled bridge (T65); sent on every connection. */
  readonly bridgeToken?: string | null;
  readonly timers: Timers;
  readonly now: () => number;
  /** Creates the JSONL recording of a flight (T11); null = no recordings. */
  readonly openRecording: OpenRecording | null;
  /** Finds and continues a flight the app lost (T64); absent or null = no restoring. */
  readonly resume?: FlightResume | null;
  /** Shows the recordings folder (file manager). */
  readonly revealRecordings: () => Promise<void>;
  /** Called when the state may have changed (debounce/compare on the caller side). */
  readonly onChange: () => void;
  /** Cache of the external data (T13); default in memory. */
  readonly dataCache?: DataCache;
  /** GSX VDGS message folder (T22, `gsxVdgsDir`); null or absent = no GSX. */
  readonly vdgsDir?: string | null;
  /** Airline memory between flights (T14); default in memory only. */
  readonly flags?: FlagsStore;
  /** The bridge port or simulator was changed (T18): the bundled bridge is started anew. */
  readonly onBridgeConfig?: (port: number, simulator: SimChoice) => void;
  /** File log (T67); default none. */
  readonly log?: Log;
  /** "Export diagnostics" (T67); absent or null = not available. */
  readonly diagnostics?: DiagnosticsSource | null;
  /** The logbook of closed flights (T69); absent or null = none. */
  readonly logbook?: LogbookStore | null;
  /** Saving the flight report as JSON (T69); absent or null = not available. */
  readonly reportExport?: {
    /** Asks the user where to save (`defaultName` proposed); null = cancelled. */
    readonly choosePath: (defaultName: string) => Promise<string | null>;
    readonly reveal?: (file: string) => void;
  } | null;
  /** Versions and build for the "About" page (T74); absent = unknown versions. */
  readonly about?: (() => AboutInfo) | null;
  /** Opens a licence file in the OS program for it (T74); throws when it cannot. Absent = not available. */
  readonly openLegal?: ((doc: LegalDoc) => Promise<void>) | null;
  /** The smoke package for MSFS 2024 in Community (T104, `smoke-package.ts`); absent or null = not available. */
  readonly smokePackage?: {
    view(): Promise<SmokePackageView>;
    install(): Promise<SmokePackageView>;
    remove(): Promise<SmokePackageView>;
  } | null;
}

/** Title of a scenario in the UI languages. */
export const titleText = (c: CompiledScenario): UiText => uiText(c.texts.title);

/** Irregular events: category `irregular`, not a pilot-command handler (`cmd_divert`). */
export const isIrregularEvent = (c: CompiledScenario): boolean =>
  c.def.category === 'irregular' && c.def.trigger.on !== 'command';

/** Pilot command handlers (`REQ LOADSHEET`, `DIVERT`, …): the requests need them, always on (U-10). */
export const isCommand = (c: CompiledScenario): boolean => c.def.trigger.on === 'command';

/** The scenario whose chance depends on the destination country (T38). */
export const DRONE_SCENARIO_ID = 'drone_activity';

/** Scenarios about the next leg with the same aircraft; off with the "turnaround" setting off. */
export const TURNAROUND_SCENARIOS: readonly string[] = [
  'next_leg',
  'aircraft_change',
  'welcome_turnaround',
];

/** Simulator names in the feed (the same in both UI languages). */
const SIM_NAMES: Readonly<Record<Simulator, string>> = { msfs: 'MSFS', xplane: 'X-Plane 12' };

/** Identifies the app to aviationweather.gov, VATSIM, NASA and Overpass (they ask for it). */
export const DATA_USER_AGENT = 'ACARS-Link/0.1 (flight simulator ACARS; personal use)';

/** Longer than any MCDU free text; the core reads words of A–Z0–9 only. */
const MAX_PILOT_TEXT = 200;
/** "Check" of the Hoppie code (U-06): at most one ping per this time (invariant 6). */
export const HOPPIE_CHECK_GAP_MS = 15_000;

export class AppController {
  private readonly feed = new Feed();
  private readonly bridge: BridgeClient;
  /** T75: set by the bridge process supervisor in `main/index.ts`. */
  private bridgeProcess: BridgeProcessView | null = null;
  private scenarios: readonly CompiledScenario[] = [];
  private scenarioError: string | null = null;
  private ofp: Ofp | null = null;
  private flight: FlightSummary | null = null;
  private session: FlightSession | null = null;
  /** `per_session` cooldowns live as long as the app (docs/05). */
  private sessionFired: readonly string[] = [];
  /** Sim UTC minus the bridge clock from the latest snapshot that had it; null = none yet. */
  private simOffsetMs: number | null = null;
  /** The last simulator the bridge was connected to (T59): a different one during a flight goes to the feed. */
  private lastSim: Simulator | null = null;
  /** External data (T13): prefetches for the loaded OFP, feeds the running flight. */
  private readonly data: ExternalDataService;
  private readonly flagStore: FlagsStore | { get(): Promise<Flags>; set(f: Flags): Promise<Flags> };
  /** Names of the stored flags, for the UI. */
  private memory: readonly string[] = [];
  /** VDGS text, smoke and rescue vehicles in the sim (T22, T34, T54). */
  private readonly effects: SimEffects;
  /** U-04: close the flight when nothing waits, then load the next OFP (`next`) or not. */
  private closing: 'next' | 'close' | null = null;
  /** A close is in progress (stop, then maybe the OFP), so the main loop starts it only once. */
  private closingNow = false;
  /** Time of the last Hoppie check ping (U-06). */
  private lastHoppieCheck = Number.NEGATIVE_INFINITY;
  /** UI language for texts of the main process (the close dialog, U-03). */
  private lang: Language = 'en';
  /** The flight the app lost, offered at the start (T64); null = none or already decided. */
  private unfinished: UnfinishedFlight | null = null;
  private readonly log: Log;
  /** The bridge state last written to the log (T67): only changes are logged. */
  private bridgeLogged = '';
  /** The report of the flight closed at the gate (T69), until the next OFP is loaded. */
  private report: FlightReportView | null = null;
  /** T89: the user's kind of flight for the loaded OFP; null = automatic. */
  private kindOverride: FlightKind | null = null;
  /** T89: the question after loading the OFP waits for an answer. */
  private kindAsk = false;

  constructor(private readonly o: AppControllerOptions) {
    this.log = o.log ?? NO_LOG;
    this.data = new ExternalDataService({
      http: o.http,
      userAgent: DATA_USER_AGENT,
      ...(o.dataCache === undefined ? {} : { cache: o.dataCache }),
    });
    let mem: Flags = {};
    this.flagStore = o.flags ?? {
      get: async () => mem,
      set: async (f) => {
        mem = f;
        return f;
      },
    };
    this.bridge = new BridgeClient({
      port: 0,
      createSocket: o.createSocket,
      token: o.bridgeToken ?? null,
      timers: o.timers,
      now: o.now,
      onTelemetry: (s) => this.onTelemetry(s),
      onChange: () => {
        this.onBridgeChange();
        o.onChange();
      },
      onCommandResult: (r) => this.effects.onCommandResult(r),
    });
    this.effects = new SimEffects({
      feed: this.feed,
      bridge: this.bridge,
      data: this.data,
      settings: () => o.settings.get(),
      sim: () => this.sim(),
      flying: () => this.session !== null,
      aircraftIcao: () => this.ofp?.aircraft.icao,
      now: o.now,
      onChange: o.onChange,
      vdgsDir: o.vdgsDir ?? null,
    });
    try {
      this.scenarios = loadScenarios(o.scenarioSources, o.scenarioLocales ?? []);
    } catch (e) {
      if (!(e instanceof ScenarioLoadError)) throw e;
      this.scenarioError = e.message;
    }
  }

  /** Starts the bridge connection with the saved port. */
  async init(): Promise<void> {
    const s = await this.o.settings.get();
    this.lang = s.language;
    this.bridge.setPort(s.bridgePort);
    this.bridge.start();
    this.effects.clear(); // left over from a crash
    this.memory = Object.keys(await this.flagStore.get()).sort();
    this.unfinished = this.o.resume?.find(this.o.now()) ?? null;
  }

  /** The app quits: a running flight goes on at the next start (T64), nothing is stopped. */
  dispose(): void {
    this.bridge.stop();
    this.data.stopFlight();
    this.session?.suspend();
    this.session = null;
    this.effects.clear();
  }

  /** A command for the simulator (T21): VDGS text, smoke, rescue or a plain bridge command. */
  sendSimCommand(c: SimCommand): string | null {
    return this.effects.send(c);
  }

  /** Main loop, ~1 Hz. */
  tick(now: number): void {
    this.data.tick(now, this.session?.phase ?? null);
    this.session?.tick(now);
    const ending = this.ending();
    if (ending?.closing != null && ending.messages === 0 && ending.scenarios === 0) {
      void this.finishClose();
    }
    this.o.onChange();
  }

  /** The UI language (main-process texts, U-03). */
  get language(): Language {
    return this.lang;
  }

  /**
   * Closing the window would lose something (U-03): a flight runs, and it is not a finished one
   * with nothing left to send.
   */
  get closeWouldLose(): boolean {
    if (this.session === null) return false;
    const e = this.ending();
    return e === null || e.messages > 0 || e.scenarios > 0;
  }

  /** The running flight goes on after a restart (T64): its recording is written. */
  get canResume(): boolean {
    return this.session?.resumable === true && this.o.resume != null;
  }

  /** The flight after TURNAROUND / DONE: what still waits (U-04); null before or without a flight. */
  private ending(): EndingView | null {
    const s = this.session;
    if (s === null || (s.phase !== 'TURNAROUND' && s.phase !== 'DONE')) return null;
    return { to: s.phase, ...s.waiting, closing: this.closing };
  }

  state(): AppState {
    const s = this.session;
    return {
      session: s !== null ? 'running' : this.flight !== null ? 'ready' : 'idle',
      flight: this.flight,
      phase: s?.phase ?? null,
      ending: this.ending(),
      waitingSimTime: s?.waitingSimTime ?? false,
      bridge: this.bridge.view,
      bridgeProcess: this.bridgeProcess,
      telemetry: s?.telemetry ?? null,
      transport: s?.transportView ?? null,
      atc: s?.atc ?? null,
      link: s?.link ?? null,
      feed: this.feed.entries,
      pendingReplies: s?.pendingReplies ?? [],
      memory: this.memory,
      irregular: s?.irregular ?? [],
      resume: s === null ? resumeOffer(this.unfinished) : null,
      report: this.report,
      flightKind: this.kindView(),
    };
  }

  /** T89: the kind of the running flight (the core's), else of the loaded OFP. */
  private kindView(): FlightKindView | null {
    const s = this.session;
    if (s !== null) {
      const k = s.flightKind;
      return k === null ? null : { ...k, ask: this.kindAsk && !k.locked };
    }
    if (this.ofp === null) return null;
    return { ...classifyFlight(this.ofp, this.kindOverride), locked: false, ask: this.kindAsk };
  }

  /**
   * T89: the kind of flight for this flight (null = automatic); answers the question after loading
   * the OFP. Before the start it is kept for the core's options; in flight it goes to the core,
   * which fixes it at OUT.
   */
  async setFlightKind(kind: unknown): Promise<null> {
    if (kind !== null && !isFlightKind(kind)) {
      throw new AppFailure(
        'invalid_input',
        `unknown kind of flight: ${String(kind)}`,
        'flight_kind',
      );
    }
    if (this.ofp === null)
      throw new AppFailure('bad_state', 'load the OFP first', 'load_ofp_first');
    const s = this.session;
    if (s !== null) {
      const k = s.flightKind;
      if (k === null || k.locked) {
        throw new AppFailure('bad_state', 'the kind of flight is fixed after OUT', 'kind_locked');
      }
      s.setFlightKind(kind);
    }
    this.kindOverride = kind;
    this.kindAsk = false;
    this.o.onChange();
    return null;
  }

  // --- settings & scenarios ---

  getSettings(): Promise<Settings> {
    return this.o.settings.get();
  }

  async updateSettings(patch: SettingsPatch): Promise<Settings> {
    const before = await this.o.settings.get();
    const s = await this.o.settings.update(patch);
    this.lang = s.language;
    this.bridge.setPort(s.bridgePort);
    if (s.bridgePort !== before.bridgePort || s.simChoice !== before.simChoice) {
      this.o.onBridgeConfig?.(s.bridgePort, s.simChoice);
    }
    if (this.ofp !== null && this.session === null) {
      this.flight = this.summary(this.ofp, s);
      this.prefetch(this.ofp, s);
    }
    this.o.onChange();
    return s;
  }

  async listScenarios(): Promise<ScenarioInfo[]> {
    if (this.scenarioError !== null) throw new AppFailure('scenarios_invalid', this.scenarioError);
    const { scenarios: chosen, chances } = await this.o.settings.get();
    return this.scenarios
      .map((c) => ({
        id: c.id,
        title: c.def.title,
        titleText: titleText(c),
        description: c.texts.description === null ? null : uiText(c.texts.description),
        hint: c.texts.hint === null ? null : uiText(c.texts.hint),
        category: c.def.category,
        command: isCommand(c),
        enabledByDefault: c.def.enabled_by_default,
        enabled: isCommand(c) || (chosen[c.id] ?? c.def.enabled_by_default),
        defaultChance: Math.round(c.probability * 1000) / 10,
        chance: isIrregularEvent(c) ? (chances[c.id] ?? null) : null,
        droneRiskDefault: c.id === DRONE_SCENARIO_ID ? DRONE_RISK_DEFAULT : null,
      }))
      .sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
  }

  /** Takes effect with the next flight. */
  async setScenarioEnabled(id: string, enabled: boolean): Promise<ScenarioInfo[]> {
    this.switchable(id);
    await this.o.settings.setScenario(id, enabled);
    return this.listScenarios();
  }

  /** A whole category at once (U-10); takes effect with the next flight. */
  async setScenariosEnabled(ids: unknown, enabled: boolean): Promise<ScenarioInfo[]> {
    if (!Array.isArray(ids) || !ids.every((x): x is string => typeof x === 'string')) {
      throw new AppFailure('invalid_input', 'ids: a list of scenario ids', 'unknown_scenario', {
        id: '',
      });
    }
    for (const id of ids) this.switchable(id);
    await this.o.settings.setScenarios(ids, enabled);
    return this.listScenarios();
  }

  /** A known scenario that is not a pilot command (those stay on, U-10). */
  private switchable(id: string): void {
    const c = this.scenarios.find((x) => x.id === id);
    if (c === undefined) {
      throw new AppFailure('invalid_input', `unknown scenario ${id}`, 'unknown_scenario', { id });
    }
    if (isCommand(c)) {
      throw new AppFailure('invalid_input', `${id}: pilot commands stay on`, 'command_scenario', {
        id,
      });
    }
  }

  /** Chance of an irregular scenario, percent (null = the file's); takes effect next flight. */
  async setScenarioChance(id: string, percent: unknown): Promise<ScenarioInfo[]> {
    const c = this.scenarios.find((x) => x.id === id);
    if (c === undefined) {
      throw new AppFailure('invalid_input', `unknown scenario ${id}`, 'unknown_scenario', { id });
    }
    if (!isIrregularEvent(c)) {
      throw new AppFailure(
        'invalid_input',
        `${id}: chances are set for irregular scenarios only`,
        'chance_irregular_only',
        { id },
      );
    }
    if (percent !== null && typeof percent !== 'number') {
      throw new AppFailure('invalid_input', 'chance: a number 0..100 or null', 'chance_range');
    }
    await this.o.settings.setChance(id, percent);
    return this.listScenarios();
  }

  // --- credentials ---

  async credentials(): Promise<CredentialsView> {
    const { secrets } = this.o;
    return {
      simbriefUsername: (await secrets.get('simbriefUsername')) ?? '',
      hoppieCodeSet: await secrets.has('hoppieLogon'),
      aerodataboxKeySet: await secrets.has('aerodataboxKey'),
      secureStorage: await secrets.available(),
    };
  }

  async setSimbriefUsername(input: unknown): Promise<CredentialsView> {
    await this.o.secrets.set('simbriefUsername', normalizeSimbriefUsername(input));
    return this.credentials();
  }

  async setHoppieCode(input: unknown): Promise<CredentialsView> {
    await this.o.secrets.set('hoppieLogon', normalizeHoppieCode(input));
    return this.credentials();
  }

  async clearHoppieCode(): Promise<CredentialsView> {
    await this.o.secrets.delete('hoppieLogon');
    return this.credentials();
  }

  /** The user's RapidAPI key for AeroDataBox (T30, docs/07 C1); used from the next OFP load. */
  async setAerodataboxKey(input: unknown): Promise<CredentialsView> {
    await this.o.secrets.set('aerodataboxKey', normalizeRapidApiKey(input));
    return this.credentials();
  }

  async clearAerodataboxKey(): Promise<CredentialsView> {
    await this.o.secrets.delete('aerodataboxKey');
    return this.credentials();
  }

  /** The latest OFP of the saved username, not loaded (U-06 "Check"). */
  async checkSimbrief(): Promise<SimbriefCheck> {
    const username = await this.o.secrets.get('simbriefUsername');
    if (username === null || username === '') throw new AppFailure('no_username', 'not set');
    const ofp = await fetchOfp(this.o.http, username);
    return { callsign: ofp.callsign, origin: ofp.origin.icao, destination: ofp.destination.icao };
  }

  /**
   * One Hoppie `ping` with the saved code (U-06 "Check"). tech.html: "a single ping" tests the link;
   * a wrong code answers `error {invalid logon code}` (checked 2026-10-22, docs/06). Not during a
   * flight (the transport keeps the gap between requests), at most one per
   * {@link HOPPIE_CHECK_GAP_MS} (invariant 6).
   */
  async checkHoppie(): Promise<null> {
    if (this.session !== null) {
      throw new AppFailure('bad_state', 'flight running', 'flight_running');
    }
    const logon = await this.o.secrets.get('hoppieLogon');
    if (logon === null) throw new AppFailure('no_hoppie_code', 'not set');
    const now = this.o.now();
    const left = this.lastHoppieCheck + HOPPIE_CHECK_GAP_MS - now;
    if (left > 0) {
      throw new AppFailure('bad_state', 'check again later', 'check_too_soon', {
        sec: String(Math.ceil(left / 1000)),
      });
    }
    this.lastHoppieCheck = now;
    await pingHoppie(this.o.http, logon);
    return null;
  }

  // --- flight ---

  async loadOfp(): Promise<FlightSummary> {
    if (this.session !== null) {
      throw new AppFailure('bad_state', 'stop the flight first', 'stop_flight_first');
    }
    const username = await this.o.secrets.get('simbriefUsername');
    if (username === null || username === '') throw new AppFailure('no_username', 'not set');
    const ofp = await fetchOfp(this.o.http, username);
    const settings = await this.o.settings.get();
    const summary = this.summary(ofp, settings);
    // T89: the same flight loaded again keeps the answer unless the recognized kind changed.
    const before = this.ofp;
    const same =
      before !== null &&
      before.callsign === ofp.callsign &&
      before.origin.icao === ofp.origin.icao &&
      before.destination.icao === ofp.destination.icao &&
      classifyFlight(before).auto === classifyFlight(ofp).auto;
    if (!same) {
      this.kindOverride = null;
      this.kindAsk = settings.askFlightKind;
    }
    this.ofp = ofp;
    this.flight = summary;
    this.report = null;
    await this.prefetch(ofp, await this.o.settings.get());
    this.o.onChange();
    return summary;
  }

  /** Starts fetching the live data of an OFP before the flight starts (T13), if enabled. */
  private async prefetch(ofp: Ofp, settings: Settings): Promise<void> {
    if (settings.liveData) {
      // T30: onward departures only with the user's own AeroDataBox key (C1, C10).
      const connexKey = await this.o.secrets.get('aerodataboxKey').catch(() => null);
      this.data.startFlight(ofp, this.o.now(), {
        firs: settings.xatc,
        datalink: settings.datalink,
        special: specialGroups(settings),
        connexKey,
      });
    } else this.data.stopFlight();
  }

  async startFlight(): Promise<null> {
    if (this.session !== null) {
      throw new AppFailure('bad_state', 'flight already running', 'flight_running');
    }
    const planned = this.ofp;
    if (planned === null) throw new AppFailure('bad_state', 'load the OFP first', 'load_ofp_first');
    if (this.scenarioError !== null) throw new AppFailure('scenarios_invalid', this.scenarioError);
    const settings = await this.o.settings.get();
    // X-Plane sends no sim clock (T18): the flight would wait for it forever. T59: by the connected sim.
    const simTime =
      settings.simTime && activeSim(settings.simChoice, this.bridge.view) !== 'xplane';
    // The plan's date follows the flight's clock (the sim's with "time from the sim"): only the
    // time of day of STD counts (docs/05 "Дата OFP").
    const clockNow = this.o.now() + (simTime ? (this.simOffsetMs ?? 0) : 0);
    const { ofp, days } = alignOfpDay(planned, clockNow);
    const flight = this.summary(ofp, settings);
    const transport = await this.transport(settings);
    const now = this.o.now();
    // T38: the country of the destination (OurAirports; unknown offline → the `*` row).
    const droneOn = settings.scenarios[DRONE_SCENARIO_ID] ?? true;
    const droneCountry =
      settings.liveData && droneOn
        ? await this.data.airportCountry(ofp.destination.icao, now)
        : null;
    const droneTable =
      Object.keys(settings.droneRisk).length === 0 ? DRONE_RISK_DEFAULT : settings.droneRisk;
    const enabled = this.scenarios
      .filter((c) => specialGroupOn(c.id, settings))
      .filter((c) => settings.turnaround || !TURNAROUND_SCENARIOS.includes(c.id))
      .filter((c) => isCommand(c) || (settings.scenarios[c.id] ?? c.def.enabled_by_default))
      .map((c) => {
        const pct = isIrregularEvent(c) ? settings.chances[c.id] : undefined;
        const base = pct === undefined ? c.probability : pct / 100;
        const probability =
          c.id === DRONE_SCENARIO_ID ? droneProbability(base, droneTable, droneCountry) : base;
        return probability === c.probability ? c : { ...c, probability };
      });
    await this.prefetch(ofp, settings);
    const flags = await this.flagStore.get();
    // A new flight: the lost one is not offered any more (T64).
    this.giveUpUnfinished();
    let recording: RecordingSink | null = null;
    // T64: without "Record flights" the flight is recorded too, for restoring only (decision 6).
    if (this.o.openRecording !== null) {
      try {
        recording = this.o.openRecording(ofp.callsign, now, !settings.recordFlights);
      } catch (e) {
        this.log.error('recording did not open', e);
        this.feed.system(now, 'recording_failed', {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    this.closing = null;
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
      log: this.log,
      ...this.appVersion(),
      data: settings.liveData ? this.data : null,
      flags,
      minGapMs: settings.messageGapSec * 1000,
      ...(settings.hubIcao === '' ? {} : { hub: settings.hubIcao }),
      massUnit: settings.massUnit,
      ...(simTime ? { simTime: true } : {}),
      flightKind: { override: this.kindOverride },
      simCommands: (c) => this.sendSimCommand(c),
      ...(settings.datalink
        ? {
            datalink: {
              satcom: settings.datalinkSatcom,
              ...(settings.aircraftIcaoHex === '' ? {} : { icaoHex: settings.aircraftIcaoHex }),
              ...(settings.datalinkHeaderInText ? { headerInText: true } : {}),
            },
          }
        : {}),
      ...(settings.xatc
        ? {
            xatc: {
              enabled: true,
              standAside: settings.xatcStandAside,
              randomDirects: settings.xatcRandomDirects,
              squawkTables: SQUAWK_TABLES,
            },
          }
        : {}),
    });
    // The station needs the FIR boundaries (live data).
    if (settings.xatc && !settings.liveData) this.feed.system(now, 'atc_needs_data');
    // The conditional VHF stations come from live data; without them only SATCOM is a link.
    if (settings.datalink && !settings.liveData) this.feed.system(now, 'link_needs_data');
    if (days !== 0) {
      this.feed.system(now, 'ofp_date', {
        date: utcDate(ofp.times.schedOutMs),
        planned: utcDate(planned.times.schedOutMs),
      });
    }
    if (Object.keys(flags).length > 0) {
      this.feed.system(now, 'memory', { names: Object.keys(flags).sort().join(', ') });
    }
    this.flight = flight;
    this.report = null;
    this.log.info(`flight started (${settings.transport})`);
    this.o.onChange();
    return null;
  }

  /** The transport of the user's choice (Hoppie needs the saved code). */
  private async transport(settings: Settings): Promise<Transport> {
    if (settings.transport !== 'hoppie') return this.o.createTransport({ kind: 'offline' });
    const logon = await this.o.secrets.get('hoppieLogon');
    if (logon === null) throw new AppFailure('no_hoppie_code', 'not set');
    return this.o.createTransport({ kind: 'hoppie', logon });
  }

  /**
   * T64: goes on with the flight the app lost. Its recording runs through the core again (the same
   * scenarios, options and seed from the header), the feed is rebuilt, the telexes that never left
   * are sent now, and the recording goes on in the same file. The network is the current setting.
   */
  async resumeFlight(): Promise<null> {
    if (this.session !== null) {
      throw new AppFailure('bad_state', 'flight already running', 'flight_running');
    }
    const lost = this.unfinished;
    const store = this.o.resume;
    if (lost === null || store == null) {
      throw new AppFailure('bad_state', 'no flight to resume', 'no_resume');
    }
    if (this.scenarioError !== null) throw new AppFailure('scenarios_invalid', this.scenarioError);
    const h = lost.recording.header;
    const scenarios = h.scenarios.flatMap((id) => this.scenarios.filter((c) => c.id === id));
    const missing = h.scenarios.filter((id) => !scenarios.some((c) => c.id === id));
    if (missing.length > 0) {
      throw new AppFailure(
        'bad_state',
        `scenarios of the flight not found: ${missing.join(', ')}`,
        'resume_scenarios',
        { ids: missing.join(', ') },
      );
    }
    const settings = await this.o.settings.get();
    const transport = await this.transport(settings);
    const now = this.o.now();
    // Live data were on when the core waits for fetched weather (`dataWaitMs`).
    const live = h.dataWaitMs !== undefined;
    await this.prefetch(h.ofp, { ...settings, liveData: live });
    let recording: RecordingSink | null = null;
    try {
      recording = store.append(lost.file);
    } catch (e) {
      this.log.error('recording did not open', e);
      this.feed.system(now, 'recording_failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    const before = this.feed.save();
    try {
      this.session = new FlightSession({
        ofp: h.ofp,
        scenarios,
        profile: h.profile,
        stationTemplate: h.station,
        transport,
        feed: this.feed,
        sessionFired: h.sessionFired,
        now,
        recording,
        log: this.log,
        data: live ? this.data : null,
        ...(h.flags === undefined ? {} : { flags: h.flags }),
        ...(h.minGapMs === undefined ? {} : { minGapMs: h.minGapMs }),
        ...(h.hub === undefined ? {} : { hub: h.hub }),
        ...(h.simTime === true ? { simTime: true } : {}),
        simCommands: (c) => this.sendSimCommand(c),
        ...(h.datalink === undefined ? {} : { datalink: h.datalink }),
        ...(h.xatc === undefined ? {} : { xatc: h.xatc }),
        resume: lost.recording,
      });
    } catch (e) {
      recording?.close();
      this.data.stopFlight();
      this.feed.restore(before);
      const detail = e instanceof Error ? e.message : String(e);
      this.log.warn('flight not resumed', e);
      if (e instanceof ResumeError) throw new AppFailure('bad_state', detail, 'resume_mismatch');
      throw new AppFailure('bad_state', detail, 'resume_invalid');
    }
    this.unfinished = null;
    this.closing = null;
    // T69: a flight restored after the gate shows its report again (the logbook has it already).
    const closed = this.session.report;
    this.report = closed === null ? null : this.reportView(closed);
    this.ofp = h.ofp;
    // T89: the kind as recorded; the question was answered (or not) before the restart.
    this.kindOverride = this.session.flightKind?.override ?? null;
    this.kindAsk = false;
    this.flight = this.summary(h.ofp, settings, h.station);
    this.log.info(`flight resumed (${settings.transport})`);
    this.o.onChange();
    return null;
  }

  /** T64: the user gives the lost flight up; it is not offered again. */
  async discardResume(): Promise<null> {
    if (this.unfinished === null)
      throw new AppFailure('bad_state', 'no flight to resume', 'no_resume');
    this.giveUpUnfinished();
    this.o.onChange();
    return null;
  }

  /** A kept recording gets a `stop` line at its last time (so it is not offered again). */
  private giveUpUnfinished(): void {
    const lost = this.unfinished;
    this.unfinished = null;
    if (lost === null) return;
    try {
      this.o.resume?.discard(lost, encodeLine({ type: 'stop', now: lastTime(lost.recording) }));
    } catch {
      // The file may be gone; it is not newer than the next flight's anyway.
    }
  }

  async stopFlight(): Promise<null> {
    const s = this.session;
    if (s === null) throw new AppFailure('bad_state', 'no flight running', 'no_flight');
    this.closing = null;
    s.stop(this.o.now());
    this.log.info('flight stopped');
    this.data.stopFlight();
    this.effects.clear();
    await this.saveMemory(s);
    this.sessionFired = s.sessionFired;
    this.session = null;
    this.o.onChange();
    return null;
  }

  async endFlight(to: unknown): Promise<null> {
    const s = this.session;
    if (s === null) throw new AppFailure('bad_state', 'no flight running', 'no_flight');
    if (to !== 'TURNAROUND' && to !== 'DONE') {
      throw new AppFailure('invalid_input', 'end flight', 'end_choice');
    }
    if (s.phase !== 'ON_BLOCK') {
      throw new AppFailure('bad_state', `phase ${s.phase}`, 'not_on_block', { phase: s.phase });
    }
    const now = this.o.now();
    s.endFlight(to, now);
    const report = s.report;
    if (report !== null) {
      this.report = this.reportView(report);
      try {
        await this.o.logbook?.append({ closedAt: now, to, recording: s.recordingFile, report });
      } catch (e) {
        this.log.error('logbook not written', e);
      }
    }
    await this.saveMemory(s);
    this.o.onChange();
    return null;
  }

  /** The report with the titles of its irregular scenarios (T69). */
  private reportView(report: FlightReport): FlightReportView {
    return {
      report,
      irregular: report.irregular.map((id) => {
        const c = this.scenarios.find((x) => x.id === id);
        return { id, title: c === undefined ? { en: id } : titleText(c) };
      }),
    };
  }

  /**
   * T69: asks where to save, then writes the flight report (`AppState.report`) as JSON; shows it in
   * the file manager. Returns the file, or null when the user cancelled.
   */
  async exportReport(): Promise<string | null> {
    const view = this.report;
    if (view === null) throw new AppFailure('bad_state', 'no flight report', 'no_report');
    const x = this.o.reportExport;
    if (x == null) throw new AppFailure('internal', 'report export is not available');
    const file = await x.choosePath(reportFileName(view.report));
    if (file === null) return null;
    try {
      await writeFile(file, `${JSON.stringify(view.report, null, 2)}\n`, 'utf8');
    } catch (e) {
      throw new AppFailure('internal', e instanceof Error ? e.message : String(e));
    }
    this.log.info('flight report exported');
    x.reveal?.(file);
    return file;
  }

  /**
   * U-04: closes the flight after TURNAROUND / DONE once nothing waits (the main loop checks), then
   * with `next` loads the next OFP. `now`: at once, dropping what still waits.
   */
  async closeFlight(then: unknown, now: unknown): Promise<null> {
    const s = this.session;
    if (s === null) throw new AppFailure('bad_state', 'no flight running', 'no_flight');
    if ((then !== 'next' && then !== 'close') || typeof now !== 'boolean') {
      throw new AppFailure('invalid_input', 'close flight', 'end_choice');
    }
    const e = this.ending();
    if (e === null) {
      throw new AppFailure('bad_state', `phase ${s.phase}`, 'not_ended', { phase: s.phase });
    }
    this.closing = then;
    if (now || (e.messages === 0 && e.scenarios === 0)) await this.finishClose();
    this.o.onChange();
    return null;
  }

  /** Stops the flight the user closed; a failed next OFP is a line in the feed (no one awaits it). */
  private async finishClose(): Promise<void> {
    const then = this.closing;
    if (then === null || this.closingNow) return;
    this.closingNow = true;
    try {
      await this.stopFlight();
      if (then === 'next') {
        try {
          await this.loadOfp();
        } catch (e) {
          const err = toAppError(e);
          this.feed.system(this.o.now(), 'next_ofp_failed', {
            ...err.params,
            code: err.code,
            detail: err.detail,
            reason: err.reason ?? '',
          });
        }
      }
    } finally {
      this.closingNow = false;
      this.o.onChange();
    }
  }

  /** A pilot telex typed in the app (T12); the core reads it on the next tick. */
  async sendPilotMessage(input: unknown): Promise<null> {
    const s = this.session;
    if (s === null) throw new AppFailure('bad_state', 'no flight running', 'no_flight');
    const text = typeof input === 'string' ? input.trim() : '';
    if (text === '' || text.length > MAX_PILOT_TEXT) {
      throw new AppFailure(
        'invalid_input',
        `pilot message: 1..${MAX_PILOT_TEXT} characters`,
        'pilot_text',
        { max: String(MAX_PILOT_TEXT) },
      );
    }
    s.pilotMessage(text, this.o.now());
    this.o.onChange();
    return null;
  }

  /** Forgets the airline memory (T14 flags). */
  async clearMemory(): Promise<null> {
    if (this.session !== null) {
      throw new AppFailure('bad_state', 'stop the flight first', 'stop_flight_first');
    }
    await this.flagStore.set({});
    this.memory = [];
    this.o.onChange();
    return null;
  }

  /** Keeps the flight's flags for the next one; a failed write costs only the memory. */
  private async saveMemory(s: FlightSession): Promise<void> {
    try {
      this.memory = Object.keys(await this.flagStore.set(s.flags)).sort();
    } catch (e) {
      throw new AppFailure(
        'internal',
        `airline memory: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** "Run now" for an irregular scenario of the running flight; the result shows in the feed. */
  async forceScenario(id: unknown): Promise<null> {
    const s = this.session;
    if (s === null) throw new AppFailure('bad_state', 'no flight running', 'no_flight');
    if (typeof id !== 'string' || !s.irregular.some((x) => x.id === id)) {
      throw new AppFailure(
        'invalid_input',
        `not an irregular scenario of this flight: ${String(id)}`,
        'not_forceable',
        { id: String(id) },
      );
    }
    s.force(id);
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

  /**
   * T67: asks where to save, then writes one .zip of the logs, versions, settings without secrets
   * and (`withRecording`) the latest flight recording; shows it in the file manager. Returns the
   * file, or null when the user cancelled.
   */
  async exportDiagnostics(withRecording: unknown): Promise<string | null> {
    if (typeof withRecording !== 'boolean') {
      throw new AppFailure('invalid_input', 'diagnostics: with recording');
    }
    const d = this.o.diagnostics;
    if (d == null) throw new AppFailure('internal', 'diagnostics are not available');
    const now = this.o.now();
    const file = await d.choosePath(diagnosticsFileName(now));
    if (file === null) return null;
    const creds = await this.credentials();
    const state = this.state();
    const entries = await diagnosticsEntries({
      source: d,
      now,
      bridgeVersion: this.bridge.version,
      settings: await this.o.settings.get(),
      accounts: {
        simbriefUsername: creds.simbriefUsername !== '',
        hoppieCode: creds.hoppieCodeSet,
        aerodataboxKey: creds.aerodataboxKeySet,
        secureStorage: creds.secureStorage,
      },
      state: {
        session: state.session,
        phase: state.phase,
        waitingSimTime: state.waitingSimTime,
        bridge: state.bridge,
        transport: state.transport,
      },
      withRecording,
    });
    try {
      await writeFile(file, zip(entries, new Date(now)));
    } catch (e) {
      throw new AppFailure('internal', e instanceof Error ? e.message : String(e));
    }
    this.log.info(`diagnostics exported${withRecording ? ' with the latest recording' : ''}`);
    d.reveal?.(file);
    return file;
  }

  /** T77: the app version for the recording header; `+dev` outside the installer; none unknown. */
  private appVersion(): { appVersion?: string } {
    const a = this.o.about?.();
    if (a == null || a.version === '') return {};
    return { appVersion: a.dev ? `${a.version}+dev` : a.version };
  }

  /** T74: versions of the app and Electron and the build, for the "About" page. */
  getAbout(): AboutInfo {
    return (
      this.o.about?.() ?? {
        version: '',
        dev: true,
        electron: '',
        chrome: '',
        variant: PUBLIC_BUILD ? 'public' : 'personal',
      }
    );
  }

  /** T74: opens the EULA, the third-party notices or the component licences. */
  async openLegal(doc: unknown): Promise<null> {
    if (typeof doc !== 'string' || !(LEGAL_DOCS as readonly string[]).includes(doc)) {
      throw new AppFailure('invalid_input', 'licence file');
    }
    const open = this.o.openLegal;
    if (open == null) throw new AppFailure('internal', 'licence files are not available');
    try {
      await open(doc as LegalDoc);
    } catch (e) {
      throw new AppFailure('internal', e instanceof Error ? e.message : String(e));
    }
    return null;
  }

  /** T104: the smoke package in the Community folders of MSFS 2024. */
  async getSmokePackage(): Promise<SmokePackageView> {
    return this.smokePackageDo('view');
  }

  /** T104: installs or updates the smoke package (only on the user's button). */
  async installSmokePackage(): Promise<SmokePackageView> {
    return this.smokePackageDo('install');
  }

  /** T104: removes the smoke package from the Community folders. */
  async removeSmokePackage(): Promise<SmokePackageView> {
    return this.smokePackageDo('remove');
  }

  private async smokePackageDo(what: 'view' | 'install' | 'remove'): Promise<SmokePackageView> {
    const p = this.o.smokePackage;
    if (p == null) throw new AppFailure('internal', 'the smoke package is not available');
    try {
      const v = await p[what]();
      if (what !== 'view') {
        const where = v.targets.map(
          (t) => `${t.install} ${t.installed ?? '-'}${t.foreign ? ' (foreign)' : ''}`,
        );
        this.log.info(`smoke package ${what}: ${where.join(', ') || 'no MSFS 2024'}`);
      }
      return v;
    } catch (e) {
      throw new AppFailure('internal', e instanceof Error ? e.message : String(e));
    }
  }

  /** T75: the supervisor of the bridge process reports its state (null = nothing to report). */
  setBridgeProcess(status: BridgeProcessView | null): void {
    this.bridgeProcess = status;
    this.o.onChange();
  }

  /**
   * T75: the bridge process was started again after it stopped; the flight goes on, the feed says so
   * (like `sim_changed`, only while a flight runs).
   */
  noteBridgeRestarted(): void {
    if (this.session !== null) this.feed.system(this.o.now(), 'bridge_restarted', {});
    this.o.onChange();
  }

  /** The simulator the app works with now (T59): the connected one, else the fixed choice. */
  private async sim(): Promise<Simulator | null> {
    return activeSim((await this.o.settings.get()).simChoice, this.bridge.view);
  }

  /**
   * T59 (decision of 2026-10-23): another simulator during a flight is a feed line; the flight goes on
   * (lost telemetry and the position jump are handled as usual).
   */
  private onBridgeChange(): void {
    this.logBridge();
    const now = this.bridge.view.source;
    if (now === null || now === this.lastSim) return;
    const before = this.lastSim;
    this.lastSim = now;
    if (before !== null && this.session !== null) {
      this.feed.system(this.o.now(), 'sim_changed', {
        from: SIM_NAMES[before],
        to: SIM_NAMES[now],
      });
    }
  }

  /**
   * Link, sim and source of the bridge when one of them changes (T67), not every status frame.
   * `connecting` is left out: without a bridge every retry would add two lines.
   */
  private logBridge(): void {
    const v = this.bridge.view;
    if (v.link === 'connecting') return;
    const version = this.bridge.version === null ? '' : `, bridge ${this.bridge.version}`;
    const line =
      `bridge: link ${v.link}, sim ${v.sim ?? '-'}${v.source === null ? '' : ` (${v.source})`}` +
      `${version}${v.detail === null ? '' : `: ${v.detail}`}`;
    if (line === this.bridgeLogged) return;
    this.bridgeLogged = line;
    if (v.link === 'closed' && v.detail !== null) this.log.warn(line);
    else this.log.info(line);
  }

  private onTelemetry(s: TelemetrySnapshot): void {
    if (s.simUtcMs !== undefined) this.simOffsetMs = s.simUtcMs - s.t;
    this.session?.pushTelemetry(s);
  }

  private summary(
    ofp: Ofp,
    settings: Settings,
    stationTemplate = settings.stationTemplate,
  ): FlightSummary {
    const profile = selectProfile({ icao: ofp.aircraft.icao });
    let station: string;
    try {
      station = stationCallsign(stationTemplate, ofp);
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

/** `flight-report-SJX822-RCTP-RJBB-20261008.json`: the date of OUT (else of the schedule), UTC. */
export function reportFileName(r: FlightReport): string {
  const day = new Date(r.times.OUT.actual ?? r.times.OUT.plan ?? 0).toISOString().slice(0, 10);
  const name = `${r.callsign}-${r.origin}-${r.destination}`.replace(/[^A-Za-z0-9-]/g, '');
  return `flight-report-${name}-${day.replaceAll('-', '')}.json`;
}

/** What the UI shows of a lost flight (T64). */
function resumeOffer(f: UnfinishedFlight | null): ResumeOffer | null {
  if (f === null) return null;
  const { ofp } = f.recording.header;
  return {
    callsign: ofp.callsign,
    origin: ofp.origin.icao,
    destination: ofp.destination.icao,
    writtenAt: f.writtenAt,
  };
}

/** The flight clock of the last line of a recording. */
function lastTime(r: Recording): number {
  for (let i = r.events.length - 1; i >= 0; i--) {
    const e = r.events[i];
    if (e === undefined) continue;
    return 'now' in e ? e.now : e.t;
  }
  return r.header.recordedAt;
}

/** `2026-10-22` (UTC) for the feed. */
function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
