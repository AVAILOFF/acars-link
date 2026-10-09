import {
  type AirportFrequency,
  type AirportInfo,
  type AtcStation,
  type CenterStation,
  checkExtDataUpdate,
  type ExtDataUpdate,
  type FirArea,
  type FlightPhase,
  type NatTrack,
  type NaturalEvent,
  type Ofp,
  type ParkingStand,
  type SpaceLaunch,
  type WxReport,
} from '@acars/core';
import { DataSourceError, type FetchContext, type HttpClient, ICAO_RE } from './common.js';
import { fetchEonetEvents } from './eonet.js';
import { fetchLaunches } from './launches.js';
import { fetchNatTracks } from './nattrak.js';
import { fetchAirportFrequencies } from './ourairports.js';
import { fetchStands } from './stands.js';
import { fetchVatsim, stationsFor, type VatsimStation } from './vatsim.js';
import {
  airportInfo,
  centersFor,
  fetchVatspy,
  routeFirs,
  type VatsimCenter,
  type VatspyData,
} from './vatspy.js';
import { fetchWx } from './wx.js';

/**
 * Fetches external data for a flight (T13) and hands it to the core as `ExtDataUpdate`s.
 * Driven by the app's main loop (`tick(now, phase)`, ~1 Hz): no timers of its own, at most
 * one request per source in flight, a cache in front of every source, a back-off after a
 * failure, and never an exception to the caller — a source that fails just leaves the core
 * without its data (graceful degradation, docs/06), with a note for the feed.
 *
 * Schedule: weather of the OFP airports at start and every 10 min, plus any airport the
 * pilot asks for (`REQ WX`, core event `DATA_REQUEST`); VATSIM at start and every 5 min
 * from the climb to the approach; EONET at start and every hour; the destination's stands
 * once (cached 30 days). With the ROPS station (T23, `startFlight(…, { firs: true })`): the
 * VATSpy FIR boundaries once (cached 7 days) — the FIRs along the route go to the core, and
 * with every VATSIM fetch the online centres covering them; FIR and country of the origin and
 * destination and the origin's frequencies from OurAirports (T24, cached 30 days). Space
 * launches (T28) at start and every hour, cached 30 min: Launch Library allows 15 requests an
 * hour without a key. The window is from an hour before the flight started to an hour after
 * now + the OFP block time (the remaining time is not known here; more is harmless). With the
 * ROPS station: the active NAT tracks from natTrak (T27) at start and every hour, cached 30 min.
 */

export type DataSourceKind =
  | 'wx'
  | 'vatsim'
  | 'eonet'
  | 'stands'
  | 'firs'
  | 'freqs'
  | 'launches'
  | 'nattracks';
export const DATA_SOURCES: readonly DataSourceKind[] = [
  'wx',
  'vatsim',
  'eonet',
  'stands',
  'firs',
  'freqs',
  'launches',
  'nattracks',
];
/** Sources of the ROPS station only (`startFlight(…, { firs: true })`). */
const ROPS_SOURCES: ReadonlySet<DataSourceKind> = new Set(['firs', 'freqs', 'nattracks']);
/** ROPS sources fetched once per flight (the others refresh on their schedule). */
const ROPS_ONCE: ReadonlySet<DataSourceKind> = new Set(['firs', 'freqs']);

export interface CacheEntry {
  /** When the value was fetched, epoch ms. */
  readonly t: number;
  readonly value: unknown;
}

/** Cache of fetched (parsed) data. Entries may come from disk: they are checked on read. */
export interface DataCache {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, entry: CacheEntry): Promise<void>;
}

export class MemoryCache implements DataCache {
  private readonly map = new Map<string, CacheEntry>();
  async get(key: string): Promise<CacheEntry | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, entry: CacheEntry): Promise<void> {
    this.map.set(key, entry);
  }
}

/** A source started or stopped working (for the feed; one note per change). */
export interface DataNote {
  readonly t: number;
  readonly source: DataSourceKind;
  readonly ok: boolean;
  readonly error: string | null;
}

