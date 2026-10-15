import {
  AcarsCore,
  type CompiledScenario,
  type CoreEvent,
  type DisplayProfile,
  type FlightPhase,
  type OutboundMessage,
  type PhaseConfig,
  type SimCommand,
} from '@acars/core';
import type { RecordedOutbound, Recording } from './format.js';

/**
 * Runs a recording through the core: the same calls in the same order as the live app
 * (`FlightSession`), with the recorded clock. Pure: no files, no wall clock.
 */

export interface ReplayOptions {
  /** Scenarios to run (the caller picks them; see the CLI for the defaults). */
  readonly scenarios: readonly CompiledScenario[];
  /** Overrides of the recorded core options. */
  readonly seed?: string | number;
  readonly station?: string;
  readonly profile?: DisplayProfile;
  readonly phaseConfig?: Partial<PhaseConfig>;
  /**
   * Extra pilot telexes (T12): each goes with the first tick at least `afterMin` minutes after
   * the first line of the recording, after the recorded ones of that tick. From the flight's
   * callsign, type `telex`.
   */
  readonly pilot?: readonly { readonly afterMin: number; readonly text: string }[];
}

export type TimelineEntry =
  | { readonly kind: 'event'; readonly now: number; readonly event: CoreEvent }
  | { readonly kind: 'out'; readonly now: number; readonly message: OutboundMessage }
  | { readonly kind: 'cmd'; readonly now: number; readonly command: SimCommand }
  | { readonly kind: 'late_start'; readonly now: number; readonly delayMin: number }
  | { readonly kind: 'error'; readonly now: number; readonly error: string };

export interface ReplayResult {
  readonly timeline: readonly TimelineEntry[];
  readonly outbound: readonly OutboundMessage[];
  /** Phase after every PHASE_CHANGE, starting with the phase after `start`. */
  readonly phases: readonly FlightPhase[];
  readonly finalPhase: FlightPhase;
  /** Display profile id the replay used. */
  readonly profile: string;
  /** Late-start delay (docs/05), null when the core never ticked. */
  readonly delayMs: number | null;
  /** `out` lines of the recording (live output). */
  readonly recorded: readonly RecordedOutbound[];
  readonly ticks: number;
  readonly firstNow: number | null;
  readonly lastNow: number | null;
}

export function replay(recording: Recording, o: ReplayOptions): ReplayResult {
  const h = recording.header;
  const seed = o.seed ?? h.seed;
  const profile = o.profile ?? h.profile;
  // The user's chances of that flight (desktop settings) replace the files'.
  const p = h.probabilities ?? {};
  const scenarios = o.scenarios.map((s) => {
    const v = p[s.id];
    return v === undefined ? s : { ...s, probability: v };
  });
  const core = AcarsCore.create({
    ofp: h.ofp,
    scenarios,
    profile,
    station: o.station ?? h.station,
    sessionFired: h.sessionFired,
    ...(seed === null ? {} : { seed }),
    ...(h.dataWaitMs === undefined ? {} : { dataWaitMs: h.dataWaitMs }),
    ...(h.flags === undefined ? {} : { flags: h.flags }),
    ...(h.minGapMs === undefined ? {} : { minGapMs: h.minGapMs }),
    namesVersion: h.namesVersion ?? 1,
    ...(h.rops === undefined ? {} : { rops: h.rops }),
    ...(h.datalink === undefined ? {} : { datalink: h.datalink }),
    ...(o.phaseConfig === undefined ? {} : { phaseConfig: o.phaseConfig }),
  });
  const timeline: TimelineEntry[] = [];
  const outbound: OutboundMessage[] = [];
  const recorded = recording.events.filter((e): e is RecordedOutbound => e.type === 'out');
  const phases: FlightPhase[] = [];
  let ticks = 0;
  let firstNow: number | null = null;
  let lastNow: number | null = null;
  let delayReported = false;
  let pilot = [...(o.pilot ?? [])].sort((a, b) => a.afterMin - b.afterMin);

  const apply = (now: number, out: ReturnType<AcarsCore['tick']>) => {
    const delay = core.delayMs;
    if (!delayReported && delay !== null) {
      delayReported = true;
      if (delay > 0) timeline.push({ kind: 'late_start', now, delayMin: delay / 60_000 });
    }
    for (const event of out.events) {
      timeline.push({ kind: 'event', now, event });
      if (event.type === 'PHASE_CHANGE') phases.push(event.to);
    }
    for (const message of out.outbound) {
      timeline.push({ kind: 'out', now, message });
      outbound.push(message);
    }
    for (const command of out.commands) timeline.push({ kind: 'cmd', now, command });
  };

  loop: for (const e of recording.events) {
    if (e.type === 'out' || e.type === 'cmd') continue;
    firstNow ??= e.now;
    lastNow = e.now;
    switch (e.type) {
      case 'start': {
        const before = core.phase;
        core.startFlight();
        if (core.phase !== before) phases.push(core.phase);
        break;
      }
      case 'tick': {
        ticks++;
        const t0 = firstNow ?? e.now;
        const due = pilot.filter((p) => e.now >= t0 + p.afterMin * 60_000);
        pilot = pilot.filter((p) => !due.includes(p));
        const inbound = [
          ...(e.inbound ?? []),
          ...due.map((p) => ({ from: h.ofp.callsign, type: 'telex', text: p.text })),
        ];
        apply(
          e.now,
          core.tick({
            now: e.now,
            telemetry: e.telemetry,
            ...(inbound.length > 0 ? { inbound } : {}),
            ...(e.data === undefined ? {} : { data: e.data }),
            ...(e.force === undefined ? {} : { force: e.force }),
          }),
        );
        break;
      }
      case 'end':
        try {
          apply(e.now, core.endFlight(e.to, e.now));
        } catch (err) {
          const error = `end ${e.to}: ${err instanceof Error ? err.message : String(err)}`;
          timeline.push({ kind: 'error', now: e.now, error });
        }
        break;
      case 'stop':
        break loop;
    }
  }
  return {
    timeline,
    outbound,
    phases,
    finalPhase: core.phase,
    profile: profile.id,
    delayMs: core.delayMs,
    recorded,
    ticks,
    firstNow,
    lastNow,
  };
}

/**
 * Differences between the live telexes and the replayed ones (scenario, time, text), in
 * order. Empty when the replay reproduces the live run.
 */
export function compareOutbound(
  recorded: readonly RecordedOutbound[],
  replayed: readonly OutboundMessage[],
): string[] {
  const out: string[] = [];
  const n = Math.max(recorded.length, replayed.length);
  for (let i = 0; i < n; i++) {
    const a = recorded[i];
    const b = replayed[i];
    if (a === undefined && b !== undefined) {
      out.push(`#${i + 1}: extra in replay: ${b.scenarioId} at ${iso(b.t)}`);
    } else if (a !== undefined && b === undefined) {
      out.push(`#${i + 1}: missing in replay: ${a.scenarioId} at ${iso(a.t)}`);
    } else if (a !== undefined && b !== undefined) {
      if (a.scenarioId !== b.scenarioId) {
        out.push(`#${i + 1}: scenario ${a.scenarioId} live, ${b.scenarioId} in replay`);
      } else if (a.t !== b.t) {
        out.push(`#${i + 1}: ${a.scenarioId} at ${iso(a.t)} live, ${iso(b.t)} in replay`);
      } else if (a.text !== b.message.text || a.from !== b.from || a.to !== b.to) {
        out.push(`#${i + 1}: ${a.scenarioId}: text or callsigns differ`);
      }
    }
  }
  return out;
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
