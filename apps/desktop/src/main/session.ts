import { basename } from 'node:path';
import {
  AcarsCore,
  type CompiledScenario,
  type CoreOutput,
  type DisplayProfile,
  type FlightPhase,
  type Ofp,
  type PilotMessage,
  stationCallsign,
  type TelemetrySnapshot,
  type Value,
} from '@acars/core';
import type { DataSourceKind, ExternalDataService } from '@acars/data-sources';
import { encodeLine, type RecordingEvent, recordingHeader } from '@acars/replay';
import type { Transport, TransportStatus } from '@acars/transport';
import type { ForceableScenario, TelemetryView, TransportView } from '../shared/api.js';
import type { Feed } from './feed.js';
import type { RecordingSink } from './recording.js';

/**
 * One flight: the core (phase machine + scenarios) wired to a transport and the feed.
 * Driven by the app's main loop: snapshots are queued as they arrive from the bridge and fed
 * to the core in order on the next {@link tick}, which also ticks the transport. Business
 * logic stays in the core and the transport (CLAUDE.md, invariant 5); this only moves data.
 * With a recording sink, every core input and output goes to a JSONL file (T11) that
 * `pnpm replay` plays back through the core in the same order.
 * Pilot telexes (T12) — received by the transport or typed in the app — go to the core with the
 * next tick; a scenario waiting for an answer makes the transport poll faster for a while.
 * External data (T13) fetched by the data service goes to the core with the first tick of a
 * batch, into the recording too; the core's `DATA_REQUEST` (`REQ WX` of an unknown airport)
 * asks the service to fetch it.
 */

export interface FlightSessionOptions {
  readonly ofp: Ofp;
  readonly scenarios: readonly CompiledScenario[];
  readonly profile: DisplayProfile;
  readonly stationTemplate: string;
  readonly transport: Transport;
  readonly feed: Feed;
  /** `per_session` scenario ids already run in this app session. */
  readonly sessionFired: readonly string[];
  readonly now: number;
  readonly recording?: RecordingSink | null;
  /** Live data (T13); null when the user turned it off. Ticked by the controller. */
  readonly data?: ExternalDataService | null;
  /** Airline memory from earlier flights (T14 `flags.*`). */
  readonly flags?: Readonly<Record<string, Value>>;
}

/** Names of the data sources in the feed (proper names, the same in every language). */
const DATA_SOURCE_NAMES: Readonly<Record<DataSourceKind, string>> = {
  wx: 'METAR/TAF (aviationweather.gov)',
  vatsim: 'VATSIM',
  eonet: 'NASA EONET',
  stands: 'OSM stands (Overpass)',
};

/** How long `REQ WX` waits for the data service to fetch an airport (core `dataWaitMs`). */
export const DATA_WAIT_MS = 60_000;

/** Snapshots kept while the main loop is late; older ones are dropped. */
const MAX_QUEUE = 120;

export class FlightSession {
  private readonly core: AcarsCore;
  private readonly transport: Transport;
  private readonly feed: Feed;
  private readonly queue: TelemetrySnapshot[] = [];
  /** Pilot telexes for the next core tick. */
  private inbound: PilotMessage[] = [];
  /** Scenarios started by hand, for the next core tick. */
  private forced: string[] = [];
  /** Irregular scenarios of this flight, for "run now". */
  readonly irregular: readonly ForceableScenario[];
  private readonly callsign: string;
  private readonly station: string;
  /** Transport telex id → feed entry id. */
  private readonly outbound = new Map<string, string>();
  private last: TelemetrySnapshot | null = null;
  private transportReason: string | null = null;
  /** The last transport status put into the feed was a problem. */
  private feedHasProblem = false;
  private stopped = false;
  private delayReported = false;
  private recording: RecordingSink | null;
  private readonly data: ExternalDataService | null;

  constructor(o: FlightSessionOptions) {
    this.core = AcarsCore.create({
      ofp: o.ofp,
      scenarios: o.scenarios,
      profile: o.profile,
      station: o.stationTemplate,
      sessionFired: o.sessionFired,
      ...(o.data == null ? {} : { dataWaitMs: DATA_WAIT_MS }),
      ...(o.flags === undefined ? {} : { flags: o.flags }),
    });
    this.data = o.data ?? null;
    this.irregular = o.scenarios
      .filter((c) => c.def.category === 'irregular' && c.def.trigger.on !== 'command')
      .map((c) => ({ id: c.id, title: { en: c.def.title, ru: c.def.title_ru ?? null } }))
      .sort((a, b) => a.title.en.localeCompare(b.title.en));
    this.callsign = o.ofp.callsign;
    this.station = stationCallsign(o.stationTemplate, o.ofp);
    this.transport = o.transport;
    this.feed = o.feed;
    this.recording = o.recording ?? null;
    this.record(
      recordingHeader({
        recordedAt: o.now,
        source: 'desktop',
        ofp: o.ofp,
        seed: null,
        station: o.stationTemplate,
        profile: o.profile,
        scenarios: o.scenarios.map((c) => c.id),
        sessionFired: o.sessionFired,
        ...(o.data == null ? {} : { dataWaitMs: DATA_WAIT_MS }),
        ...(o.flags === undefined || Object.keys(o.flags).length === 0 ? {} : { flags: o.flags }),
        ...probabilities(o.scenarios),
      }),
    );
    this.core.startFlight();
    this.record({ type: 'start', now: o.now });
    this.feed.system(o.now, 'flight_started', {
      callsign: o.ofp.callsign,
      transport: o.transport.kind,
    });
    if (this.recording !== null) {
      this.feed.system(o.now, 'recording', { file: basename(this.recording.file) });
    }
  }

