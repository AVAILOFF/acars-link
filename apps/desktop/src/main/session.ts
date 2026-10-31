// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { basename } from 'node:path';
import {
  AcarsCore,
  type CompiledScenario,
  type CoreOutput,
  cpdlcPacket,
  type DisplayProfile,
  type FlightPhase,
  type FlightReport,
  type Ofp,
  type PilotMessage,
  type SimCommand,
  stationCallsign,
  type TelemetrySnapshot,
  type Value,
  type XatcOptions,
} from '@acars/core';
import type { DataSourceKind, ExternalDataService } from '@acars/data-sources';
import {
  encodeLine,
  type Recording,
  type RecordingEvent,
  recordedCoreOptions,
  recordingHeader,
} from '@acars/replay';
import type { Transport, TransportStatus } from '@acars/transport';
import type {
  AtcView,
  ForceableScenario,
  LinkWindow,
  PendingReply,
  SystemCode,
  TelemetryView,
  TransportView,
} from '../shared/api.js';
import type { Feed } from './feed.js';
import { MessageHints } from './hints.js';
import { type Log, NO_LOG } from './log.js';
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
 * A flight the app lost (closed, crashed) is restored from its recording (T64): the recorded inputs
 * go through the core again, the feed is rebuilt, and the telexes that never left are sent anew.
 * Closing the flight at the gate takes the flight report (T69), written as a `summary` line.
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
  /** Minimum time between airline telexes, ms (core `minGapMs`). */
  readonly minGapMs?: number;
  /** The user's hub (core `hub`, T53); absent = OpenFlights. */
  readonly hub?: string;
  /**
   * Time from the sim: the flight's clock is the sim's (UTC), not the PC's. The core starts with
   * the first snapshot that has `simUtcMs`; the recording holds the shifted times.
   */
  readonly simTime?: boolean;
  /** Commands to the simulator the core produced (T21), sent on by the controller. */
  readonly simCommands?: (c: SimCommand) => void;
  /** XATC station (T23); absent = off. */
  readonly xatc?: XatcOptions;
  /** Data link simulation (T31); absent = off. */
  readonly datalink?: {
    readonly satcom: boolean;
    readonly icaoHex?: string;
    readonly headerInText?: boolean;
  };
  /**
   * Restore this flight (T64): the core is built from the header, the events are run again; the
   * recording sink writes on at the end of the same file. The other options must match the header.
   */
  readonly resume?: Recording;
  /** File log of the app (T67): transport status and send failures; default none. */
  readonly log?: Log;
  /** Version of the app for the recording header (T77); absent = not recorded. */
  readonly appVersion?: string;
}

/** The recorded flight does not run the same way again (other scenarios, another app version). */
export class ResumeError extends Error {
  override readonly name = 'ResumeError';
}

type Outbound = CoreOutput['outbound'][number];

/** Names of the data sources in the feed (proper names, the same in every language). */
const DATA_SOURCE_NAMES: Readonly<Record<DataSourceKind, string>> = {
  wx: 'METAR/TAF (aviationweather.gov)',
  vatsim: 'VATSIM',
  eonet: 'NASA EONET',
  stands: 'OSM stands (Overpass)',
  firs: 'VATSpy (FIR boundaries)',
  freqs: 'OurAirports (frequencies)',
  vhf: 'OurAirports (VHF stations)',
  divert: 'OurAirports (diversion airports)',
  launches: 'TheSpaceDevs (launches)',
  nattracks: 'natTrak (NAT tracks)',
  spacewx: 'NOAA SWPC (space weather)',
  aurora: 'NOAA SWPC (aurora)',
  ash: 'SIGMET VA (aviationweather.gov)',
  quakes: 'USGS (earthquakes)',
  holidays: 'Nager.Date (public holidays)',
  f1: 'Jolpica (F1)',
  nhl: 'NHL',
  connex: 'AeroDataBox (onward flights)',
  routes: 'AeroDataBox (route statistics)',
};

/** Person names of new flights (core `namesVersion`, T43); recorded in the header. */
const NAMES_VERSION = 2;
/** Next leg of new flights (core `nextLegVersion`, T53); recorded in the header. */
const NEXT_LEG_VERSION = 3;
/** Start close to the departure (core `lateStartVersion`): messages fitted to the time left. */
const LATE_START_VERSION = 3;

