// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { describe, expect, it } from 'vitest';
import {
  type FdmEvent,
  FdmMonitor,
  type FlightPhase,
  fdmEventText,
  type PhaseEvent,
  type TelemetrySnapshot,
} from '../src/index.js';

/** T94: the flight data monitoring detectors on synthetic telemetry. */

const ELEV = 100;
const T0 = Date.UTC(2026, 10, 7, 14, 0, 0);

const BASE: TelemetrySnapshot = {
  v: 1,
  t: T0,
  lat: 34.4,
  lon: 135.2,
  altFt: 3000,
  aglFt: 2900,
  iasKt: 140,
  gsKt: 140,
  vsFpm: -750,
  hdgTrue: 60,
  onGround: false,
  parkingBrake: false,
  beacon: true,
  engRunning: [true, true],
  engN2: [70, 70],
  fuelKg: 5000,
  gearDown: true,
  flapsIdx: 4,
  doorsOpen: [0],
  xpdrState: 4,
  simRate: 1,
  paused: false,
  aircraftTitle: 'FenixA320',
};

interface Sample {
  readonly tm: Partial<TelemetrySnapshot>;
  readonly phase?: FlightPhase;
  readonly events?: readonly PhaseEvent[];
}

/** Feeds samples one second apart from T0; returns the monitor. */
function run(samples: readonly Sample[], monitor = new FdmMonitor(ELEV)): FdmMonitor {
  samples.forEach((s, i) => {
    const now = T0 + i * 1000;
    monitor.push(now, { ...BASE, t: now, ...s.tm }, s.phase ?? 'APPROACH', s.events ?? []);
  });
  return monitor;
}

/**
 * An approach from 2000 ft above the aerodrome at `vs(h)`, then the touchdown and the roll-out;
 * `at(h)` changes the sample at that height.
 */
function approach(
  o: {
    vs?: (h: number) => number;
    at?: (h: number) => Partial<TelemetrySnapshot>;
    landingFlaps?: number;
  } = {},
): Sample[] {
  const out: Sample[] = [];
  let h = 2000;
  while (h > 0) {
    const vs = o.vs?.(h) ?? -750;
    out.push({ tm: { altFt: ELEV + h, aglFt: h, vsFpm: vs, ...o.at?.(h) } });
    h += vs / 60;
  }
  for (let i = 0; i < 10; i++) {
    out.push({
      tm: { altFt: ELEV, aglFt: 0, vsFpm: 0, onGround: true, flapsIdx: o.landingFlaps ?? 4 },
      phase: 'LANDED',
    });
  }
  return out;
}

/** A climb at `ias` kt through `altFt` MSL for `sec` seconds. */
const climb = (
  ias: number,
  altFt: number,
  sec: number,
  paused?: (i: number) => boolean,
): Sample[] =>
  Array.from({ length: sec + 1 }, (_, i) => ({
    tm: { altFt, aglFt: altFt - 300, iasKt: ias, vsFpm: 1500, paused: paused?.(i) ?? false },
    phase: 'CLIMB',
  }));

const kinds = (m: FdmMonitor) => m.events.map((e) => e.kind);

