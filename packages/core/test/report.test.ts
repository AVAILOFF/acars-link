// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AcarsCore,
  type CoreOptions,
  compileScenario,
  distanceNm,
  flightReport,
  generateSyntheticFlight,
  LANDED_WITHIN_NM,
  type Ofp,
  type OooiKind,
  type PilotMessage,
  parseSimbriefOfp,
  type ScenarioDef,
  type SyntheticFlight,
  type TelemetrySnapshot,
  withTouchdown,
} from '../src/index.js';

/** T69: the flight report after ON_BLOCK, from the core's own data. */

const ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'ofp', 'rctp-rjbb-a35k-kgs.json'), 'utf8'),
  ),
);
const normal = generateSyntheticFlight({ ofp });

const def = (d: Partial<ScenarioDef> & Pick<ScenarioDef, 'id' | 'trigger'>): ScenarioDef => ({
  version: 1,
  category: 'ops',
  title: d.id,
  enabled_by_default: true,
  steps: [{ send: { body: `${d.id.toUpperCase()} {phase}` } }],
  ...d,
});

const SCENARIOS = [
  def({ id: 'hello', trigger: { on: 'phase_enter', phase: 'CLIMB' } }),
  def({
    id: 'medical',
    category: 'irregular',
    trigger: { on: 'phase_enter', phase: 'CRUISE' },
    steps: [
      { send: { body: 'MEDICAL CASE ON BOARD\nREPLY CONTINUE OR DIVERT' } },
      {
        wait: { reply: { options: ['CONTINUE', 'DIVERT'], timeout_min: 10, default: 'CONTINUE' } },
      },
      { send: { body: 'NOTED {reply.option}' } },
    ],
  }),
].map(compileScenario);

const pilot = (text: string, from = ofp.callsign): PilotMessage => ({ from, type: 'telex', text });

interface Flown {
  readonly core: AcarsCore;
  readonly oooi: Record<OooiKind, number>;
  readonly snapshots: readonly TelemetrySnapshot[];
  readonly airline: number;
}

/** Flies the snapshots to ON_BLOCK and closes the flight; `inbound` = telexes at a snapshot index. */
function fly(
  flight: SyntheticFlight = normal,
  inbound: Readonly<Record<number, readonly PilotMessage[]>> = {},
  o: Partial<CoreOptions> = {},
  plan: Ofp = ofp,
): Flown {
  const core = AcarsCore.create({ ofp: plan, scenarios: SCENARIOS, ...o });
  core.startFlight();
  const oooi: Partial<Record<OooiKind, number>> = {};
  let airline = 0;
  flight.snapshots.forEach((s, i) => {
    const msgs = inbound[i];
    const r = core.tick({
      now: s.t,
      telemetry: s,
      ...(msgs === undefined ? {} : { inbound: msgs }),
    });
    airline += r.outbound.length;
    for (const e of r.events) {
      if (e.type.startsWith('OOOI_')) oooi[e.type.slice(5) as OooiKind] = e.t;
    }
  });
  const last = flight.snapshots.at(-1) as TelemetrySnapshot;
  airline += core.endFlight('DONE', last.t + 1000).outbound.length;
  return { core, oooi: oooi as Record<OooiKind, number>, snapshots: flight.snapshots, airline };
}

const at = (f: Flown, t: number) => f.snapshots.find((s) => s.t === t) as TelemetrySnapshot;
const cruiseIndex = normal.stages.find((m) => m.stage === 'CRUISE')?.index ?? -1;