interface Policy {
  /** Refresh period while the flight runs; null = once. */
  readonly refreshMs: number | null;
  /** A cached value younger than this is used instead of a request. */
  readonly cacheMs: number;
  /** Wait after a failure. */
  readonly retryMs: number;
  /** Failures in a row before the source gives up for the flight; null = never. */
  readonly maxTries: number | null;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
export const DATA_POLICY: Readonly<Record<DataSourceKind, Policy>> = {
  wx: { refreshMs: 10 * MIN, cacheMs: 5 * MIN, retryMs: 2 * MIN, maxTries: null },
  vatsim: { refreshMs: 5 * MIN, cacheMs: MIN, retryMs: 2 * MIN, maxTries: null },
  eonet: { refreshMs: 60 * MIN, cacheMs: 30 * MIN, retryMs: 15 * MIN, maxTries: null },
  stands: { refreshMs: null, cacheMs: 30 * 24 * 60 * MIN, retryMs: 10 * MIN, maxTries: 3 },
  firs: { refreshMs: null, cacheMs: 7 * 24 * 60 * MIN, retryMs: 10 * MIN, maxTries: 3 },
  freqs: { refreshMs: null, cacheMs: 30 * 24 * 60 * MIN, retryMs: 10 * MIN, maxTries: 3 },
  launches: { refreshMs: 60 * MIN, cacheMs: 30 * MIN, retryMs: 15 * MIN, maxTries: null },
  nattracks: { refreshMs: 60 * MIN, cacheMs: 30 * MIN, retryMs: 15 * MIN, maxTries: null },
};

/** VATSIM refreshes only here (the first fetch at start goes in any phase). */
const VATSIM_PHASES: ReadonlySet<FlightPhase> = new Set([
  'CLIMB',
  'CRUISE',
  'DESCENT',
  'APPROACH',
  'GO_AROUND',
]);

export interface DataServiceOptions {
  readonly http: HttpClient;
  readonly cache?: DataCache;
  readonly userAgent: string;
  /** Sources to use (default all). */
  readonly sources?: readonly DataSourceKind[];
  readonly timeoutMs?: number;
}

interface SourceState {
  inFlight: boolean;
  nextAt: number;
  fails: number;
  fetched: boolean;
  failing: boolean;
}

interface Flight {
  readonly ofp: Ofp;
  /** Origin, destination, alternates. */
  readonly airports: readonly string[];
  /** FIR boundaries and centres for the ROPS station (T23). */
  readonly firs: boolean;
  /** When the flight started (`startFlight`), epoch ms. */
  readonly startedAt: number;
}

export class ExternalDataService {
  private readonly ctx: FetchContext;
  private readonly cache: DataCache;
  private readonly enabled: ReadonlySet<DataSourceKind>;
  private flight: Flight | null = null;
  /** Bumped per flight: results of an old flight's requests are dropped. */
  private generation = 0;
  private src = new Map<DataSourceKind, SourceState>();
  /** Airports the pilot asked for, fetched with the next weather request. */
  private wxExtra = new Set<string>();
  private pending: {
    wx: Record<string, WxReport | null>;
    atc: Record<string, AtcStation[]> | null;
    events: NaturalEvent[] | null;
    stands: { icao: string; list: ParkingStand[] } | null;
    firs: FirArea[] | null;
    centers: CenterStation[] | null;
    airports: Record<string, AirportInfo> | null;
    freqs: { icao: string; list: AirportFrequency[] } | null;
    launches: SpaceLaunch[] | null;
    natTracks: NatTrack[] | null;
  } = empty();
  /** VATSpy data of the flight (T23) and the ids of the route's FIRs. */
  private vatspy: { data: VatspyData; route: ReadonlySet<string> } | null = null;
  /** Centres of the last VATSIM fetch, mapped once VATSpy is there. */
  private rawCenters: readonly VatsimCenter[] | null = null;
  private notes: DataNote[] = [];
  private readonly running = new Set<Promise<void>>();

  constructor(o: DataServiceOptions) {
    this.ctx = {
      http: o.http,
      userAgent: o.userAgent,
      ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
    };
    this.cache = o.cache ?? new MemoryCache();
    this.enabled = new Set(o.sources ?? DATA_SOURCES);
  }

