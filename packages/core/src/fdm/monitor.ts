// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { FlightPhase, PhaseEvent } from '../phase/fsm.js';
import type { TelemetrySnapshot } from '../telemetry/types.js';

/**
 * Flight data monitoring (T94, FDM/FOQA): events of the flight from the telemetry, without grades or
 * scores — what happened, its value, height and time. The safety department's letter
 * (`fdm_letter`), the flight report (T69) and the logbook read them. Pure and deterministic: the same
 * recording gives the same events.
 *
 * Sources (checked 2026-11-07, numbers only): stabilised approach by 1000 ft above the aerodrome,
 * landing configuration, descent rate not above 1000 fpm — FSF ALAR Briefing Note 7.1
 * (skybrary.aero "Stabilised Approach"); 250 kt below 10 000 ft — 14 CFR 91.117(a), SERA.6001.
 *
 * Rules (assumptions and game values approved by the user 2026-11-07):
 * - heights of the approach are above the destination of the OFP: `altFt − elevation` (Д1), not
 *   `aglFt`; the gate is {@link FDM_GATE_FT};
 * - the landing flaps are `flapsIdx` at the touchdown (Д2, no table of add-ons): "not in landing
 *   configuration" = at the gate the flaps were below that, or the gear was up;
 * - the approach speed is not checked (Д3); 250 kt applies everywhere below 10 000 ft MSL (Д4);
 *   bank, pitch and N1 are not used (Д5);
 * - sink rate: VS steeper than −{@link FDM_SINK_FPM} fpm for {@link FDM_SINK_HOLD_MS} in a row
 *   between the gate and {@link FDM_SINK_FLOOR_FT} above the aerodrome;
 * - speed: IAS above {@link FDM_SPEED_KT} kt for {@link FDM_SPEED_HOLD_MS} in a row below
 *   {@link FDM_SPEED_BELOW_FT} ft MSL, in the climb and in the descent;
 * - a go-around after the aircraft went below the gate is information, not an exceedance;
 * - samples while the sim is paused do not count (and break a run); one event of each kind per
 *   approach (the speed: one in the climb, one in the descent) with its worst value.
 * A gap of more than {@link FDM_MAX_GAP_MS} between samples breaks a run too: no evidence that the
 * exceedance went on in between (the bridge sends about one sample a second).
 */

export const FDM_GATE_FT = 1000;
export const FDM_SINK_FPM = 1000;
export const FDM_SINK_HOLD_MS = 5_000;
export const FDM_SINK_FLOOR_FT = 50;
export const FDM_SPEED_KT = 255;
export const FDM_SPEED_HOLD_MS = 15_000;
export const FDM_SPEED_BELOW_FT = 10_000;
export const FDM_MAX_GAP_MS = 5_000;

/** Lines of events in the letter (`fdm.line1` …); more events are counted in `fdm.more`. */
export const FDM_LINES = 8;
export const FDM_LINE_VARS = [
  'fdm.line1',
  'fdm.line2',
  'fdm.line3',
  'fdm.line4',
  'fdm.line5',
  'fdm.line6',
  'fdm.line7',
  'fdm.line8',
] as const;

export type FdmKind = 'sink_rate' | 'gear_up' | 'flaps' | 'speed' | 'go_around';

export interface FdmEvent {
  readonly kind: FdmKind;
  /** When the worst value was seen (sink, speed), the gate was crossed (gear, flaps), the lowest point (go-around); epoch ms. */
  readonly t: number;
  /** Height, ft: above the destination aerodrome; for `speed` MSL. Rounded to 10 ft. */
  readonly altFt: number;
  /**
   * `sink_rate`: descent rate, fpm, positive down, rounded to 10; `speed`: IAS, kt; `flaps`: the
   * flaps index at the gate; null for `gear_up` and `go_around`.
   */
  readonly value: number | null;
  /** `flaps`: the flaps index at the touchdown (the landing configuration). */
  readonly landingFlaps?: number;
  /** The approach (1 = first; a go-around starts the next); 0 for `speed`. */
  readonly approach: number;
  /** `speed`: in the climb (before the aircraft was above 10 000 ft) or the descent. */
  readonly leg?: 'climb' | 'descent';
  /** Information only (go-around), not an exceedance. */
  readonly info: boolean;
}