  get phase(): FlightPhase {
    return this.core.phase;
  }

  get sessionFired(): readonly string[] {
    return this.core.sessionFired;
  }

  /** Airline memory now (T14): saved by the controller for the next flight. */
  get flags(): Readonly<Record<string, Value>> {
    return this.core.flags;
  }

  get telemetry(): TelemetryView | null {
    const s = this.last;
    if (s === null) return null;
    return {
      t: s.t,
      aircraftTitle: s.aircraftTitle,
      onGround: s.onGround,
      altFt: s.altFt,
      gsKt: s.gsKt,
      vsFpm: s.vsFpm,
      fuelKg: s.fuelKg,
    };
  }

  get transportView(): TransportView {
    return {
      kind: this.transport.kind === 'mock' ? 'mock' : 'hoppie',
      status: this.transport.status,
      pending: this.transport.pending,
      reason: this.transportReason,
    };
  }

  pushTelemetry(s: TelemetrySnapshot): void {
    if (this.stopped) return;
    this.queue.push(s);
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
  }

  /** A pilot telex typed in the app: into the feed now, to the core with the next tick. */
  pilotMessage(text: string, now: number): void {
    if (this.stopped) return;
    this.feed.add({
      kind: 'inbound',
      t: now,
      from: this.callsign,
      to: this.station,
      type: 'app',
      text,
    });
    this.inbound.push({ from: this.callsign, type: 'telex', text });
  }

  /** Starts a scenario by hand with the next tick (the core checks its conditions). */
  force(id: string): void {
    if (!this.stopped) this.forced.push(id);
  }

  tick(now: number): void {
    if (this.stopped) return;
    const batch: (TelemetrySnapshot | null)[] = this.queue.splice(0);
    if (batch.length === 0) batch.push(null);
    const fetched = this.data?.take(now) ?? { update: null, notes: [] };
    for (const n of fetched.notes) {
      const source = DATA_SOURCE_NAMES[n.source];
      if (n.ok) this.feed.system(n.t, 'data_restored', { source });
      else this.feed.system(n.t, 'data_failed', { source, error: n.error ?? '' });
    }
    batch.forEach((s, i) => {
      if (s !== null) this.last = s;
      // Pilot telexes and fetched data go with the first tick of the batch.
      const inbound = i === 0 ? this.inbound.splice(0) : [];
      const data = i === 0 ? fetched.update : null;
      const force = i === 0 ? this.forced.splice(0) : [];
      const more = {
        ...(inbound.length > 0 ? { inbound } : {}),
        ...(data === null ? {} : { data }),
        ...(force.length > 0 ? { force } : {}),
      };
      this.record({ type: 'tick', now, telemetry: s, ...more });
      this.apply(this.core.tick({ now, telemetry: s, ...more }), now);
    });
    this.transport.tick();
    this.drainTransport();
  }

  /** User decision at ON_BLOCK; throws in any other phase. */
  endFlight(to: 'TURNAROUND' | 'DONE', now: number): void {
    const out = this.core.endFlight(to, now);
    this.record({ type: 'end', now, to });
    this.apply(out, now);
    this.transport.tick();
    this.drainTransport();
  }

