import { basename } from 'node:path';
import {
  AcarsCore,
  type CompiledScenario,
  type CoreOutput,
  type DisplayProfile,
  type FlightPhase,
  type Ofp,
  type TelemetrySnapshot,
} from '@acars/core';
import { encodeLine, type RecordingEvent, recordingHeader } from '@acars/replay';
import type { Transport, TransportStatus } from '@acars/transport';
import type { TelemetryView, TransportView } from '../shared/api.js';
import type { Feed } from './feed.js';
import type { RecordingSink } from './recording.js';

/**
 * One flight: the core (phase machine + scenarios) wired to a transport and the feed.
 * Driven by the app's main loop: snapshots are queued as they arrive from the bridge and fed
 * to the core in order on the next {@link tick}, which also ticks the transport. Business
 * logic stays in the core and the transport (CLAUDE.md, invariant 5); this only moves data.
 * With a recording sink, every core input and output goes to a JSONL file (T11) that
 * `pnpm replay` plays back through the core in the same order.
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
}

/** Snapshots kept while the main loop is late; older ones are dropped. */
const MAX_QUEUE = 120;

export class FlightSession {
  private readonly core: AcarsCore;
  private readonly transport: Transport;
  private readonly feed: Feed;
  private readonly queue: TelemetrySnapshot[] = [];
  /** Transport telex id → feed entry id. */
  private readonly outbound = new Map<string, string>();
  private last: TelemetrySnapshot | null = null;
  private transportReason: string | null = null;
  /** The last transport status put into the feed was a problem. */
  private feedHasProblem = false;
  private stopped = false;
  private delayReported = false;
  private recording: RecordingSink | null;

  constructor(o: FlightSessionOptions) {
    this.core = AcarsCore.create({
      ofp: o.ofp,
      scenarios: o.scenarios,
      profile: o.profile,
      station: o.stationTemplate,
      sessionFired: o.sessionFired,
    });
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

  tick(now: number): void {
    if (this.stopped) return;
    const batch = this.queue.splice(0);
    if (batch.length === 0) {
      this.record({ type: 'tick', now, telemetry: null });
      this.apply(this.core.tick({ now, telemetry: null }), now);
    }
    for (const s of batch) {
      this.last = s;
      this.record({ type: 'tick', now, telemetry: s });
      this.apply(this.core.tick({ now, telemetry: s }), now);
    }
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