  /**
   * A new flight (also right after the OFP is loaded, to prefetch). Fetching starts on tick.
   * `firs`: also the FIR boundaries and centres for the ROPS station (T23).
   */
  startFlight(ofp: Ofp, now: number, opts: { readonly firs?: boolean } = {}): void {
    const firs = opts.firs === true;
    if (this.flight?.ofp === ofp && this.flight.firs === firs) return;
    this.generation++;
    const airports = [ofp.origin.icao, ofp.destination.icao, ...ofp.alternates.map((a) => a.icao)];
    this.flight = {
      ofp,
      airports: [...new Set(airports)].filter((i) => ICAO_RE.test(i)),
      firs,
      startedAt: now,
    };
    this.src = new Map(
      DATA_SOURCES.filter((k) => this.enabled.has(k) && (!ROPS_SOURCES.has(k) || firs)).map((k) => [
        k,
        { inFlight: false, nextAt: now, fails: 0, fetched: false, failing: false },
      ]),
    );
    this.wxExtra.clear();
    this.pending = empty();
    this.vatspy = null;
    this.rawCenters = null;
  }

  stopFlight(): void {
    this.generation++;
    this.flight = null;
    this.src.clear();
    this.wxExtra.clear();
    this.vatspy = null;
    this.rawCenters = null;
  }

  /** Weather for an airport outside the OFP, as soon as possible (core `DATA_REQUEST`). */
  requestWx(icao: string): void {
    const s = this.src.get('wx');
    if (s === undefined || !ICAO_RE.test(icao)) {
      // No weather source: answer "no data" so the core does not wait the full time.
      if (ICAO_RE.test(icao) && this.flight !== null) this.pending.wx[icao] = null;
      return;
    }
    this.wxExtra.add(icao);
  }

  tick(now: number, phase: FlightPhase | null): void {
    if (this.flight === null) return;
    for (const [kind, s] of this.src) {
      // The pilot's airports go at once (unless the source is backing off after a failure).
      const asked = kind === 'wx' && this.wxExtra.size > 0 && s.fails === 0;
      if (s.inFlight || (now < s.nextAt && !asked)) continue;
      const p = DATA_POLICY[kind];
      if (p.maxTries !== null && s.fails >= p.maxTries) continue;
      if ((kind === 'stands' || ROPS_ONCE.has(kind)) && s.fetched) continue;
      if (kind === 'vatsim' && s.fetched && (phase === null || !VATSIM_PHASES.has(phase))) {
        s.nextAt = now + (p.refreshMs ?? 0);
        continue;
      }
      this.run(kind, s, now);
    }
  }

  /** Data fetched since the last call (stamped `now`), and source status changes. */
  take(now: number): { update: ExtDataUpdate | null; notes: DataNote[] } {
    const p = this.pending;
    this.pending = empty();
    const notes = this.notes;
    this.notes = [];
    const has =
      Object.keys(p.wx).length > 0 ||
      p.atc !== null ||
      p.events !== null ||
      p.stands !== null ||
      p.firs !== null ||
      p.centers !== null ||
      p.airports !== null ||
      p.freqs !== null ||
      p.launches !== null ||
      p.natTracks !== null;
    if (!has) return { update: null, notes };
    return {
      update: {
        t: now,
        ...(Object.keys(p.wx).length > 0 ? { wx: p.wx } : {}),
        ...(p.atc === null ? {} : { atc: p.atc }),
        ...(p.events === null ? {} : { events: p.events }),
        ...(p.stands === null ? {} : { stands: p.stands }),
        ...(p.firs === null ? {} : { firs: p.firs }),
        ...(p.centers === null ? {} : { centers: p.centers }),
        ...(p.airports === null ? {} : { airports: p.airports }),
        ...(p.freqs === null ? {} : { freqs: p.freqs }),
        ...(p.launches === null ? {} : { launches: p.launches }),
        ...(p.natTracks === null ? {} : { natTracks: p.natTracks }),
      },
      notes,
    };
  }

  /** Resolves when no request is running (tests). */
  async settle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  private run(kind: DataSourceKind, s: SourceState, now: number): void {
    const flight = this.flight as Flight;
    const gen = this.generation;
    s.inFlight = true;
    const extra = kind === 'wx' ? [...this.wxExtra] : [];
    if (kind === 'wx') this.wxExtra.clear();
    const job = this.fetchKind(kind, flight, now, extra)
      .then(
        (apply) => {
          if (gen !== this.generation) return;
          apply();
          s.fetched = true;
          s.fails = 0;
          s.nextAt = now + (DATA_POLICY[kind].refreshMs ?? Number.POSITIVE_INFINITY);
          if (s.failing) this.notes.push({ t: now, source: kind, ok: true, error: null });
          s.failing = false;
        },
        (e: unknown) => {
          if (gen !== this.generation) return;
          s.fails++;
          s.nextAt = now + DATA_POLICY[kind].retryMs;
          // Pilot's airports are asked again with the next try.
          for (const i of extra) this.wxExtra.add(i);
          if (!s.failing) {
            const error = e instanceof DataSourceError ? e.message : 'internal error';
            this.notes.push({ t: now, source: kind, ok: false, error });
          }
          s.failing = true;
        },
      )
      .finally(() => {
        s.inFlight = false;
        this.running.delete(job);
      });
    this.running.add(job);
  }