  /** Stops ticking. Telexes not sent yet are dropped. */
  stop(now: number): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const feedId of this.outbound.values()) {
      this.feed.updateOutbound(feedId, { delivery: 'dropped' });
    }
    this.outbound.clear();
    this.record({ type: 'stop', now });
    this.recording?.close();
    this.recording = null;
    this.feed.system(now, 'flight_stopped', { phase: this.core.phase });
  }

  /** A failed write ends the recording, not the flight. */
  private record(line: Parameters<typeof encodeLine>[0]): void {
    const r = this.recording;
    if (r === null) return;
    try {
      r.write(encodeLine(line));
    } catch (e) {
      this.recording = null;
      try {
        r.close();
      } catch {
        // already broken
      }
      const error = e instanceof Error ? e.message : String(e);
      const t = 'now' in line ? line.now : 't' in line ? line.t : line.recordedAt;
      this.feed.system(t, 'recording_failed', { error });
    }
  }

  private apply(out: CoreOutput, now: number): void {
    const delay = this.core.delayMs;
    if (!this.delayReported && delay !== null) {
      this.delayReported = true;
      if (delay > 0) {
        this.feed.system(now, 'late_start', {
          min: String(Math.round(delay / 60_000)),
        });
      }
    }
    for (const e of out.events) {
      switch (e.type) {
        case 'PHASE_CHANGE':
          this.feed.system(e.t, 'phase', { from: e.from, to: e.to });
          break;
        case 'OOOI_OUT':
        case 'OOOI_OFF':
        case 'OOOI_ON':
        case 'OOOI_IN':
          this.feed.system(e.t, 'oooi', { kind: e.type.slice(5) });
          break;
        case 'TELEMETRY_LOST':
          this.feed.system(e.t, 'telemetry_lost');
          break;
        case 'TELEMETRY_RESTORED':
          this.feed.system(e.t, 'telemetry_restored', {
            gapSec: String(Math.round(e.gapMs / 1000)),
          });
          break;
        case 'DISCONTINUITY':
          this.feed.system(e.t, 'discontinuity', { nm: e.jumpNm.toFixed(1) });
          break;
        case 'SCENARIO_ERROR':
          this.feed.system(e.t, 'scenario_error', { id: e.id, error: e.error });
          break;
        case 'REPLY_EXPECTED':
          // The transport caps this itself (Hoppie: 3 min of faster polling).
          this.transport.expectReply(e.timeoutMs);
          break;
        case 'FORCED':
          this.feed.system(e.t, `forced_${e.result}`, { id: e.id, detail: e.detail ?? '' });
          break;
        case 'DATA_REQUEST':
          this.data?.requestWx(e.icao);
          break;
        case 'REPLY_TIMEOUT':
          this.feed.system(e.t, 'reply_timeout', { id: e.id, option: e.option });
          break;
        default:
          break;
      }
    }
    for (const m of out.outbound) {
      this.record(outLine(m));
      const entry = {
        kind: 'outbound' as const,
        t: m.t,
        from: m.from,
        to: m.to,
        scenarioId: m.scenarioId,
        text: m.message.text,
      };
      try {
        const id = this.transport.send({ from: m.from, to: m.to, message: m.message });
        this.outbound.set(id, this.feed.add({ ...entry, delivery: 'queued', detail: null }));
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        this.feed.add({ ...entry, delivery: 'failed', detail });
      }
    }
  }

  private drainTransport(): void {
    for (const e of this.transport.takeEvents()) {
      switch (e.type) {
        case 'SENT': {
          const id = this.outbound.get(e.id);
          if (id !== undefined)
            this.feed.updateOutbound(id, { delivery: 'sent', detail: null, t: e.t });
          this.outbound.delete(e.id);
          break;
        }
        case 'SEND_RETRY': {
          const id = this.outbound.get(e.id);
          const detail = `#${e.attempt}: ${e.reason}`;
          if (id !== undefined) this.feed.updateOutbound(id, { delivery: 'retry', detail });
          break;
        }
        case 'SEND_FAILED': {
          const id = this.outbound.get(e.id);
          if (id !== undefined)
            this.feed.updateOutbound(id, { delivery: 'failed', detail: e.reason });
          this.outbound.delete(e.id);
          break;
        }
        case 'INBOUND':
          this.inbound.push({ from: e.message.from, type: e.message.type, text: e.message.packet });
          this.feed.add({
            kind: 'inbound',
            t: e.t,
            from: e.message.from,
            to: e.message.to,
            type: e.message.type,
            text: e.message.packet,
          });
          break;
        case 'STATUS':
          this.onStatus(e.t, e.status, e.reason ?? null);
          break;
      }
    }
  }

  private onStatus(t: number, status: TransportStatus, reason: string | null): void {
    this.transportReason = status === 'ok' || status === 'idle' ? null : reason;
    // `idle → ok` is the normal start; only problems and the recovery from them go to the feed.
    if (status === 'degraded' || status === 'halted' || this.feedHasProblem) {
      this.feed.system(t, 'transport_status', { status, reason: reason ?? '' });
    }
    this.feedHasProblem = status === 'degraded' || status === 'halted';
  }
}

function outLine(m: CoreOutput['outbound'][number]): RecordingEvent {
  return {
    type: 'out',
    t: m.t,
    scenarioId: m.scenarioId,
    from: m.from,
    to: m.to,
    text: m.message.text,
  };
}

/** Probabilities that differ from the scenario files (user's chances), for the recording. */
function probabilities(list: readonly CompiledScenario[]): {
  probabilities?: Record<string, number>;
} {
  const out: Record<string, number> = {};
  for (const c of list) if (c.probability !== (c.def.probability ?? 1)) out[c.id] = c.probability;
  return Object.keys(out).length === 0 ? {} : { probabilities: out };
}
