import {
  type CompiledScenario,
  destinationPoint,
  fireFlips,
  fireGroup,
  fireTruckCount,
  medicGroup,
  type Ofp,
  type RescueCommand,
  type SimCommand,
  type SmokeCommand,
  selectProfile,
  stationCallsign,
  type TelemetrySnapshot,
  upwindSide,
  vehicleTitles,
} from '@acars/core';
import { type DataCache, ExternalDataService } from '@acars/data-sources';
import {
  DRONE_RISK_DEFAULT,
  droneProbability,
  loadScenarios,
  ScenarioLoadError,
} from '@acars/scenarios';
import type { HttpClient, Transport } from '@acars/transport';
import type {
  AppState,
  CredentialsView,
  FlightSummary,
  ScenarioInfo,
  Settings,
  SettingsPatch,
} from '../shared/api.js';
import { BridgeClient, type CommandResult, type SocketLike, type Timers } from './bridge.js';
import { AppFailure } from './errors.js';
import { Feed } from './feed.js';
import type { Flags, FlagsStore } from './flags.js';
import type { OpenRecording, RecordingSink } from './recording.js';
import type { SecretStore } from './secrets.js';
import { FlightSession } from './session.js';
import type { SettingsStore } from './settings.js';
import { fetchOfp, normalizeSimbriefUsername } from './simbrief.js';
import { specialGroupOn, specialGroups } from './special.js';
import { VdgsWriter } from './vdgs.js';

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
  /** Cache of the external data (T13); default in memory. */
  readonly dataCache?: DataCache;
  /** GSX VDGS message folder (T22, `gsxVdgsDir`); null or absent = no GSX. */
  readonly vdgsDir?: string | null;
  /** Airline memory between flights (T14); default in memory only. */
  readonly flags?: FlagsStore;
}

/** Title of a scenario in the UI languages. */
export const titleText = (c: CompiledScenario) => ({ en: c.def.title, ru: c.def.title_ru ?? null });

/** Irregular events: category `irregular`, not a pilot-command handler (`cmd_divert`). */
export const isIrregularEvent = (c: CompiledScenario): boolean =>
  c.def.category === 'irregular' && c.def.trigger.on !== 'command';

/** The scenario whose chance depends on the destination country (T38). */
export const DRONE_SCENARIO_ID = 'drone_activity';

/** Scenarios about the next leg with the same aircraft; off with the "turnaround" setting off. */
export const TURNAROUND_SCENARIOS: readonly string[] = [
  'next_leg',
  'aircraft_change',
  'welcome_turnaround',
];

/** Identifies the app to aviationweather.gov, VATSIM, NASA and Overpass (they ask for it). */
export const DATA_USER_AGENT = 'ACARS-Sim/0.1 (flight simulator ACARS; personal use)';

