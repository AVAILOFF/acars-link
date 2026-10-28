// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type FlightPhase,
  generateSyntheticFlight,
  type PhaseEvent,
  PhaseMachine,
  parseSimbriefOfp,
  type SyntheticFlight,
  stageIndex,
  type TelemetrySnapshot,
  withGap,
  withPause,
  withSimRate,
  withTeleport,
} from '../src/index.js';

const ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'ofp', 'rctp-rjbb-a35k-kgs.json'), 'utf8'),
  ),
);
const normal = generateSyntheticFlight({ ofp });

const NORMAL_PHASES: FlightPhase[] = [
  'BOARDING',
  'PUSHBACK',
  'TAXI_OUT',
  'TAKEOFF',
  'CLIMB',
  'CRUISE',
  'DESCENT',
  'APPROACH',
  'LANDED',
  'TAXI_IN',
  'ON_BLOCK',
];

interface Run {
  readonly fsm: PhaseMachine;
  readonly events: PhaseEvent[];
}

function run(flight: SyntheticFlight | readonly TelemetrySnapshot[], fsm = start()): Run {
  const snapshots = 'snapshots' in flight ? flight.snapshots : flight;
  const events: PhaseEvent[] = [];
  for (const s of snapshots) events.push(...fsm.push(s, s.t));
  return { fsm, events };
}

function start(): PhaseMachine {
  const fsm = new PhaseMachine({ ofp });
  fsm.startFlight();
  return fsm;
}

const phases = (events: readonly PhaseEvent[]) =>
  events.flatMap((e) => (e.type === 'PHASE_CHANGE' ? [e.to] : []));

/** Compact, human-readable event log for snapshot tests. */
const log = (events: readonly PhaseEvent[]) =>
  events.map((e) => {
    const time = new Date(e.t).toISOString().slice(11, 19);
    switch (e.type) {
      case 'PHASE_CHANGE':
        return `${time} ${e.from} → ${e.to}`;
      case 'ALT_CHANGE':
        return `${time} ALT_CHANGE ${e.fromFt} → ${e.toFt}`;
      case 'DISCONTINUITY':
        return `${time} DISCONTINUITY ${e.jumpNm} NM`;
      case 'TELEMETRY_LOST':
        return `${time} TELEMETRY_LOST`;
      case 'TELEMETRY_RESTORED':
        return `${time} TELEMETRY_RESTORED after ${e.gapMs / 1000} s`;
      default:
        return `${time} ${e.type}`;
    }
  });

const ofType = <T extends PhaseEvent['type']>(events: readonly PhaseEvent[], type: T) =>
  events.filter((e): e is Extract<PhaseEvent, { type: T }> => e.type === type);

describe('PhaseMachine — normal flight', () => {
  const { fsm, events } = run(normal);

  it('goes through every phase of docs/04 in order, once', () => {
    expect(phases(events)).toEqual(NORMAL_PHASES);
    expect(fsm.phase).toBe('ON_BLOCK');
  });

  it('event log', () => {
    expect(log(events)).toMatchSnapshot();
  });

  it('only the expected event types, no false DISCONTINUITY / loss / ALT_CHANGE', () => {
    expect(new Set(events.map((e) => e.type))).toEqual(
      new Set(['PHASE_CHANGE', 'OOOI_OUT', 'OOOI_OFF', 'OOOI_ON', 'OOOI_IN']),
    );
  });

  it('OOOI times match the physical moments in the profile', () => {
    const at = (stage: Parameters<typeof stageIndex>[1]) =>
      (normal.snapshots[stageIndex(normal, stage)] as TelemetrySnapshot).t;
    // Brake is released on the first PUSHBACK sample, the tug moves from the next one.
    expect(fsm.oooi.OUT).toBe(at('PUSHBACK') + 1000);
    expect(fsm.oooi.OUT).toBe(ofp.times.schedOutMs + 1000);
    expect(fsm.oooi.OFF).toBe(at('CLIMB'));
    expect(fsm.oooi.ON).toBe(at('ROLLOUT'));
    // On block = stopped with the brake set and engines off: 30 s into PARKED.
    expect(fsm.oooi.IN).toBe(at('PARKED') + 30_000);
    expect(ofType(events, 'OOOI_OFF')[0]?.t).toBe(fsm.oooi.OFF);
  });

  it('flight time equals wall time without pause or sim rate', () => {
    const s = normal.snapshots;
    expect(fsm.flightTimeMs).toBe(
      (s.at(-1) as TelemetrySnapshot).t - (s[0] as TelemetrySnapshot).t,
    );
  });

  it('stays in PREFLIGHT until the user starts the flight', () => {
    const idle = new PhaseMachine({ ofp });
    const gate = normal.snapshots.slice(0, 100);
    expect(run(gate, idle).events).toEqual([]);
    idle.startFlight();
    const next = normal.snapshots[100] as TelemetrySnapshot;
    expect(idle.push(next, next.t)).toEqual([
      { type: 'PHASE_CHANGE', t: next.t, from: 'PREFLIGHT', to: 'BOARDING' },
    ]);
  });

  it('endFlight closes the flight from ON_BLOCK only', () => {
    expect(() => start().endFlight('DONE', 0)).toThrow(/ON_BLOCK/);
    const r = run(normal);
    expect(r.fsm.endFlight('TURNAROUND', 1)).toEqual([
      { type: 'PHASE_CHANGE', t: 1, from: 'ON_BLOCK', to: 'TURNAROUND' },
    ]);
  });

  it('is deterministic', () => {
    expect(run(normal).events).toEqual(events);
  });

  it('ignores duplicate and out-of-order samples', () => {
    const s = normal.snapshots;
    const shuffled = [s[0], s[1], s[1], s[0], ...s.slice(2)] as TelemetrySnapshot[];
    expect(run(shuffled).events).toEqual(events);
  });
});