/** How long `REQ WX` waits for the data service to fetch an airport (core `dataWaitMs`). */
export const DATA_WAIT_MS = 60_000;

/**
 * Closing a finished flight waits for scenarios that go on within this much flight time (U-04):
 * the longest reply wait of the scenarios is 20 min (2026-10-22).
 */
export const CLOSE_WAIT_MS = 30 * 60_000;

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
  /** Hints to messages and answers (T57). */
  private readonly hints: MessageHints;
  /** Scenario id → feed entry of its latest message (T57: the message an answer is for). */
  private readonly lastMessage = new Map<string, string>();
  private last: TelemetrySnapshot | null = null;
  private transportReason: string | null = null;
  /** The last transport status put into the feed was a problem. */
  private feedHasProblem = false;
  private stopped = false;
  private delayReported = false;
  private recording: RecordingSink | null;
  private readonly data: ExternalDataService | null;
  private readonly simCommands: (c: SimCommand) => void;
  /** ATC callsigns the transport polls (T23), as last told. */
  private listening: readonly string[] = [];
  /** Set while restoring (T64): the replayed telexes go here, not to the transport or the file. */
  private replayOut: ((m: Outbound, feedId: string) => void) | null = null;
  /** `out` lines written so far (T64: `sent` lines name them by this index). */
  private outCount = 0;
  /** Transport telex id → index of its `out` line. */
  private readonly outIndex = new Map<string, number>();
  /** The `resume` line waits for the first core tick (with "time from the sim", its clock). */
  private resumePending = false;
  /** "Time from the sim" is on; the flight waits for the first sim time. */
  private readonly simTime: boolean;
  private readonly log: Log;
  /** Sim UTC minus the bridge clock, ms; null until the first snapshot with `simUtcMs`. */
  private simOffset: number | null = null;
  /** The flight report (T69), taken by {@link endFlight}; null before. */
  private closedReport: FlightReport | null = null;
  /** The recording file (null = none, or a temporary one only for restoring). */
  readonly recordingFile: string | null;

  constructor(o: FlightSessionOptions) {
    this.simTime = o.simTime === true;
    this.log = o.log ?? NO_LOG;
    this.core = AcarsCore.create(
      o.resume !== undefined
        ? recordedCoreOptions(o.resume.header, o.scenarios)
        : {
            ofp: o.ofp,
            scenarios: o.scenarios,
            profile: o.profile,
            station: o.stationTemplate,
            sessionFired: o.sessionFired,
            ...(o.data == null ? {} : { dataWaitMs: DATA_WAIT_MS }),
            ...(o.flags === undefined ? {} : { flags: o.flags }),
            ...(o.minGapMs === undefined ? {} : { minGapMs: o.minGapMs }),
            ...(o.xatc === undefined ? {} : { xatc: o.xatc }),
            ...(o.datalink === undefined ? {} : { datalink: o.datalink }),
            namesVersion: NAMES_VERSION,
            nextLegVersion: NEXT_LEG_VERSION,
            lateStartVersion: LATE_START_VERSION,
            ...(o.hub === undefined ? {} : { hub: o.hub }),
          },
    );
    this.data = o.data ?? null;
    this.hints = new MessageHints(o.scenarios);
    this.simCommands = o.simCommands ?? (() => {});
    this.irregular = o.scenarios
      .filter((c) => c.def.category === 'irregular' && c.def.trigger.on !== 'command')
      .map((c) => ({ id: c.id, title: { en: c.def.title, ru: c.def.title_ru ?? null } }))
      .sort((a, b) => a.title.en.localeCompare(b.title.en));
    this.callsign = o.ofp.callsign;
    this.station = stationCallsign(o.stationTemplate, o.ofp);
    this.transport = o.transport;
    this.feed = o.feed;
    this.recording = o.recording ?? null;
    this.recordingFile =
      this.recording === null || this.recording.temporary === true
        ? null
        : basename(this.recording.file);
    if (o.resume !== undefined) {
      this.restore(o.resume, o.now);
      return;
    }
    this.record(
      recordingHeader({
        recordedAt: o.now,
        source: 'desktop',
        ...(o.appVersion === undefined ? {} : { appVersion: o.appVersion }),
        ofp: o.ofp,
        seed: null,
        station: o.stationTemplate,
        profile: o.profile,
        scenarios: o.scenarios.map((c) => c.id),
        sessionFired: o.sessionFired,
        ...(o.data == null ? {} : { dataWaitMs: DATA_WAIT_MS }),
        ...(o.flags === undefined || Object.keys(o.flags).length === 0 ? {} : { flags: o.flags }),
        ...probabilities(o.scenarios),
        ...(o.minGapMs === undefined || o.minGapMs === 0 ? {} : { minGapMs: o.minGapMs }),
        ...(o.xatc === undefined ? {} : { xatc: o.xatc }),
        ...(o.datalink === undefined ? {} : { datalink: o.datalink }),
        namesVersion: NAMES_VERSION,
        nextLegVersion: NEXT_LEG_VERSION,
        lateStartVersion: LATE_START_VERSION,
        ...(o.hub === undefined ? {} : { hub: o.hub }),
        simTime: this.simTime,
      }),
    );
    this.core.startFlight();
    this.record({ type: 'start', now: o.now });
    this.feed.system(o.now, 'flight_started', {
      callsign: o.ofp.callsign,
      transport: o.transport.kind,
    });
    if (this.recording !== null && this.recording.temporary !== true) {
      this.feed.system(o.now, 'recording', { file: basename(this.recording.file) });
    }
  }

  get phase(): FlightPhase {
    return this.core.phase;
  }

  /** The flight report taken when the flight was closed at the gate (T69); null before. */
  get report(): FlightReport | null {
    return this.closedReport;
  }

  /** The flight can go on after a restart (T64): its recording is being written. */
  get resumable(): boolean {
    return !this.stopped && this.recording !== null;
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

  /** Scenarios waiting for the pilot's answer (T57), from the core's state. */
  get pendingReplies(): readonly PendingReply[] {
    if (this.stopped) return [];
    return this.core.pendingReplies.map((r) => ({
      scenarioId: r.scenarioId,
      messageId: this.lastMessage.get(r.scenarioId) ?? null,
      station: this.station,
      options: r.options,
      hints: this.hints.forReply(r),
      default: r.default,
      minutesLeft: Math.ceil(r.leftMs / 60_000),
    }));
  }

  /** "Time from the sim" is on and no snapshot with `simUtcMs` came yet: the core waits (U-16). */
  get waitingSimTime(): boolean {
    return !this.stopped && this.simTime && this.simOffset === null;
  }

  /**
   * What is still on its way (U-04): telexes held for the gap, on the data link or in the network
   * queue, and scenarios that go on within {@link CLOSE_WAIT_MS} of flight time (the turnaround
   * plan 2 min after IN, an answer being waited for). A watcher that waits for hours (fuel against
   * the plan, `timeout_min: 720`) or for a phase that will not come does not hold the flight.
   * The core keeps its runs in its state only: read it when the flight is over, not every tick.
   */
  get waiting(): { readonly messages: number; readonly scenarios: number } {
    if (this.stopped) return { messages: 0, scenarios: 0 };
    const link = this.core.linkView;
    const st = this.core.getState();
    const now = st.phase.flightTimeMs;
    const soon = (ms: number | null | undefined) => ms != null && ms - now <= CLOSE_WAIT_MS;
    const scenarios = st.engine.runs.filter((r) =>
      r.untilFlightMs === null && r.reply === null && r.until === null
        ? r.untilPhase === null // between steps: goes on with the next tick
        : soon(r.untilFlightMs) || soon(r.reply?.untilFlightMs) || soon(r.until?.deadlineMs),
    ).length;
    return {
      messages:
        this.core.queued + (link?.held ?? 0) + (link?.inFlight ?? 0) + this.transport.pending,
      scenarios,
    };
  }

  /** XATC station (T23): where to log on and where the aircraft is logged on; null = off. */
  get atc(): AtcView | null {
    return this.core.atc;
  }

  /** Data link (T31): the link now and what waits on it; null = off. */
  get link(): LinkWindow | null {
    const v = this.core.linkView;
    if (v === null) return null;
    return {
      kind: v.link?.kind ?? null,
      station: v.link?.station ?? null,
      distNm: v.link?.distNm ?? null,
      elevDeg: v.link?.elevDeg ?? null,
      held: v.held,
      inFlight: v.inFlight,
      header: v.header,
      last: v.last,
    };
  }

  get transportView(): TransportView {
    return {
      outbox: this.core.queued,
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
  pilotMessage(text: string, wallNow: number): void {
    if (this.stopped) return;
    this.feed.add({
      kind: 'inbound',
      t: this.clock(wallNow),
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

  /**
   * Wall time → the flight's clock. With "time from the sim" the clock is the wall clock shifted by
   * the sim's offset, fixed by the first snapshot that carries `simUtcMs` (so the phase machine,
   * which scales time by `simRate` itself, keeps its meaning); otherwise the wall clock.
   */
  private clock(t: number): number {
    return t + (this.simOffset ?? 0);
  }

  /** Waiting for the first sim time: nothing reaches the core before the clock is known. */
  private anchorSimTime(): boolean {
    if (!this.simTime || this.simOffset !== null) return true;
    const first = this.queue.find((s) => s.simUtcMs !== undefined);
    if (first?.simUtcMs === undefined) return false;
    this.simOffset = first.simUtcMs - first.t;
    return true;
  }

  tick(wallNow: number): void {
    if (this.stopped) return;
    if (!this.anchorSimTime()) {
      this.transport.tick();
      this.drainTransport();
      return;
    }
    const now = this.clock(wallNow);
    if (this.resumePending) {
      this.resumePending = false;
      this.record({ type: 'resume', now });
    }
    const batch: (TelemetrySnapshot | null)[] = this.queue
      .splice(0)
      .map((s) => (this.simOffset === null ? s : { ...s, t: s.t + this.simOffset }));
    if (batch.length === 0) batch.push(null);
    const taken = this.data?.take(wallNow) ?? { update: null, notes: [] };
    const fetched =
      this.simOffset === null || taken.update === null
        ? taken
        : { ...taken, update: { ...taken.update, t: this.clock(taken.update.t) } };
    for (const n of fetched.notes) {
      const source = DATA_SOURCE_NAMES[n.source];
      if (n.ok) this.feed.system(this.clock(n.t), 'data_restored', { source });
      else this.feed.system(this.clock(n.t), 'data_failed', { source, error: n.error ?? '' });
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
  endFlight(to: 'TURNAROUND' | 'DONE', wallNow: number): void {
    const now = this.clock(wallNow);
    const out = this.core.endFlight(to, now);
    this.record({ type: 'end', now, to });
    this.apply(out, now);
    // T69: the report of the flight as it was closed; the turnaround after it is the next leg's.
    this.closedReport = this.core.report();
    this.record({ type: 'summary', now, report: this.closedReport });
    this.transport.tick();
    this.drainTransport();
  }

  /** Stops ticking. Telexes not sent yet are dropped. */
  stop(wallNow: number): void {
    if (this.stopped) return;
    const now = this.clock(wallNow);
    this.stopped = true;
    for (const feedId of this.outbound.values()) {
      this.feed.updateOutbound(feedId, { delivery: 'dropped' });
    }
    this.outbound.clear();
    this.record({ type: 'stop', now });
    const r = this.recording;
    this.recording = null;
    if (r?.end) r.end();
    else r?.close();
    this.feed.system(now, 'flight_stopped', { phase: this.core.phase });
  }

  /**
   * The app quits during the flight (T64): the recording is closed without `stop`, so the flight
   * goes on at the next start; telexes not sent yet are sent then.
   */
  suspend(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.recording?.close();
    this.recording = null;
  }

  /**
   * Runs the recorded events through the core again (T64): the same inputs in the same order give
   * the same state (invariant 4). Each telex must come out as recorded; the ones that never left
   * the app go to the transport now.
   */
  private restore(r: Recording, wallNow: number): void {
    const recorded = r.events.filter((e) => e.type === 'out');
    const done = new Map<number, 'sent' | 'failed'>();
    for (const e of r.events) if (e.type === 'sent') done.set(e.n, e.result);
    const resend: { n: number; m: Outbound; feedId: string }[] = [];
    let lastNow = wallNow;
    this.replayOut = (m, feedId) => {
      const n = this.outCount++;
      const want = recorded[n];
      if (
        want === undefined ||
        want.scenarioId !== m.scenarioId ||
        want.text !== m.message.text ||
        want.to !== m.to
      ) {
        throw new ResumeError(`telex #${n + 1} (${m.scenarioId}) differs from the recording`);
      }
      const result = done.get(n);
      if (result === undefined) resend.push({ n, m, feedId });
      else this.feed.updateOutbound(feedId, { delivery: result, detail: null });
    };
    try {
      for (const e of r.events) {
        switch (e.type) {
          case 'start':
            this.core.startFlight();
            this.feed.system(e.now, 'flight_started', {
              callsign: this.callsign,
              transport: this.transport.kind,
            });
            break;
          case 'tick':
            lastNow = e.now;
            if (e.telemetry !== null) this.last = e.telemetry;
            for (const m of e.inbound ?? []) {
              this.feed.add({
                kind: 'inbound',
                t: e.now,
                from: m.from,
                to: m.to ?? this.station,
                type: m.type,
                text: m.text,
              });
            }
            this.apply(
              this.core.tick({
                now: e.now,
                telemetry: e.telemetry,
                ...(e.inbound === undefined ? {} : { inbound: e.inbound }),
                ...(e.data === undefined ? {} : { data: e.data }),
                ...(e.force === undefined ? {} : { force: e.force }),
              }),
              e.now,
            );
            break;
          case 'end':
            lastNow = e.now;
            this.apply(this.core.endFlight(e.to, e.now), e.now);
            this.closedReport = this.core.report();
            break;
          case 'resume':
            this.feed.system(e.now, 'flight_resumed', { callsign: this.callsign });
            break;
          default:
            break;
        }
      }
      if (this.outCount !== recorded.length) {
        throw new ResumeError(
          `${recorded.length - this.outCount} recorded telexes do not come out again`,
        );
      }
    } finally {
      this.replayOut = null;
    }
    this.resumePending = true;
    this.feed.system(lastNow, 'flight_resumed', { callsign: this.callsign });
    if (this.listening.length > 0) this.transport.listen(this.listening);
    const waits = this.core.pendingReplies.map((p) => p.leftMs);
    if (waits.length > 0) this.transport.expectReply(Math.max(...waits));
    for (const x of resend) this.send(x.m, x.n, x.feedId);
  }

  /** Running the recorded events again (T64): no file, network, sim or data side effects. */
  private get replaying(): boolean {
    return this.replayOut !== null;
  }

  /** A failed write ends the recording, not the flight. */
  private record(line: Parameters<typeof encodeLine>[0]): void {
    const r = this.recording;
    if (r === null || this.replaying) return;
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
          // The FMS drops the flight number after landing; the aircraft then stops fetching
          // telexes (T49, human check 2026-10-10): tell the pilot to enter it again.
          if (e.type === 'OOOI_IN')
            this.feed.system(e.t, 'flt_nbr_hint', { callsign: this.callsign });
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
          if (!this.replaying) this.transport.expectReply(e.timeoutMs);
          break;
        case 'FORCED':
          this.feed.system(e.t, `forced_${e.result}`, { id: e.id, detail: e.detail ?? '' });
          break;
        case 'DATA_REQUEST':
          if (this.replaying) break;
          if (e.kind === 'place') this.data?.requestPlace(e.icao);
          else this.data?.requestWx(e.icao);
          break;
        case 'REPLY_TIMEOUT':
          this.feed.system(e.t, 'reply_timeout', { id: e.id, option: e.option });
          break;
        case 'ATC_STATION':
          this.feed.system(e.t, 'atc_station', { fir: e.fir, station: e.station, unit: e.unit });
          break;
        case 'ATC_LOGON':
          if (e.accepted) this.feed.system(e.t, 'atc_logon', { station: e.station });
          else if (e.reason === 'wrong_station' && e.expected != null) {
            this.feed.system(e.t, 'atc_logon_wrong', { station: e.station, expected: e.expected });
          } else {
            this.feed.system(e.t, 'atc_logon_refused', {
              station: e.station,
              reason: e.reason ?? '',
            });
          }
          break;
        case 'ATC_HANDOVER':
          // The aircraft should log on to the next station soon: poll faster for a while.
          if (!this.replaying) this.transport.expectReply(180_000);
          this.feed.system(e.t, 'atc_handover', { from: e.from, to: e.to });
          break;
        case 'ATC_LOGOFF':
          this.feed.system(e.t, 'atc_logoff', { station: e.station, by: e.by });
          break;
        case 'ATC_LIVE':
          this.feed.system(e.t, 'atc_live', {
            fir: e.fir,
            callsign: e.callsign,
            frequency: e.frequency,
          });
          break;
        case 'ATC_REQUEST':
          this.feed.system(e.t, 'atc_request', {
            station: e.station,
            request: e.request,
            reply: e.reply.replaceAll('@_@', ' ').replaceAll('@', ''),
          });
          break;
        case 'ATC_AUTO':
          this.feed.system(e.t, 'atc_auto', {
            station: e.station,
            text: e.text.replaceAll('@', ''),
          });
          break;
        case 'ATC_EMERGENCY':
          this.feed.system(e.t, 'atc_emergency', { station: e.station, kind: e.kind });
          break;
        case 'ATC_LEVEL_CHECK':
          this.feed.system(e.t, 'atc_level_check', {
            station: e.station,
            level: String(e.levelFt),
            why: e.why,
          });
          break;
        case 'ATC_MISROUTED':
          this.feed.system(e.t, misroutedCode(e), {
            station: e.station,
            target: e.target ?? '',
          });
          break;
        case 'ATC_UNSUPPORTED':
          this.feed.system(e.t, 'atc_unsupported', { station: e.station, text: e.text });
          break;
        case 'ATC_DCL':
          this.feed.system(e.t, `atc_dcl_${e.what}`, { station: e.station });
          if (e.what === 'request' && !this.replaying) this.transport.expectReply(180_000);
          break;
        case 'ATC_DCL_CLEARANCE':
          this.feed.system(e.t, 'atc_dcl_clearance', {
            station: e.station,
            squawk: e.squawk,
            source: e.squawkSource,
          });
          // An ARINC 623 clearance waits for the pilot's WILCO.
          if (e.format === 'arinc623' && !this.replaying) this.transport.expectReply(180_000);
          break;
        case 'ATC_DCL_REJECTED':
          this.feed.system(e.t, 'atc_dcl_rejected', {
            station: e.station,
            reason: e.reason,
            detail: e.detail ?? '',
          });
          break;
        case 'ATC_OCL':
          this.feed.system(e.t, `atc_ocl_${e.what}`, {
            station: e.station,
            oca: e.oca,
            detail: e.detail ?? '',
          });
          // RCL received by Shanwick: the CLX follows within 10 min; a CLX waits for ROGER.
          if (
            !this.replaying &&
            (e.what === 'clearance' || (e.what === 'received' && e.oca === 'EGGX'))
          )
            this.transport.expectReply(180_000);
          break;
        default:
          break;
      }
    }
    for (const c of out.commands) {
      this.record(cmdLine(c));
      // Effects of the past are not played again; those running at the crash were cleared (T64).
      if (!this.replaying) this.simCommands(c);
    }
    if (out.listen.join(' ') !== this.listening.join(' ')) {
      this.listening = out.listen;
      if (!this.replaying) this.transport.listen(out.listen);
    }
    for (const m of out.outbound) {
      const feedId = this.feed.add({
        kind: 'outbound',
        t: m.t,
        from: m.from,
        to: m.to,
        scenarioId: m.scenarioId,
        text: m.message.text,
        hint: this.hints.forMessage(m),
        delivery: 'queued',
        detail: null,
      });
      this.lastMessage.set(m.scenarioId, feedId);
      if (this.replayOut !== null) this.replayOut(m, feedId);
      else {
        this.record(outLine(m));
        this.send(m, this.outCount++, feedId);
      }
    }
  }

  /** Hands the n-th recorded telex to the transport. */
  private send(m: Outbound, n: number, feedId: string): void {
    try {
      const id = this.transport.send({
        from: m.from,
        to: m.to,
        message: m.message,
        ...(m.cpdlc === undefined ? {} : { cpdlc: m.cpdlc }),
      });
      this.outbound.set(id, feedId);
      this.outIndex.set(id, n);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.feed.updateOutbound(feedId, { delivery: 'failed', detail });
      this.record({ type: 'sent', t: m.t, n, result: 'failed' });
    }
  }

  /** T64: the n-th `out` line left the app (or never will). */
  private delivered(id: string, t: number, result: 'sent' | 'failed'): void {
    const n = this.outIndex.get(id);
    if (n === undefined) return;
    this.outIndex.delete(id);
    this.record({ type: 'sent', t, n, result });
  }

  private drainTransport(): void {
    for (const e of this.transport.takeEvents()) {
      switch (e.type) {
        case 'SENT': {
          const id = this.outbound.get(e.id);
          if (id !== undefined)
            this.feed.updateOutbound(id, { delivery: 'sent', detail: null, t: this.clock(e.t) });
          this.outbound.delete(e.id);
          this.delivered(e.id, this.clock(e.t), 'sent');
          break;
        }
        case 'SEND_RETRY': {
          const id = this.outbound.get(e.id);
          const detail = `#${e.attempt}: ${e.reason}`;
          this.log.warn(`transport: retry ${detail}`);
          if (id !== undefined) this.feed.updateOutbound(id, { delivery: 'retry', detail });
          break;
        }
        case 'SEND_FAILED': {
          const id = this.outbound.get(e.id);
          this.log.warn(`transport: send failed: ${e.reason}`);
          if (id !== undefined)
            this.feed.updateOutbound(id, { delivery: 'failed', detail: e.reason });
          this.outbound.delete(e.id);
          this.delivered(e.id, this.clock(e.t), 'failed');
          break;
        }
        case 'INBOUND':
          this.inbound.push({
            from: e.message.from,
            type: e.message.type,
            text: e.message.packet,
            to: e.message.to,
          });
          this.feed.add({
            kind: 'inbound',
            t: this.clock(e.t),
            from: e.message.from,
            to: e.message.to,
            type: e.message.type,
            text: e.message.packet,
          });
          break;
        case 'STATUS':
          this.onStatus(this.clock(e.t), e.status, e.reason ?? null);
          break;
      }
    }
  }

  private onStatus(t: number, status: TransportStatus, reason: string | null): void {
    const line = `transport: ${status}${reason === null ? '' : ` (${reason})`}`;
    if (status === 'degraded' || status === 'halted') this.log.warn(line);
    else this.log.info(line);
    this.transportReason = status === 'ok' || status === 'idle' ? null : reason;
    // `idle → ok` is the normal start; only problems and the recovery from them go to the feed.
    if (status === 'degraded' || status === 'halted' || this.feedHasProblem) {
      this.feed.system(t, 'transport_status', { status, reason: reason ?? '' });
    }
    this.feedHasProblem = status === 'degraded' || status === 'halted';
  }
}

/** Feed code of a message that went to the wrong XATC station (T49). */
function misroutedCode(
  e: Extract<CoreOutput['events'][number], { type: 'ATC_MISROUTED' }>,
): SystemCode {
  if (e.what === 'pdc_request')
    return e.target === null ? 'atc_misrouted_pdc_closed' : 'atc_misrouted_pdc';
  if (e.what === 'logon')
    return e.target === null ? 'atc_misrouted_logon_fir' : 'atc_misrouted_logon';
  return e.role === 'fir' ? 'atc_misrouted_fir' : 'atc_misrouted_dcl';
}

function outLine(m: CoreOutput['outbound'][number]): RecordingEvent {
  return {
    type: 'out',
    t: m.t,
    scenarioId: m.scenarioId,
    from: m.from,
    to: m.to,
    text: m.message.text,
    ...(m.cpdlc === undefined ? {} : { packet: cpdlcPacket(m.cpdlc, m.message) }),
  };
}

function cmdLine(c: SimCommand): RecordingEvent {
  const { scenarioId, t, command, ...rest } = c;
  const data =
    'vdgs' in rest
      ? rest.vdgs
      : 'args' in rest
        ? rest.args
        : 'level' in rest
          ? {
              action: rest.action,
              level: rest.level,
              airport: rest.airport,
              runway: rest.runway,
              windFromDeg: rest.windFromDeg,
            }
          : {
              action: rest.action,
              airport: rest.airport,
              runway: rest.runway,
              ...(rest.offset ? { offset: rest.offset } : {}),
            };
  return { type: 'cmd', t, scenarioId, command, data: JSON.parse(JSON.stringify(data)) };
}

/** Probabilities that differ from the scenario files (user's chances), for the recording. */
function probabilities(list: readonly CompiledScenario[]): {
  probabilities?: Record<string, number>;
} {
  const out: Record<string, number> = {};
  for (const c of list) if (c.probability !== (c.def.probability ?? 1)) out[c.id] = c.probability;
  return Object.keys(out).length === 0 ? {} : { probabilities: out };
}