/** Hoppie logon codes: printable ASCII without spaces (they go into a URL/form field). */
const LOGON_RE = /^[\x21-\x7e]{4,64}$/;
/** A RapidAPI key: letters and digits (T30). */
const RAPIDAPI_KEY_RE = /^[A-Za-z0-9]{20,100}$/;
/** Longer than any MCDU free text; the core reads words of A–Z0–9 only. */
const MAX_PILOT_TEXT = 200;

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
  /** External data (T13): prefetches for the loaded OFP, feeds the running flight. */
  private readonly data: ExternalDataService;
  /** A `smoke_start` was sent and not yet taken down (T34). */
  private smokeOn = false;
  private readonly flagStore: FlagsStore | { get(): Promise<Flags>; set(f: Flags): Promise<Flags> };
  /** Names of the stored flags, for the UI. */
  private memory: readonly string[] = [];
  private readonly vdgs: VdgsWriter;
  /**
   * Rescue services asked for this flight (T54): the latest airport, the senior fire level (PAN →
   * MAYDAY: `standby` → `full`, never back) and whether an ambulance is wanted. Null = none.
   */
  private rescue: {
    airport: string;
    runway: string | null;
    windFromDeg: number | null;
    fire: 'full' | 'standby' | null;
    medic: boolean;
  } | null = null;
  /** A `rescue_start` was sent and not yet taken down. */
  private rescueOn = false;
  /** Bumped on every rescue request, so a late lookup of an older one is dropped. */
  private rescueSeq = 0;
  /** Siren (T54): waits for the roll-out of a `full` landing, sounds until the aircraft stops. */
  private siren: 'idle' | 'on' | 'done' = 'idle';
  private sirenSetting = false;

  constructor(private readonly o: AppControllerOptions) {
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
    this.vdgs = new VdgsWriter(o.vdgsDir ?? null);
    this.bridge = new BridgeClient({
      port: 0,
      createSocket: o.createSocket,
      timers: o.timers,
      now: o.now,
      onTelemetry: (s) => this.onTelemetry(s),
      onChange: o.onChange,
      onCommandResult: (r) => this.onCommandResult(r),
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
    this.vdgs.clear(); // left over from a crash
    this.memory = Object.keys(await this.flagStore.get()).sort();
  }

  dispose(): void {
    this.bridge.stop();
    this.data.stopFlight();
    this.session?.stop(this.o.now());
    this.session = null;
    this.vdgs.clear();
    this.stopSmoke();
    this.stopRescue();
  }

  /**
   * A command for the simulator (T21): VDGS text (T22) goes to GSX's message folder, the rest
   * to the bridge. Only failures reach the feed (a v1 bridge, a write error), so a working
   * channel stays quiet; without GSX the VDGS text is dropped silently. Returns the bridge
   * command id, null for VDGS text.
   */
  sendSimCommand(c: SimCommand): string | null {
    if (c.command === 'vdgs') {
      try {
        this.vdgs.show(c);
      } catch (e) {
        this.feed.system(this.o.now(), 'sim_command_failed', {
          command: 'vdgs',
          error: 'failed',
          detail: e instanceof Error ? e.message : String(e),
        });
      }
      return null;
    }
    if (c.command === 'smoke') {
      void this.sendSmoke(c);
      return null;
    }
    if (c.command === 'rescue') {
      void this.sendRescue(c);
      return null;
    }
    return this.bridge.sendCommand(c.command, c.args);
  }

  /**
   * Smoke column (T34): the runway's middle comes from OurAirports (cached), moved by the
   * scenario's random offset; the bridge gets plain coordinates. A runway without coordinates,
   * or no network, is one line in the feed.
   */
  private async sendSmoke(c: SmokeCommand): Promise<void> {
    const fail = (detail: string) => {
      this.feed.system(this.o.now(), 'sim_command_failed', {
        command: 'smoke',
        error: 'failed',
        detail,
      });
      this.o.onChange();
    };
    if (c.action === 'stop') {
      this.stopSmoke();
      return;
    }
    if (c.runway === null) return fail('no planned runway in the OFP');
    const mid = await this.data.runwayPoint(c.airport, c.runway, this.o.now());
    if (mid === null) return fail(`no coordinates for ${c.airport} RWY ${c.runway}`);
    const p = c.offset ? besideRunway(mid, c.offset.alongNm, c.offset.sideNm) : mid;
    if (this.session === null) return; // the flight ended while the file was fetched
    this.smokeOn = true;
    this.bridge.sendCommand('smoke_start', {
      lat: Math.round(p.lat * 1e6) / 1e6,
      lon: Math.round(p.lon * 1e6) / 1e6,
    });
  }

  /** Takes the smoke down (end of the flight, app exit); a no-op if none was started. */
  private stopSmoke(): void {
    if (!this.smokeOn) return;
    this.smokeOn = false;
    this.bridge.sendCommand('smoke_stop');
  }

  /**
   * Rescue services (T54, game rules of 2026-10-17): the landing runway from OurAirports (planned,
   * else the longest, landing into the METAR wind), fire trucks by the aircraft's category group and models by the airport (large
   * or not, North America or not), the ambulance by region. The bridge gets the whole request each
   * time; it keeps the vehicles that already stand when only the level or the ambulance changes.
   */
  private async sendRescue(c: RescueCommand): Promise<void> {
    const settings = await this.o.settings.get();
    if (!settings.rescue) return;
    if (c.action === 'stop') {
      this.stopRescue();
      return;
    }
    const prev = this.rescue;
    const rank = (f: 'full' | 'standby' | 'medical' | null) =>
      f === 'full' ? 2 : f === 'standby' ? 1 : 0;
    const asked = c.level === 'medical' ? null : c.level;
    const next = {
      airport: c.airport,
      runway: c.runway,
      windFromDeg: c.windFromDeg,
      fire: rank(asked) >= rank(prev?.fire ?? null) ? asked : (prev?.fire ?? null),
      medic: c.level === 'medical' || (prev?.medic ?? false),
    };
    if (
      prev !== null &&
      prev.airport === next.airport &&
      prev.fire === next.fire &&
      prev.medic === next.medic
    ) {
      return; // a lower level after a higher one, or the same again
    }
    this.rescue = next;
    const seq = ++this.rescueSeq;
    const fail = (detail: string) => {
      this.feed.system(this.o.now(), 'sim_command_failed', {
        command: 'rescue',
        error: 'failed',
        detail,
      });
      this.o.onChange();
    };
    const now = this.o.now();
    const rwy = await this.data.landingRunway(next.airport, next.runway, now, next.windFromDeg);
    if (seq !== this.rescueSeq || this.session === null) return; // superseded or flight over
    if (rwy === null) {
      return fail(
        `no runway coordinates for ${next.airport}${next.runway ? ` RWY ${next.runway}` : ''}`,
      );
    }
    const large = next.fire === null ? false : await this.data.isLargeAirport(next.airport, now);
    if (seq !== this.rescueSeq || this.session === null) return;
    const ofp = this.ofp;
    const t = settings.rescueTitles;
    const fireTitles =
      next.fire === null
        ? []
        : vehicleTitles(
            fireGroup(t, next.airport, large === true),
            fireTruckCount(ofp?.aircraft.icao),
          );
    const medicTitles = next.medic ? vehicleTitles(medicGroup(t, next.airport), 1) : [];
    if (fireTitles.length === 0 && medicTitles.length === 0) {
      return fail('no vehicle titles in the settings');
    }
    this.rescueOn = true;
    this.bridge.sendCommand('rescue_start', {
      level: next.fire ?? 'medical',
      thrLat: Math.round(rwy.thrLat * 1e6) / 1e6,
      thrLon: Math.round(rwy.thrLon * 1e6) / 1e6,
      hdg: Math.round(rwy.headingDeg * 10) / 10 === 360 ? 0 : Math.round(rwy.headingDeg * 10) / 10,
      lengthM: rwy.lengthM,
      side: upwindSide(rwy.headingDeg, next.windFromDeg),
      fire: fireTitles.join('|'),
      fireFlip: fireFlips(fireTitles, settings.rescueFlipped),
      medic: medicTitles.join('|'),
    });
  }

  /** Takes the rescue vehicles down (alarm over, end of the flight, app exit). */
  private stopRescue(): void {
    this.rescue = null;
    this.rescueSeq++;
    this.siren = 'idle';
    if (!this.rescueOn) return;
    this.rescueOn = false;
    this.bridge.sendCommand('rescue_stop');
  }

  /** The siren follows the roll-out of a `full` landing until the aircraft first stops. */
  private updateSiren(s: TelemetrySnapshot): void {
    const phase = this.session?.phase ?? null;
    const rollOut = phase === 'LANDED' || phase === 'TAXI_IN';
    if (this.siren === 'idle') {
      if (this.rescueOn && this.rescue?.fire === 'full' && rollOut && s.onGround && s.gsKt >= 1) {
        this.siren = 'on';
      }
    } else if (this.siren === 'on' && (!rollOut || s.gsKt < 1)) {
      this.siren = 'done';
    }
  }

  private onCommandResult(r: CommandResult): void {
    if (r.ok) return;
    this.feed.system(this.o.now(), 'sim_command_failed', {
      command: r.command,
      error: r.error ?? '',
      detail: r.detail ?? '',
    });
    this.o.onChange();
  }

  /** Main loop, ~1 Hz. */
  tick(now: number): void {
    this.data.tick(now, this.session?.phase ?? null);
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
      atc: s?.atc ?? null,
      link: s?.link ?? null,
      feed: this.feed.entries,
      memory: this.memory,
      irregular: s?.irregular ?? [],
      siren: this.sirenSetting && this.siren === 'on',
    };
  }

  // --- settings & scenarios ---

  getSettings(): Promise<Settings> {
    return this.o.settings.get();
  }

  async updateSettings(patch: SettingsPatch): Promise<Settings> {
    const s = await this.o.settings.update(patch);
    this.bridge.setPort(s.bridgePort);
    this.sirenSetting = s.rescueSiren;
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
        description:
          c.def.description === undefined
            ? null
            : { en: c.def.description, ru: c.def.description_ru ?? null },
        category: c.def.category,
        enabledByDefault: c.def.enabled_by_default,
        enabled: chosen[c.id] ?? c.def.enabled_by_default,
        defaultChance: Math.round(c.probability * 1000) / 10,
        chance: isIrregularEvent(c) ? (chances[c.id] ?? null) : null,
        droneRiskDefault: c.id === DRONE_SCENARIO_ID ? DRONE_RISK_DEFAULT : null,
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

  /** Chance of an irregular scenario, percent (null = the file's); takes effect next flight. */
  async setScenarioChance(id: string, percent: unknown): Promise<ScenarioInfo[]> {
    const c = this.scenarios.find((x) => x.id === id);
    if (c === undefined) throw new AppFailure('invalid_input', `unknown scenario ${id}`);
    if (!isIrregularEvent(c)) {
      throw new AppFailure('invalid_input', `${id}: chances are set for irregular scenarios only`);
    }
    if (percent !== null && typeof percent !== 'number') {
      throw new AppFailure('invalid_input', 'chance: a number 0..100 or null');
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

  /** The user's RapidAPI key for AeroDataBox (T30, docs/07 C1); used from the next OFP load. */
  async setAerodataboxKey(input: unknown): Promise<CredentialsView> {
    const key = typeof input === 'string' ? input.trim() : '';
    if (!RAPIDAPI_KEY_RE.test(key)) {
      throw new AppFailure('invalid_input', 'RapidAPI key: 20..100 letters and digits');
    }
    await this.o.secrets.set('aerodataboxKey', key);
    return this.credentials();
  }

  async clearAerodataboxKey(): Promise<CredentialsView> {
    await this.o.secrets.delete('aerodataboxKey');
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
    if (this.session !== null) throw new AppFailure('bad_state', 'flight already running');
    const ofp = this.ofp;
    if (ofp === null) throw new AppFailure('bad_state', 'load the OFP first');
    if (this.scenarioError !== null) throw new AppFailure('scenarios_invalid', this.scenarioError);
    const settings = await this.o.settings.get();
    const flight = this.summary(ofp, settings);
    this.sirenSetting = settings.rescueSiren;
    let transport: Transport;
    if (settings.transport === 'hoppie') {
      const logon = await this.o.secrets.get('hoppieLogon');
      if (logon === null) throw new AppFailure('no_hoppie_code', 'not set');
      transport = this.o.createTransport({ kind: 'hoppie', logon });
    } else {
      transport = this.o.createTransport({ kind: 'offline' });
    }
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
      .filter((c) => settings.scenarios[c.id] ?? c.def.enabled_by_default)
      .map((c) => {
        const pct = isIrregularEvent(c) ? settings.chances[c.id] : undefined;
        const base = pct === undefined ? c.probability : pct / 100;
        const probability =
          c.id === DRONE_SCENARIO_ID ? droneProbability(base, droneTable, droneCountry) : base;
        return probability === c.probability ? c : { ...c, probability };
      });
    await this.prefetch(ofp, settings);
    const flags = await this.flagStore.get();
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
      data: settings.liveData ? this.data : null,
      flags,
      minGapMs: settings.messageGapSec * 1000,
      ...(settings.hubIcao === '' ? {} : { hub: settings.hubIcao }),
      ...(settings.simTime ? { simTime: true } : {}),
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
            },
          }
        : {}),
    });
    // The station needs the FIR boundaries (live data).
    if (settings.xatc && !settings.liveData) this.feed.system(now, 'atc_needs_data');
    // The conditional VHF stations come from live data; without them only SATCOM is a link.
    if (settings.datalink && !settings.liveData) this.feed.system(now, 'link_needs_data');
    if (Object.keys(flags).length > 0) {
      this.feed.system(now, 'memory', { names: Object.keys(flags).sort().join(', ') });
    }
    this.flight = flight;
    this.o.onChange();
    return null;
  }

  async stopFlight(): Promise<null> {
    const s = this.session;
    if (s === null) throw new AppFailure('bad_state', 'no flight running');
    s.stop(this.o.now());
    this.data.stopFlight();
    this.vdgs.clear();
    this.stopSmoke();
    this.stopRescue();
    await this.saveMemory(s);
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
    await this.saveMemory(s);
    this.o.onChange();
    return null;
  }

  /** A pilot telex typed in the app (T12); the core reads it on the next tick. */
  async sendPilotMessage(input: unknown): Promise<null> {
    const s = this.session;
    if (s === null) throw new AppFailure('bad_state', 'no flight running');
    const text = typeof input === 'string' ? input.trim() : '';
    if (text === '' || text.length > MAX_PILOT_TEXT) {
      throw new AppFailure('invalid_input', `pilot message: 1..${MAX_PILOT_TEXT} characters`);
    }
    s.pilotMessage(text, this.o.now());
    this.o.onChange();
    return null;
  }

  /** Forgets the airline memory (T14 flags). */
  async clearMemory(): Promise<null> {
    if (this.session !== null) throw new AppFailure('bad_state', 'stop the flight first');
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
    if (s === null) throw new AppFailure('bad_state', 'no flight running');
    if (typeof id !== 'string' || !s.irregular.some((x) => x.id === id)) {
      throw new AppFailure(
        'invalid_input',
        `not an irregular scenario of this flight: ${String(id)}`,
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

  private onTelemetry(s: TelemetrySnapshot): void {
    this.session?.pushTelemetry(s);
    this.updateSiren(s);
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

/**
 * A point beside a runway: `alongNm` from its middle in the direction of the runway (negative =
 * back), then `sideNm` off its axis (positive = right of that direction).
 */
function besideRunway(
  mid: { lat: number; lon: number; headingDeg: number },
  alongNm: number,
  sideNm: number,
): { lat: number; lon: number } {
  const move = (p: { lat: number; lon: number }, deg: number, nm: number) =>
    nm === 0 ? p : destinationPoint(p, nm > 0 ? deg : deg + 180, Math.abs(nm));
  return move(move(mid, mid.headingDeg, alongNm), mid.headingDeg + 90, sideNm);
}