describe('PhaseMachine — go-around', () => {
  const flight = generateSyntheticFlight({ ofp, goAroundAglFt: 400 });
  const { events } = run(flight);

  it('APPROACH → GO_AROUND → APPROACH → LANDED', () => {
    expect(phases(events)).toEqual([
      ...NORMAL_PHASES.slice(0, 8),
      'GO_AROUND',
      'APPROACH',
      ...NORMAL_PHASES.slice(8),
    ]);
  });

  it('the profile really climbs away below 1000 ft and comes back level', () => {
    const ga = flight.snapshots.slice(stageIndex(flight, 'GO_AROUND'));
    expect(Math.min(...ga.slice(0, 30).map((x) => x.aglFt))).toBeLessThan(1000);
    expect(ga.some((x) => x.aglFt > 2900 && x.vsFpm === 0)).toBe(true);
  });

  it('event log', () => {
    expect(log(events)).toMatchSnapshot();
  });

  it('a single OOOI ON (the final touchdown), no discontinuity', () => {
    expect(ofType(events, 'OOOI_ON')).toHaveLength(1);
    expect(ofType(events, 'DISCONTINUITY')).toEqual([]);
  });

  it('a normal flight never reports GO_AROUND', () => {
    expect(phases(run(normal).events)).not.toContain('GO_AROUND');
  });
});

