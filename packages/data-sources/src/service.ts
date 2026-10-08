import {
  type AtcStation,
  checkExtDataUpdate,
  type ExtDataUpdate,
  type FlightPhase,
  type NaturalEvent,
  type Ofp,
  type ParkingStand,
  type WxReport,
} from '@acars/core';
import { DataSourceError, type FetchContext, type HttpClient, ICAO_RE } from './common.js';
import { fetchEonetEvents } from './eonet.js';
import { fetchStands } from './stands.js';
import { fetchVatsimStations, stationsFor, type VatsimStation } from './vatsim.js';
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
 * once (cached 30 days).
 */

export type DataSourceKind = 'wx' | 'vatsim' | 'eonet' | 'stands';
export const DATA_SOURCES: readonly DataSourceKind[] = ['wx', 'vatsim', 'eonet', 'stands'];

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
export const DATA_POLICY: Readonly<Record<DataSourceKind, Policy>> = {
  wx: { refreshMs: 10 * MIN, cacheMs: 5 * MIN, retryMs: 2 * MIN, maxTries: null },
  vatsim: { refreshMs: 5 * MIN, cacheMs: MIN, retryMs: 2 * MIN, maxTries: null },
  eonet: { refreshMs: 60 * MIN, cacheMs: 30 * MIN, retryMs: 15 * MIN, maxTries: null },
  stands: { refreshMs: null, cacheMs: 30 * 24 * 60 * MIN, retryMs: 10 * MIN, maxTries: 3 },
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
  } = { wx: {}, atc: null, events: null, stands: null };
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

  /** A new flight (also right after the OFP is loaded, to prefetch). Fetching starts on tick. */
  startFlight(ofp: Ofp, now: number): void {
    if (this.flight?.ofp === ofp) return;
    this.generation++;
    const airports = [ofp.origin.icao, ofp.destination.icao, ...ofp.alternates.map((a) => a.icao)];
    this.flight = { ofp, airports: [...new Set(airports)].filter((i) => ICAO_RE.test(i)) };
    this.src = new Map(
      DATA_SOURCES.filter((k) => this.enabled.has(k)).map((k) => [
        k,
        { inFlight: false, nextAt: now, fails: 0, fetched: false, failing: false },
      ]),
    );
    this.wxExtra.clear();
    this.pending = { wx: {}, atc: null, events: null, stands: null };
  }

  stopFlight(): void {
    this.generation++;
    this.flight = null;
    this.src.clear();
    this.wxExtra.clear();
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
      if (kind === 'stands' && s.fetched) continue;
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
    this.pending = { wx: {}, atc: null, events: null, stands: null };
    const notes = this.notes;
    this.notes = [];
    const has =
      Object.keys(p.wx).length > 0 || p.atc !== null || p.events !== null || p.stands !== null;
    if (!has) return { update: null, notes };
    return {
      update: {
        t: now,
        ...(Object.keys(p.wx).length > 0 ? { wx: p.wx } : {}),
        ...(p.atc === null ? {} : { atc: p.atc }),
        ...(p.events === null ? {} : { events: p.events }),
        ...(p.stands === null ? {} : { stands: p.stands }),
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
        let stations = (await this.cached('vatsim', now, kind, checkStations)) as
          | VatsimStation[]
          | undefined;
        if (stations === undefined) {
          stations = await fetchVatsimStations(this.ctx);
          await this.store('vatsim', now, stations);
        }
        const o = flight.ofp;
        const atc = stationsFor(stations, [
          { icao: o.origin.icao, iata: o.origin.iata },
          { icao: o.destination.icao, iata: o.destination.iata },
        ]);
        return () => {
          this.pending.atc = atc;
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
