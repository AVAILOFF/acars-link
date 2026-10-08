import {
  AcarsCore,
  type CompiledScenario,
  type DisplayProfile,
  type FlightPhase,
  type OutboundMessage,
  type PhaseConfig,
  type PhaseEvent,
  type ScenarioEvent,
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
}

export type TimelineEntry =
  | { readonly kind: 'event'; readonly now: number; readonly event: PhaseEvent | ScenarioEvent }
  | { readonly kind: 'out'; readonly now: number; readonly message: OutboundMessage }
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
  const core = AcarsCore.create({
    ofp: h.ofp,
    scenarios: o.scenarios,
    profile,
    station: o.station ?? h.station,
    sessionFired: h.sessionFired,
    ...(seed === null ? {} : { seed }),
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
  };

  loop: for (const e of recording.events) {
    if (e.type === 'out') continue;
    firstNow ??= e.now;
    lastNow = e.now;
    switch (e.type) {
      case 'start': {
        const before = core.phase;
        core.startFlight();
        if (core.phase !== before) phases.push(core.phase);
        break;
      }
      case 'tick':
        ticks++;
        apply(e.now, core.tick({ now: e.now, telemetry: e.telemetry }));
        break;
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