describe('PhaseMachine — pause and sim rate', () => {
  it('pause: no hold timer runs, no flight time passes; same phase sequence', () => {
    // Pause 30 s into the 60 s CLIMB → CRUISE hold.
    const at = stageIndex(normal, 'CRUISE', 30); // CLIMB → CRUISE holds 60 s
    const paused = withPause(normal, { atIndex: at, durationSec: 600 });
    const { fsm, events } = run(paused);
    expect(phases(events)).toEqual(NORMAL_PHASES);
    expect(ofType(events, 'SIM_PAUSED')).toHaveLength(1);
    expect(ofType(events, 'SIM_RESUMED')).toHaveLength(1);

    const base = run(normal);
    expect(fsm.flightTimeMs).toBe(base.fsm.flightTimeMs);
    // CRUISE is confirmed exactly 600 s of wall time later than without the pause.
    const cruise = (e: PhaseEvent[]) =>
      ofType(e, 'PHASE_CHANGE').find((x) => x.to === 'CRUISE')?.t ?? 0;
    expect(cruise(events) - cruise(base.events)).toBe(600_000);
  });

  it('a long pause in cruise is neither TELEMETRY_LOST nor DISCONTINUITY', () => {
    const at = stageIndex(normal, 'CRUISE', 600);
    const { events } = run(withPause(normal, { atIndex: at, durationSec: 3600 }));
    expect(ofType(events, 'TELEMETRY_LOST')).toEqual([]);
    expect(ofType(events, 'DISCONTINUITY')).toEqual([]);
  });

  it('×4 in cruise and descent: hold timers count flight time, same phases', () => {
    const fast = withSimRate(normal, {
      fromIndex: stageIndex(normal, 'CRUISE', 60),
      toIndex: stageIndex(normal, 'APPROACH', -60),
      rate: 4,
    });
    expect(fast.snapshots.length).toBeLessThan(normal.snapshots.length * 0.8);
    const { fsm, events } = run(fast);
    expect(phases(events)).toEqual(NORMAL_PHASES);
    expect(ofType(events, 'DISCONTINUITY')).toEqual([]);
    expect(Math.abs(fsm.flightTimeMs - run(normal).fsm.flightTimeMs)).toBeLessThan(10_000);
    expect(log(events)).toMatchSnapshot();
  });

  it('×4: CRUISE → DESCENT needs 60 s of flight time = 15 samples', () => {
    const from = stageIndex(normal, 'CRUISE', 60);
    const fast = withSimRate(normal, {
      fromIndex: from,
      toIndex: stageIndex(normal, 'APPROACH', -60),
      rate: 4,
    });
    const { events } = run(fast);
    const descent = ofType(events, 'PHASE_CHANGE').find((x) => x.to === 'DESCENT');
    const i = fast.snapshots.findIndex((x) => x.t === descent?.t);
    const firstTrue = fast.snapshots.findIndex(
      (x, j) => j > from && x.vsFpm < -800 && x.altFt < ofp.initialAltitudeFt - 2000,
    );
    expect(i - firstTrue).toBe(15);
  });
});

describe('PhaseMachine — teleport / slew', () => {
  it('slew 40 min ahead in cruise: DISCONTINUITY, phase kept, no false transitions', () => {
    const tp = withTeleport(normal, {
      fromIndex: stageIndex(normal, 'CRUISE', 300),
      toIndex: stageIndex(normal, 'CRUISE', 300 + 2400),
    });
    const { events } = run(tp);
    const jumps = ofType(events, 'DISCONTINUITY');
    expect(jumps).toHaveLength(1);
    expect(jumps[0]?.jumpNm).toBeGreaterThan(200);
    expect(phases(events)).toEqual(NORMAL_PHASES);
    expect(log(events)).toMatchSnapshot();
  });

  it('teleport during descent resets hold timers instead of finishing them', () => {
    // Jump from mid-descent straight to 4000 ft AGL: DESCENT → APPROACH needs 10 s after it.
    const from = stageIndex(normal, 'DESCENT', 120);
    const to = normal.snapshots.findIndex((x, i) => i > from && x.aglFt < 4000);
    const tp = withTeleport(normal, { fromIndex: from, toIndex: to });
    const { events } = run(tp);
    const jump = ofType(events, 'DISCONTINUITY')[0];
    const approach = ofType(events, 'PHASE_CHANGE').find((x) => x.to === 'APPROACH');
    expect(jump).toBeDefined();
    expect((approach?.t ?? 0) - (jump?.t ?? 0)).toBe(11_000);
    expect(phases(events)).toEqual(NORMAL_PHASES);
  });

  it('slew while paused is a DISCONTINUITY too', () => {
    const at = stageIndex(normal, 'CRUISE', 300);
    const p = withPause(normal, { atIndex: at, durationSec: 60 });
    const snaps = p.snapshots.map((x, i) =>
      i >= at + 30 && i < at + 60 ? { ...x, lat: x.lat + 1 } : x,
    );
    const jumps = ofType(run(snaps).events, 'DISCONTINUITY');
    expect(jumps).toHaveLength(2); // slewed away, then back to the unpaused track
  });
});

