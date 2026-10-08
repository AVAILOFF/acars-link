import type { TelemetrySnapshot } from '../telemetry/types.js';
import type { SyntheticFlight, SyntheticStage, SyntheticStageMark } from './flight.js';

/**
 * Post-processing of a synthetic flight into the abnormal recordings docs/04 asks for:
 * pause, sim rate ×N, teleport/slew and a telemetry gap. Each transform returns a new
 * flight; stage marks follow the snapshots they pointed at.
 *
 * All transforms assume a constant sample period (the generator's `stepMs`).
 */

interface Out {
  readonly snapshot: TelemetrySnapshot;
  /** Index in the source flight this sample comes from. */
  readonly src: number;
}

function stepOf(snapshots: readonly TelemetrySnapshot[]): number {
  const a = snapshots[0];
  const b = snapshots[1];
  if (a === undefined || b === undefined) throw new RangeError('flight needs ≥ 2 snapshots');
  return b.t - a.t;
}

function checkIndex(flight: SyntheticFlight, i: number, name: string): void {
  if (!Number.isInteger(i) || i < 1 || i >= flight.snapshots.length) {
    throw new RangeError(`${name} must be an index inside the flight, got ${i}`);
  }
}

/** Re-times samples to a continuous `stepMs` grid starting at the first one. */
function retime(out: Out[], startMs: number, stepMs: number): Out[] {
  return out.map((o, i) => ({ src: o.src, snapshot: { ...o.snapshot, t: startMs + i * stepMs } }));
}

function rebuild(flight: SyntheticFlight, out: readonly Out[]): SyntheticFlight {
  const stages: SyntheticStageMark[] = [];
  for (const mark of flight.stages) {
    const index = out.findIndex((o) => o.src >= mark.index);
    if (index < 0) continue;
    // Two marks can collapse onto one sample (stage dropped by a teleport): keep the later.
    if (stages.at(-1)?.index === index) stages.pop();
    stages.push({ stage: mark.stage, index, t: (out[index] as Out).snapshot.t });
  }
  return { snapshots: out.map((o) => o.snapshot), stages };
}

const source = (flight: SyntheticFlight): Out[] =>
  flight.snapshots.map((snapshot, src) => ({ snapshot, src }));

/** First snapshot index of `stage` plus `offsetSec` (at the flight's sample period). */
export function stageIndex(flight: SyntheticFlight, stage: SyntheticStage, offsetSec = 0): number {
  const mark = flight.stages.find((m) => m.stage === stage);
  if (mark === undefined) throw new RangeError(`flight has no stage ${stage}`);
  return mark.index + Math.round((offsetSec * 1000) / stepOf(flight.snapshots));
}

/** Sim paused before sample `atIndex` for `durationSec`: frozen samples with `paused: true`. */
export function withPause(
  flight: SyntheticFlight,
  options: { readonly atIndex: number; readonly durationSec: number },
): SyntheticFlight {
  checkIndex(flight, options.atIndex, 'atIndex');
  const step = stepOf(flight.snapshots);
  const n = Math.round((options.durationSec * 1000) / step);
  const all = source(flight);
  const frozen = all[options.atIndex - 1] as Out;
  const pause: Out[] = Array.from({ length: n }, () => ({
    src: frozen.src,
    snapshot: { ...frozen.snapshot, paused: true },
  }));
  const out = [...all.slice(0, options.atIndex), ...pause, ...all.slice(options.atIndex)];
  return rebuild(flight, retime(out, (all[0] as Out).snapshot.t, step));
}

/**
 * Sim rate ×`rate` for source samples [fromIndex, toIndex): the bridge still samples once
 * per period, so only every `rate`-th sample is seen, with `simRate: rate`.
 */
export function withSimRate(
  flight: SyntheticFlight,
  options: { readonly fromIndex: number; readonly toIndex: number; readonly rate: number },
): SyntheticFlight {
  const { fromIndex, toIndex, rate } = options;
  checkIndex(flight, fromIndex, 'fromIndex');
  checkIndex(flight, toIndex, 'toIndex');
  if (!Number.isInteger(rate) || rate < 1) throw new RangeError(`rate must be ≥ 1, got ${rate}`);
  const all = source(flight);
  const fast: Out[] = [];
  for (let i = fromIndex; i < toIndex; i += rate) {
    const o = all[i] as Out;
    fast.push({ src: o.src, snapshot: { ...o.snapshot, simRate: rate } });
  }
  const out = [...all.slice(0, fromIndex), ...fast, ...all.slice(toIndex)];
  return rebuild(flight, retime(out, (all[0] as Out).snapshot.t, stepOf(flight.snapshots)));
}

/**
 * Teleport/slew: source samples [fromIndex, toIndex) disappear while time runs on, so the
 * position jumps between two consecutive samples.
 */
export function withTeleport(
  flight: SyntheticFlight,
  options: { readonly fromIndex: number; readonly toIndex: number },
): SyntheticFlight {
  checkIndex(flight, options.fromIndex, 'fromIndex');
  checkIndex(flight, options.toIndex, 'toIndex');
  const all = source(flight);
  const out = [...all.slice(0, options.fromIndex), ...all.slice(options.toIndex)];
  return rebuild(flight, retime(out, (all[0] as Out).snapshot.t, stepOf(flight.snapshots)));
}

/** No telemetry for `durationSec` before sample `atIndex`; the flight itself goes on. */
export function withGap(
  flight: SyntheticFlight,
  options: { readonly atIndex: number; readonly durationSec: number },
): SyntheticFlight {
  checkIndex(flight, options.atIndex, 'atIndex');
  const n = Math.round((options.durationSec * 1000) / stepOf(flight.snapshots));
  const all = source(flight);
  return rebuild(flight, [...all.slice(0, options.atIndex), ...all.slice(options.atIndex + n)]);
}