  /** Fetches (or reads from the cache) and returns how to put the result into `pending`. */
  private async fetchKind(
    kind: DataSourceKind,
    flight: Flight,
    now: number,
    extra: readonly string[],
  ): Promise<() => void> {
    switch (kind) {
      case 'wx': {
        const icaos = [...new Set([...flight.airports, ...extra])];
        const wx: Record<string, WxReport | null> = {};
        const missing: string[] = [];
        for (const icao of icaos) {
          const c = await this.cached(`wx:${icao}`, now, kind, (v) =>
            checkExtDataUpdate({ t: 0, wx: { [icao]: v } }),
          );
          if (c === undefined) missing.push(icao);
          else wx[icao] = c as WxReport | null;
        }
        if (missing.length > 0) {
          const got = await fetchWx(this.ctx, missing);
          for (const icao of missing) {
            const r = got[icao] ?? null;
            wx[icao] = r;
            await this.store(`wx:${icao}`, now, r);
          }
        }
        return () => Object.assign(this.pending.wx, wx);
      }
      case 'vatsim': {
        let feed = (await this.cached('vatsim', now, kind, checkVatsim)) as
          | { stations: VatsimStation[]; centers: VatsimCenter[] }
          | undefined;
        if (feed === undefined) {
          feed = await fetchVatsim(this.ctx);
          await this.store('vatsim', now, feed);
        }
        const o = flight.ofp;
        const atc = stationsFor(feed.stations, [
          { icao: o.origin.icao, iata: o.origin.iata },
          { icao: o.destination.icao, iata: o.destination.iata },
        ]);
        const centers = feed.centers;
        return () => {
          this.pending.atc = atc;
          if (!flight.firs) return;
          this.rawCenters = centers;
          this.mapCenters();
        };
      }
      case 'firs': {
        let data = (await this.cached('vatspy', now, kind, checkVatspy)) as VatspyData | undefined;
        if (data === undefined) {
          data = await fetchVatspy(this.ctx);
          await this.store('vatspy', now, data);
        }
        const route = routeFirs(data, flight.ofp);
        const vatspy = { data, route: new Set(route.map((f) => f.id)) };
        const o = flight.ofp;
        const airports = {
          [o.origin.icao]: airportInfo(data, o.origin.icao),
          [o.destination.icao]: airportInfo(data, o.destination.icao),
        };
        return () => {
          this.vatspy = vatspy;
          this.pending.firs = route;
          this.pending.airports = airports;
          this.mapCenters();
        };
      }
      case 'freqs': {
        const icao = flight.ofp.origin.icao;
        let list = (await this.cached(`freqs:${icao}`, now, kind, (v) =>
          checkExtDataUpdate({ t: 0, freqs: { icao, list: v } }),
        )) as AirportFrequency[] | undefined;
        if (list === undefined) {
          list = await fetchAirportFrequencies(this.ctx, icao);
          await this.store(`freqs:${icao}`, now, list);
        }
        const freqs = { icao, list };
        return () => {
          this.pending.freqs = freqs;
        };
      }
      case 'eonet': {
        let events = (await this.cached('eonet', now, kind, (v) =>
          checkExtDataUpdate({ t: 0, events: v }),
        )) as NaturalEvent[] | undefined;
        if (events === undefined) {
          events = await fetchEonetEvents(this.ctx);
          await this.store('eonet', now, events);
        }
        const list = events;
        return () => {
          this.pending.events = list;
        };
      }
      case 'launches': {
        let launches = (await this.cached('launches', now, kind, (v) =>
          checkExtDataUpdate({ t: 0, launches: v }),
        )) as SpaceLaunch[] | undefined;
        if (launches === undefined) {
          const t = flight.ofp.times;
          const blockMs = (t.schedBlockSec ?? t.estTimeEnrouteSec) * 1000;
          launches = await fetchLaunches(this.ctx, flight.startedAt - HOUR, now + blockMs + HOUR);
          await this.store('launches', now, launches);
        }
        const list = launches;
        return () => {
          this.pending.launches = list;
        };
      }
      case 'nattracks': {
        let tracks = (await this.cached('nattracks', now, kind, (v) =>
          checkExtDataUpdate({ t: 0, natTracks: v }),
        )) as NatTrack[] | undefined;
        if (tracks === undefined) {
          tracks = await fetchNatTracks(this.ctx);
          await this.store('nattracks', now, tracks);
        }
        const list = tracks;
        return () => {
          this.pending.natTracks = list;
        };
      }
      case 'stands': {
        const icao = flight.ofp.destination.icao;
        let list = (await this.cached(`stands:${icao}`, now, kind, (v) =>
          checkExtDataUpdate({ t: 0, stands: { icao, list: v } }),
        )) as ParkingStand[] | undefined;
        if (list === undefined) {
          list = await fetchStands(this.ctx, flight.ofp.destination);
          // An airport without mapped stands is a valid answer, cached like any other.
          await this.store(`stands:${icao}`, now, list);
        }
        const stands = { icao, list };
        return () => {
          if (stands.list.length > 0) this.pending.stands = stands;
        };
      }
    }
  }