describe('flight report (T69)', () => {
  // The answer to the medical case and a telex from another aircraft (not counted).
  const f = fly(normal, {
    [cruiseIndex + 120]: [pilot('CONTINUE'), pilot('HELLO', 'ZZZ999')],
    [cruiseIndex + 200]: [pilot('REQ GATE')],
  });
  const r = f.core.report();

  it('the flight and the OFP', () => {
    expect(r).toMatchObject({
      v: 1,
      callsign: ofp.callsign,
      origin: 'RCTP',
      destination: 'RJBB',
      aircraftIcao: ofp.aircraft.icao,
    });
  });

  it('OOOI times are those of the phase machine, against the OFP schedule', () => {
    const t = ofp.times;
    expect(r.times.OUT).toEqual({
      actual: f.oooi.OUT,
      plan: t.schedOutMs,
      diff: f.oooi.OUT - t.schedOutMs,
    });
    expect(r.times.OFF.plan).toBe(t.schedOffMs);
    expect(r.times.ON.actual).toBe(f.oooi.ON);
    expect(r.times.IN).toEqual({
      actual: f.oooi.IN,
      plan: t.schedInMs,
      diff: f.oooi.IN - t.schedInMs,
    });
  });

  it('block and flight time against sched_block and est_time_enroute', () => {
    expect(r.blockMs.actual).toBe(f.oooi.IN - f.oooi.OUT);
    expect(r.blockMs.plan).toBe((ofp.times.schedBlockSec as number) * 1000);
    expect(r.airMs.actual).toBe(f.oooi.ON - f.oooi.OFF);
    expect(r.airMs.plan).toBe(ofp.times.estTimeEnrouteSec * 1000);
    expect(r.airMs.diff).toBe(f.oooi.ON - f.oooi.OFF - ofp.times.estTimeEnrouteSec * 1000);
  });

  it('fuel at OUT/OFF/ON/IN is the fuel of the snapshot of that time, against the plan', () => {
    const fuel = (k: OooiKind) => Math.round(at(f, f.oooi[k]).fuelKg);
    expect(r.fuelKg.OUT).toEqual({
      actual: fuel('OUT'),
      plan: Math.round(ofp.fuel.planRampKg),
      diff: fuel('OUT') - Math.round(ofp.fuel.planRampKg),
    });
    expect(r.fuelKg.OFF.actual).toBe(fuel('OFF'));
    expect(r.fuelKg.OFF.plan).toBe(Math.round(ofp.fuel.planTakeoffKg));
    expect(r.fuelKg.ON.plan).toBe(Math.round(ofp.fuel.planLandingKg as number));
    expect(r.fuelKg.IN).toEqual({ actual: fuel('IN'), plan: null, diff: null });
    expect(r.burnKg.taxiOut.actual).toBe(fuel('OUT') - fuel('OFF'));
    expect(r.burnKg.taxiOut.plan).toBe(Math.round(ofp.fuel.taxiKg as number));
    expect(r.burnKg.trip.actual).toBe(fuel('OFF') - fuel('ON'));
    expect(r.burnKg.trip.plan).toBe(Math.round(ofp.fuel.enrouteBurnKg));
    expect(r.burnKg.taxiIn).toEqual({ actual: fuel('ON') - fuel('IN'), plan: null, diff: null });
    expect(r.burnKg.block.actual).toBe(fuel('OUT') - fuel('IN'));
  });

  it('no touchdown rate from the sim: null ("no data"), nothing invented', () => {
    expect(r.touchdownFpm).toBeNull();
    expect(fly(withTouchdown(normal, 420)).core.report().touchdownFpm).toBe(420);
  });

  it('landed at the destination, no go-around, no delay', () => {
    expect(r.landed).toMatchObject({ icao: 'RJBB', diverted: false });
    expect(r.divert).toBeNull();
    expect(r.goArounds).toBe(0);
    expect(r.delay).toEqual({ min: 0, parts: [] });
  });

  it('messages: the airline produced, the pilot sent, of them answers; irregular scenarios', () => {
    expect(r.messages).toEqual({ airline: f.airline, pilot: 2, replies: 1 });
    expect(f.airline).toBeGreaterThanOrEqual(3);
    expect(r.irregular).toEqual(['medical']);
  });

  it('a go-around is counted', () => {
    const ga = fly(generateSyntheticFlight({ ofp, goAroundAglFt: 400 })).core.report();
    expect(ga.goArounds).toBe(1);
    expect(ga.landed?.icao).toBe('RJBB');
  });

  it('the same report from a core restored from its state', () => {
    const core = AcarsCore.create({ ofp, scenarios: SCENARIOS });
    core.startFlight();
    const half = Math.floor(normal.snapshots.length / 2);
    const tick = (c: AcarsCore, s: TelemetrySnapshot, i: number) =>
      c.tick({
        now: s.t,
        telemetry: s,
        ...(i === cruiseIndex + 120
          ? { inbound: [pilot('CONTINUE'), pilot('HELLO', 'ZZZ999')] }
          : {}),
        ...(i === cruiseIndex + 200 ? { inbound: [pilot('REQ GATE')] } : {}),
      });
    for (const [i, s] of normal.snapshots.slice(0, half).entries()) tick(core, s, i);
    const restored = AcarsCore.fromState(JSON.parse(JSON.stringify(core.getState())), {
      ofp,
      scenarios: SCENARIOS,
    });
    for (const [i, s] of normal.snapshots.slice(half).entries()) tick(restored, s, half + i);
    restored.endFlight('DONE', (normal.snapshots.at(-1) as TelemetrySnapshot).t + 1000);
    expect(restored.report()).toEqual(r);
  });
});