describe('FDM detectors (T94)', () => {
  it('a stabilised approach and a climb at 250 kt: no event', () => {
    const m = run([...climb(250, 8000, 60), ...approach()]);
    expect(m.events).toEqual([]);
  });

  it('VS -1400 fpm at 800 ft: one sink rate event with the worst value', () => {
    // -1350 fpm from 900 to 700 ft, the worst sample (-1404) at 800 ft.
    const m = run(
      approach({
        vs: (h) => (h <= 900 && h > 700 ? -1350 : -750),
        at: (h) => (h < 815 && h > 785 ? { vsFpm: -1404, altFt: ELEV + 800 } : {}),
      }),
    );
    expect(kinds(m)).toEqual(['sink_rate']);
    const e = m.events[0] as FdmEvent;
    expect(e.value).toBe(1400);
    expect(e.altFt).toBe(800);
    expect(e.info).toBe(false);
    expect(e.approach).toBe(1);
    expect(fdmEventText(e)).toMatch(/^SINK RATE 1400 FPM AT 800 FT \d{4}Z$/);
  });

  it('a sink rate shorter than 5 s, above the gate or below 50 ft is no event', () => {
    // 4 s at -1400 (about 93 ft of height) inside the window.
    const short = run(approach({ vs: (h) => (h <= 800 && h > 707 ? -1400 : -750) }));
    expect(short.events).toEqual([]);
    const high = run(approach({ vs: (h) => (h > 1100 ? -2000 : -750) }));
    expect(high.events).toEqual([]);
    const flare = run(approach({ vs: (h) => (h < 49 ? -1500 : -750) }));
    expect(flare.events).toEqual([]);
  });

  it('gear up at 1000 ft: an event at the gate', () => {
    const m = run(approach({ at: (h) => (h > 900 ? { gearDown: false } : {}) }));
    expect(kinds(m)).toEqual(['gear_up']);
    expect(m.events[0]).toMatchObject({ altFt: 1000, value: null, approach: 1 });
    expect(fdmEventText(m.events[0] as FdmEvent)).toMatch(/^GEAR UP AT 1000 FT \d{4}Z$/);
  });

  it('flaps below the landing flaps at 1000 ft: an event at the touchdown', () => {
    const m = run(approach({ at: (h) => (h > 700 ? { flapsIdx: 3 } : {}), landingFlaps: 4 }));
    expect(kinds(m)).toEqual(['flaps']);
    expect(m.events[0]).toMatchObject({ value: 3, landingFlaps: 4, altFt: 1000 });
    // The same flaps at the gate and at the touchdown: the landing configuration.
    const same = run(approach({ at: () => ({ flapsIdx: 3 }), landingFlaps: 3 }));
    expect(same.events).toEqual([]);
  });

  it('280 kt at 8000 ft for 20 s: a speed event; 10 s or above 10 000 ft is none', () => {
    const m = run(climb(280, 8000, 20));
    expect(kinds(m)).toEqual(['speed']);
    expect(m.events[0]).toMatchObject({ value: 280, altFt: 8000, leg: 'climb', approach: 0 });
    expect(fdmEventText(m.events[0] as FdmEvent)).toMatch(/^SPEED 280 KT AT 8000 FT MSL \d{4}Z$/);
    expect(run(climb(280, 8000, 10)).events).toEqual([]);
    expect(run(climb(280, 10500, 30)).events).toEqual([]);
    expect(run(climb(255, 8000, 30)).events).toEqual([]);
  });

  it('one speed event in the climb and one in the descent, each with its worst value', () => {
    const m = run([
      ...climb(270, 8000, 20),
      ...climb(290, 9000, 20),
      ...climb(300, 12000, 5),
      ...climb(265, 9000, 20).map((s) => ({ ...s, phase: 'DESCENT' as const })),
    ]);
    expect(m.events.map((e) => [e.kind, e.leg, e.value])).toEqual([
      ['speed', 'climb', 290],
      ['speed', 'descent', 265],
    ]);
  });

  it('paused samples do not count and break the run', () => {
    // 30 s at 280 kt, paused every 10th second: no 15 s in a row.
    const m = run(climb(280, 8000, 30, (i) => i % 10 === 9));
    expect(m.events).toEqual([]);
    const paused = run(climb(280, 8000, 30, () => true));
    expect(paused.events).toEqual([]);
  });

  it('a gap in the telemetry breaks the run', () => {
    const m = new FdmMonitor(ELEV);
    for (let i = 0; i < 10; i++) {
      const now = T0 + i * 3000 + (i >= 5 ? 10_000 : 0);
      m.push(now, { ...BASE, t: now, altFt: 8000, iasKt: 280 }, 'CLIMB', []);
    }
    expect(m.events).toEqual([]);
  });

  it('a go-around below 1000 ft: information, and the next approach is checked again', () => {
    const first = approach().filter((s) => (s.tm.aglFt ?? 0) >= 600 && s.phase === undefined);
    const ga: Sample[] = [
      { tm: { altFt: ELEV + 650, vsFpm: 1500 } },
      {
        tm: { altFt: ELEV + 700, vsFpm: 1500 },
        phase: 'GO_AROUND',
        events: [{ type: 'PHASE_CHANGE', t: 0, from: 'APPROACH', to: 'GO_AROUND' }],
      },
      ...Array.from({ length: 60 }, (_, i) => ({
        tm: { altFt: ELEV + 700 + i * 25, vsFpm: 1500, gearDown: i < 5 },
        phase: 'GO_AROUND' as const,
      })),
    ];
    // Second approach with the gear up at the gate.
    const second = approach({ at: (h) => (h > 900 ? { gearDown: false } : {}) });
    const m = run([...first, ...ga, ...second]);
    expect(m.events.map((e) => [e.kind, e.approach, e.info])).toEqual([
      ['go_around', 1, true],
      ['gear_up', 2, false],
    ]);
    expect(m.events[0]?.altFt).toBe(600);
    expect(fdmEventText(m.events[0] as FdmEvent)).toMatch(/^GO AROUND AT 600 FT INFO \d{4}Z$/);
  });

  it('a go-around above 1000 ft is no event', () => {
    const m = run([
      { tm: { altFt: ELEV + 1500 } },
      {
        tm: { altFt: ELEV + 1400, vsFpm: 1000 },
        phase: 'GO_AROUND',
        events: [{ type: 'PHASE_CHANGE', t: 0, from: 'APPROACH', to: 'GO_AROUND' }],
      },
    ]);
    expect(m.events).toEqual([]);
  });

  it('the state round-trips: a run cut in two gives the same events', () => {
    const samples = [
      ...climb(280, 8000, 20),
      ...approach({ vs: (h) => (h <= 900 && h > 600 ? -1400 : -750) }),
    ];
    const whole = run(samples);
    const cut = 30;
    const a = run(samples.slice(0, cut));
    const b = new FdmMonitor(ELEV, JSON.parse(JSON.stringify(a.getState())));
    samples.slice(cut).forEach((s, i) => {
      const now = T0 + (cut + i) * 1000;
      b.push(now, { ...BASE, t: now, ...s.tm }, s.phase ?? 'APPROACH', s.events ?? []);
    });
    expect(b.events).toEqual(whole.events);
    expect(kinds(whole)).toEqual(['speed', 'sink_rate']);
  });
});