interface Run {
  readonly start: number;
  /** Worst sample of the run: value, height, time. */
  readonly worst: { readonly value: number; readonly altFt: number; readonly t: number };
}

export interface FdmState {
  readonly v: 1;
  readonly events: readonly FdmEvent[];
  readonly approach: number;
  /** The aircraft was above the gate in this approach (the gate is crossed downwards). */
  readonly aboveGate: boolean;
  /** The gate of this approach was checked. */
  readonly gateDone: boolean;
  /** Gates waiting for the touchdown to know the landing flaps. */
  readonly gates: readonly {
    readonly approach: number;
    readonly t: number;
    readonly flaps: number;
  }[];
  /** Lowest height above the aerodrome in this approach after it went below the gate. */
  readonly low: { readonly altFt: number; readonly t: number } | null;
  readonly sink: Run | null;
  readonly speed: Run | null;
  readonly above10k: boolean;
  readonly airborne: boolean;
  readonly lastT: number | null;
}

const r10 = (x: number) => Math.round(x / 10) * 10;
const APPROACH_PHASES: ReadonlySet<FlightPhase> = new Set(['DESCENT', 'APPROACH']);

export const EMPTY_FDM: FdmState = {
  v: 1,
  events: [],
  approach: 1,
  aboveGate: false,
  gateDone: false,
  gates: [],
  low: null,
  sink: null,
  speed: null,
  above10k: false,
  airborne: false,
  lastT: null,
};

export class FdmMonitor {
  private st: FdmState;

  constructor(
    /** Elevation of the destination aerodrome of the OFP, ft. */
    private readonly elevationFt: number,
    state?: FdmState,
  ) {
    this.st = state === undefined ? EMPTY_FDM : (JSON.parse(JSON.stringify(state)) as FdmState);
  }

  getState(): FdmState {
    return JSON.parse(JSON.stringify(this.st)) as FdmState;
  }

  /** Events so far, oldest first (by time, then kind). */
  get events(): readonly FdmEvent[] {
    return [...this.st.events].sort((a, b) =>
      a.t !== b.t ? a.t - b.t : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0,
    );
  }

  /**
   * One tick: the phase events of the tick (a go-around starts a new approach) and the new
   * sample, if any, at `now` (the core's clock) with the phase after it.
   */
  push(
    now: number,
    tm: TelemetrySnapshot | null,
    phase: FlightPhase,
    phaseEvents: readonly PhaseEvent[],
  ): void {
    for (const e of phaseEvents) {
      if (e.type === 'PHASE_CHANGE' && e.to === 'GO_AROUND') this.goAround();
    }
    if (tm === null) return;
    let s = this.st;
    if (tm.paused) {
      this.st = { ...s, sink: null, speed: null, lastT: null };
      return;
    }
    if (s.lastT !== null && now - s.lastT > FDM_MAX_GAP_MS) s = { ...s, sink: null, speed: null };
    s = { ...s, lastT: now };
    const h = tm.altFt - this.elevationFt;
    const airborne = !tm.onGround;

    if (tm.onGround && s.airborne) s = this.touchdown(s, tm.flapsIdx);
    s = { ...s, airborne };

    // Speed below 10 000 ft MSL, climb and descent.
    if (airborne && tm.altFt > FDM_SPEED_BELOW_FT) s = { ...s, above10k: true };
    if (airborne && tm.altFt < FDM_SPEED_BELOW_FT && tm.iasKt > FDM_SPEED_KT) {
      const speed = extend(s.speed, now, tm.iasKt, tm.altFt);
      s = { ...s, speed };
      if (now - speed.start >= FDM_SPEED_HOLD_MS) {
        const leg = s.above10k ? 'descent' : 'climb';
        s = upsert(
          s,
          {
            kind: 'speed',
            t: speed.worst.t,
            altFt: r10(speed.worst.altFt),
            value: Math.round(speed.worst.value),
            approach: 0,
            leg,
            info: false,
          },
          (e) => e.kind === 'speed' && e.leg === leg,
        );
      }
    } else s = { ...s, speed: null };

    // The approach. Above the gate anywhere in the air: the next crossing down is checked.
    if (airborne && h > FDM_GATE_FT) s = { ...s, aboveGate: true };
    if (airborne && APPROACH_PHASES.has(phase)) {
      if (h <= FDM_GATE_FT && s.aboveGate && !s.gateDone) {
        s = {
          ...s,
          gateDone: true,
          gates: [...s.gates, { approach: s.approach, t: now, flaps: tm.flapsIdx }],
        };
        if (!tm.gearDown) {
          s = {
            ...s,
            events: [
              ...s.events,
              {
                kind: 'gear_up',
                t: now,
                altFt: FDM_GATE_FT,
                value: null,
                approach: s.approach,
                info: false,
              },
            ],
          };
        }
      }
      if (s.gateDone && h <= FDM_GATE_FT && (s.low === null || h < s.low.altFt)) {
        s = { ...s, low: { altFt: h, t: now } };
      }
      const inWindow = s.gateDone && h <= FDM_GATE_FT && h >= FDM_SINK_FLOOR_FT;
      if (inWindow && tm.vsFpm < -FDM_SINK_FPM) {
        const sink = extend(s.sink, now, -tm.vsFpm, h);
        s = { ...s, sink };
        if (now - sink.start >= FDM_SINK_HOLD_MS) {
          const approach = s.approach;
          s = upsert(
            s,
            {
              kind: 'sink_rate',
              t: sink.worst.t,
              altFt: r10(sink.worst.altFt),
              value: r10(sink.worst.value),
              approach,
              info: false,
            },
            (e) => e.kind === 'sink_rate' && e.approach === approach,
          );
        }
      } else s = { ...s, sink: null };
    } else s = { ...s, sink: null };
    this.st = s;
  }