describe('landing airport (T69, approved 2026-10-30)', () => {
  /** The OFP flown to another airport: the snapshots end there, the core keeps the real OFP. */
  const flownTo = (to: { lat: number; lon: number; elevationFt?: number }) => {
    const plan: Ofp = {
      ...ofp,
      destination: { ...ofp.destination, ...to },
      navlog: [
        ...ofp.navlog.slice(0, -1),
        { ...(ofp.navlog.at(-1) as Ofp['navlog'][number]), ...to },
      ],
    };
    return generateSyntheticFlight({ ofp: plan, startMs: normal.snapshots[0]?.t as number });
  };

  it('a diversion to the alternate: the airport of the touchdown', () => {
    const alt = ofp.alternates[0] as Ofp['alternates'][number];
    expect(alt.icao).toBe('RJGG');
    const f = fly(flownTo(alt), {
      [cruiseIndex + 120]: [pilot('DIVERT RJGG')],
    });
    const r = f.core.report();
    expect(r.landed).toMatchObject({ icao: 'RJGG', diverted: true });
    expect(r.destination).toBe('RJBB');
    const on = at(f, f.oooi.ON);
    expect(r.landed).toMatchObject({ lat: on.lat, lon: on.lon });
  });

  it('far from every known airport: unknown, with the position', () => {
    const nowhere = { lat: ofp.destination.lat + 1, lon: ofp.destination.lon };
    const r = fly(flownTo(nowhere)).core.report();
    expect(r.landed?.icao).toBeNull();
    expect(r.landed?.diverted).toBe(true);
    expect(distanceNm(r.landed as { lat: number; lon: number }, nowhere)).toBeLessThan(
      LANDED_WITHIN_NM,
    );
  });
});

describe('flightReport without data', () => {
  it('nothing recorded: every actual is null', () => {
    const r = flightReport({
      ofp,
      oooi: { OUT: null, OFF: null, ON: null, IN: null },
      oooiAt: { OUT: null, OFF: null, ON: null, IN: null },
      goArounds: 0,
      touchdownFpm: null,
      delayMs: null,
      delayParts: [],
      divert: null,
      counts: { airline: 0, pilot: 0, replies: 0 },
      started: [],
    });
    expect(r.times.OUT).toEqual({ actual: null, plan: ofp.times.schedOutMs, diff: null });
    expect(r.blockMs.actual).toBeNull();
    expect(r.fuelKg.OFF.actual).toBeNull();
    expect(r.burnKg.trip).toEqual({
      actual: null,
      plan: Math.round(ofp.fuel.enrouteBurnKg),
      diff: null,
    });
    expect(r.landed).toBeNull();
    expect(r.delay.min).toBe(0);
  });

  it('delay parts in minutes, with their codes', () => {
    const r = flightReport({
      ofp,
      oooi: { OUT: null, OFF: null, ON: null, IN: null },
      oooiAt: { OUT: null, OFF: null, ON: null, IN: null },
      goArounds: 0,
      touchdownFpm: 312.6,
      delayMs: 25 * 60_000,
      delayParts: [
        { code: '63', ms: 10 * 60_000 },
        { code: '81', ms: 15 * 60_000 },
      ],
      divert: 'RJGG',
      counts: { airline: 4, pilot: 1, replies: 0 },
      started: [
        { id: 'a', category: 'ops' },
        { id: 'b', category: 'irregular' },
      ],
    });
    expect(r.delay).toEqual({
      min: 25,
      parts: [
        { code: '63', min: 10 },
        { code: '81', min: 15 },
      ],
    });
    expect(r.touchdownFpm).toBe(313);
    expect(r.divert).toBe('RJGG');
    expect(r.irregular).toEqual(['b']);
  });
});