  /** Centres of the last VATSIM fetch that cover the route's FIRs (T23). */
  private mapCenters(): void {
    if (this.vatspy === null || this.rawCenters === null) return;
    this.pending.centers = centersFor(this.rawCenters, this.vatspy.data, this.vatspy.route);
  }

  /** A fresh cached value (checked), or undefined. Cache errors count as a miss. */
  private async cached(
    key: string,
    now: number,
    kind: DataSourceKind,
    check: (v: unknown) => unknown,
  ): Promise<unknown> {
    try {
      const e = await this.cache.get(key);
      if (e === null || !(now - e.t >= 0 && now - e.t < DATA_POLICY[kind].cacheMs))
        return undefined;
      check(e.value);
      return e.value;
    } catch {
      return undefined;
    }
  }

  private async store(key: string, now: number, value: unknown): Promise<void> {
    try {
      await this.cache.set(key, { t: now, value });
    } catch {
      // A cache that cannot write only costs a request next time.
    }
  }
}

function empty() {
  return {
    wx: {},
    atc: null,
    events: null,
    stands: null,
    firs: null,
    centers: null,
    airports: null,
    freqs: null,
    launches: null,
    natTracks: null,
  };
}

function checkVatsim(v: unknown): void {
  if (typeof v !== 'object' || v === null) throw new DataSourceError('bad cached VATSIM data');
  const { stations, centers } = v as { stations?: unknown; centers?: unknown };
  checkStations(stations);
  const ok =
    Array.isArray(centers) &&
    centers.every(
      (c: unknown) =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as VatsimCenter).callsign === 'string' &&
        typeof (c as VatsimCenter).frequency === 'string',
    );
  if (!ok) throw new DataSourceError('bad cached VATSIM data');
}

function checkVatspy(v: unknown): void {
  if (typeof v !== 'object' || v === null) throw new DataSourceError('bad cached VATSpy data');
  const { firs, prefixes, airports, countries } = v as {
    firs?: unknown;
    prefixes?: unknown;
    airports?: unknown;
    countries?: unknown;
  };
  checkExtDataUpdate({ t: 0, firs });
  const ok =
    typeof prefixes === 'object' &&
    prefixes !== null &&
    Object.values(prefixes).every(
      (l) => Array.isArray(l) && l.every((f) => typeof f === 'string'),
    ) &&
    typeof airports === 'object' &&
    airports !== null &&
    Object.values(airports).every((f) => typeof f === 'string') &&
    typeof countries === 'object' &&
    countries !== null &&
    Object.values(countries).every((c) => typeof c === 'string');
  if (!ok) throw new DataSourceError('bad cached VATSpy data');
}

function checkStations(v: unknown): void {
  const ok =
    Array.isArray(v) &&
    v.every(
      (s: unknown) =>
        typeof s === 'object' &&
        s !== null &&
        typeof (s as VatsimStation).prefix === 'string' &&
        typeof (s as VatsimStation).callsign === 'string',
    );
  if (!ok) throw new DataSourceError('bad cached VATSIM data');
  checkExtDataUpdate({ t: 0, atc: { XXXX: v } });
}