describe('PhaseMachine — telemetry loss', () => {
  it('watchdog: no snapshot for > 30 s → TELEMETRY_LOST, phase kept; restored on next sample', () => {
    const fsm = start();
    const at = stageIndex(normal, 'CRUISE', 300);
    run(normal.snapshots.slice(0, at), fsm);
    const last = normal.snapshots[at - 1] as TelemetrySnapshot;
    expect(fsm.tick(last.t + 30_000)).toEqual([]);
    expect(fsm.tick(last.t + 30_001)).toEqual([
      { type: 'TELEMETRY_LOST', t: last.t + 30_001, lastT: last.t },
    ]);
    expect(fsm.tick(last.t + 60_000)).toEqual([]); // reported once
    expect(fsm.telemetryLost).toBe(true);
    expect(fsm.phase).toBe('CRUISE');

    const back = normal.snapshots[at + 90] as TelemetrySnapshot;
    expect(fsm.push(back, back.t)).toEqual([
      { type: 'TELEMETRY_RESTORED', t: back.t, gapMs: back.t - last.t },
    ]);
    expect(fsm.telemetryLost).toBe(false);
  });

  it('replay with a 2 min gap in descent: LOST + RESTORED, no DISCONTINUITY, same phases', () => {
    const gap = withGap(normal, { atIndex: stageIndex(normal, 'DESCENT', 30), durationSec: 120 });
    const { events } = run(gap);
    expect(ofType(events, 'TELEMETRY_LOST')).toHaveLength(1);
    expect(ofType(events, 'TELEMETRY_RESTORED')).toHaveLength(1);
    expect(ofType(events, 'DISCONTINUITY')).toEqual([]);
    expect(phases(events)).toEqual(NORMAL_PHASES);
  });

  it('a gap does not count towards hold timers', () => {
    // Gap right after the descent starts: the 60 s CRUISE → DESCENT hold restarts after it.
    const firstTrue = normal.snapshots.findIndex(
      (x, i) =>
        i > stageIndex(normal, 'CRUISE') &&
        x.vsFpm < -800 &&
        x.altFt < ofp.initialAltitudeFt - 2000,
    );
    const gap = withGap(normal, { atIndex: firstTrue + 10, durationSec: 40 });
    const { events } = run(gap);
    const restored = ofType(events, 'TELEMETRY_RESTORED')[0];
    const descent = ofType(events, 'PHASE_CHANGE').find((x) => x.to === 'DESCENT');
    expect((descent?.t ?? 0) - (restored?.t ?? 0)).toBe(60_000);
  });
});

describe('PhaseMachine — serialization', () => {
  it('state is plain JSON; a machine restored at any point ends up identical', () => {
    const flight = generateSyntheticFlight({ ofp, goAroundAglFt: 400 });
    const full = run(flight);
    const s = flight.snapshots;
    for (const cut of [
      stageIndex(flight, 'PUSHBACK', 2),
      stageIndex(flight, 'CRUISE', 30),
      stageIndex(flight, 'GO_AROUND', 3),
    ]) {
      const first = run(s.slice(0, cut));
      const json = JSON.stringify(first.fsm.getState());
      const resumed = PhaseMachine.fromState(JSON.parse(json));
      const second = run(s.slice(cut), resumed);
      expect([...first.events, ...second.events]).toEqual(full.events);
      expect(resumed.getState()).toEqual(full.fsm.getState());
    }
  });

  it('getState is a copy', () => {
    const { fsm } = run(normal.snapshots.slice(0, 10));
    const st = fsm.getState();
    (st.oooi as { OUT: number | null }).OUT = 1;
    expect(fsm.oooi.OUT).toBeNull();
  });

  it('rejects unknown versions and phases', () => {
    const st = start().getState();
    expect(() => PhaseMachine.fromState({ ...st, v: 2 as 1 })).toThrow(/version/);
    expect(() => PhaseMachine.fromState({ ...st, phase: 'TAXI' as 'TAXI_IN' })).toThrow(/phase/);
  });
});

describe('PhaseMachine — cruise level change', () => {
  it('step climb of 2000 ft in cruise → ALT_CHANGE, not a phase change', () => {
    const from = stageIndex(normal, 'CRUISE', 600);
    const to = stageIndex(normal, 'DESCENT');
    const snaps = normal.snapshots.map((x, i) => {
      if (i < from || i >= to) return x;
      const k = Math.min(1, (i - from) / 120); // 2000 ft in 2 min = 1000 fpm
      return { ...x, altFt: x.altFt + Math.round(2000 * k), vsFpm: k < 1 ? 1000 : 0 };
    });
    const { events } = run(snaps);
    expect(ofType(events, 'ALT_CHANGE')).toEqual([
      expect.objectContaining({
        fromFt: ofp.initialAltitudeFt,
        toFt: ofp.initialAltitudeFt + 2000,
      }),
    ]);
    expect(phases(events)).toEqual(NORMAL_PHASES);
  });
});