  /** A go-around: information when below the gate; the next approach begins. */
  private goAround(): void {
    let s = this.st;
    if (s.low !== null) {
      s = {
        ...s,
        events: [
          ...s.events,
          {
            kind: 'go_around',
            t: s.low.t,
            altFt: Math.max(0, r10(s.low.altFt)),
            value: null,
            approach: s.approach,
            info: true,
          },
        ],
      };
    }
    this.st = {
      ...s,
      approach: s.approach + 1,
      aboveGate: false,
      gateDone: false,
      low: null,
      sink: null,
    };
  }

  /** The touchdown: the landing flaps; gates with less flaps are events. */
  private touchdown(s: FdmState, landingFlaps: number): FdmState {
    const late = s.gates
      .filter((g) => g.flaps < landingFlaps)
      .map(
        (g): FdmEvent => ({
          kind: 'flaps',
          t: g.t,
          altFt: FDM_GATE_FT,
          value: g.flaps,
          landingFlaps,
          approach: g.approach,
          info: false,
        }),
      );
    return { ...s, gates: [], events: [...s.events, ...late] };
  }
}

/** The run goes on (or starts) with a sample; the worst value is the largest. */
function extend(run: Run | null, t: number, value: number, altFt: number): Run {
  if (run === null) return { start: t, worst: { value, altFt, t } };
  return value > run.worst.value ? { start: run.start, worst: { value, altFt, t } } : run;
}

/** One event of a kind per slot: a worse value replaces it. */
function upsert(s: FdmState, e: FdmEvent, same: (x: FdmEvent) => boolean): FdmState {
  const i = s.events.findIndex(same);
  if (i < 0) return { ...s, events: [...s.events, e] };
  const old = s.events[i] as FdmEvent;
  if ((e.value ?? 0) <= (old.value ?? 0)) return s;
  const events = [...s.events];
  events[i] = e;
  return { ...s, events };
}

const hhmm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

/** The text of an event in the letter (no number in front), before the formatter. */
export function fdmEventText(e: FdmEvent): string {
  const at = `AT ${e.altFt} FT`;
  const z = `${hhmm(e.t)}Z`;
  switch (e.kind) {
    case 'sink_rate':
      return `SINK RATE ${e.value} FPM ${at} ${z}`;
    case 'gear_up':
      return `GEAR UP ${at} ${z}`;
    case 'flaps':
      return `FLAPS ${e.value} ${at} LDG FLAPS ${e.landingFlaps} ${z}`;
    case 'speed':
      return `SPEED ${e.value} KT ${at} MSL ${z}`;
    case 'go_around':
      return `GO AROUND ${at} INFO ${z}`;
  }
}
