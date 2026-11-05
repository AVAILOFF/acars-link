// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AcarsCore,
  type CompiledScenario,
  type CoreEvent,
  classifyFlight,
  compileScenario,
  type FlightKind,
  generateSyntheticFlight,
  type Ofp,
  type OutboundMessage,
  parseSimbriefOfp,
  type ScenarioDef,
  ScenarioError,
  stageIndex,
} from '../src/index.js';

/** T89: kind of flight — FPL items 8 and 18 of the OFP, `classifyFlight`, the scenario filter. */

// biome-ignore lint/suspicious/noExplicitAny: tests mutate raw JSON freely
type RawOfp = any;
const raw = (): RawOfp =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'ofp', 'rctp-rjbb-a35k-kgs.json'), 'utf8'),
  );

/** Item 18 of real OFPs (reference/ofp/raw, SJX822 and DAL8955, 2026-11-04). */
const SJX_18 = 'PBN/A1B1C1D1L1O1S2 DOF/261008 REG/GKXWB EET/RJJJ0024 OPR/SJX PER/D RMK/TCAS';
const DAL_18 =
  'PBN/A1B1C1D1L1O1S2T1 NAV/Z1P1 RNP2 DAT/1FANSE2PDC CPDLCX SUR/A2 260B RSP180 CANMANDATE DOF/261031 REG/BB752 EET/KZDC0036 KZBW0127 46N050W0336 SEL/BBSA CODE/A3C3E0 OPR/DAL PER/C RALT/CYJT BIKF RMK/TCAS';

function parse(edit: (r: RawOfp) => void = () => {}): Ofp {
  const r = raw();
  edit(r);
  return parseSimbriefOfp(r);
}

/** An OFP with these passengers, freight (kg), FPL type and item 18. */
function ofpWith(o: { pax?: number; freight?: number; type?: string; item18?: string }): Ofp {
  return parse((r) => {
    if (o.pax !== undefined) r.weights.pax_count = String(o.pax);
    if (o.freight !== undefined) {
      r.weights.freight_added = String(o.freight);
      r.weights.cargo = String(o.freight);
    }
    if (o.type !== undefined) r.atc.flight_type = o.type;
    if (o.item18 !== undefined) r.atc.section18 = o.item18;
  });
}

describe('OFP: FPL items 8 and 18, freight (T89)', () => {
  it('reads the type of flight, the flight rules and item 18', () => {
    const ofp = parse((r) => {
      r.atc.section18 = SJX_18;
      r.weights.freight_added = '0';
    });
    expect(ofp.flightType).toBe('S');
    expect(ofp.flightRules).toBe('I');
    expect(ofp.item18).toEqual({ raw: SJX_18, sts: [], rmk: 'TCAS' });
    expect(ofp.weights.freightKg).toBe(0);
    // `cargo` is bags + freight (266 × 25 kg of bags here).
    expect(ofp.weights.cargoKg).toBe(6650);
  });

  it('keeps values with spaces and slashes inside one indicator', () => {
    const ofp = parse((r) => {
      r.atc.section18 = DAL_18;
    });
    expect(ofp.item18?.sts).toEqual([]);
    expect(ofp.item18?.rmk).toBe('TCAS');
    expect(ofp.item18?.raw).toBe(DAL_18);
  });

  it('reads several STS/ reasons and a remark of several words', () => {
    const ofp = parse((r) => {
      r.atc.section18 = 'STS/HOSP NONRVSM PBN/A1 DOF/261104 RMK/PATIENT ON BOARD ACAS II';
    });
    expect(ofp.item18?.sts).toEqual(['HOSP', 'NONRVSM']);
    expect(ofp.item18?.rmk).toBe('PATIENT ON BOARD ACAS II');
  });

  it('empty item 18, odd codes and no freight field read as null', () => {
    const ofp = parse((r) => {
      r.atc.section18 = '';
      r.atc.flight_type = 'scheduled';
      delete r.atc.flight_rules;
      delete r.weights.freight_added;
    });
    expect(ofp.item18).toBeNull();
    expect(ofp.flightType).toBeNull();
    expect(ofp.flightRules).toBeNull();
    expect(ofp.weights.freightKg).toBeNull();
    const nil = parse((r) => {
      r.atc.section18 = '0';
    });
    expect(nil.item18).toBeNull();
  });

  it('converts freight planned in lbs to kg', () => {
    const ofp = parse((r) => {
      r.params.units = 'lbs';
      r.weights.freight_added = '22046';
    });
    expect(ofp.weights.freightKg).toBe(10000);
  });
});

describe('classifyFlight (T89)', () => {
  it('a passenger flight is scheduled; FPL type N is not a charter (decision 2026-11-04)', () => {
    expect(classifyFlight(ofpWith({}))).toMatchObject({
      kind: 'sched_pax',
      auto: 'sched_pax',
      override: null,
      rule: 'default',
      paxCount: 266,
    });
    expect(classifyFlight(ofpWith({ type: 'N' })).kind).toBe('sched_pax');
  });

  it('no passengers: freight → cargo, none → ferry', () => {
    expect(classifyFlight(ofpWith({ pax: 0, freight: 42_500 }))).toMatchObject({
      kind: 'cargo',
      rule: 'cargo',
      freightKg: 42_500,
    });
    expect(classifyFlight(ofpWith({ pax: 0, freight: 0 }))).toMatchObject({
      kind: 'ferry',
      rule: 'ferry',
    });
  });

  it('without freight_added (recordings before T89) the cargo counts', () => {
    const ofp = ofpWith({ pax: 0, freight: 1200 });
    const { freightKg: _, ...weights } = ofp.weights;
    const old: Ofp = { ...ofp, weights };
    expect(classifyFlight(old).kind).toBe('cargo');
  });

  it('FPL type G → business aviation; an empty leg is still a ferry', () => {
    expect(classifyFlight(ofpWith({ pax: 4, type: 'G' }))).toMatchObject({
      kind: 'bizav',
      rule: 'flight_type',
      flightType: 'G',
    });
    expect(classifyFlight(ofpWith({ pax: 0, freight: 0, type: 'G' })).kind).toBe('ferry');
  });

  it('STS/HOSP or STS/MEDEVAC → air ambulance, before every other rule', () => {
    expect(classifyFlight(ofpWith({ item18: 'STS/HOSP RMK/X' }))).toMatchObject({
      kind: 'medevac',
      rule: 'sts',
      sts: 'HOSP',
    });
    expect(classifyFlight(ofpWith({ pax: 0, item18: 'STS/NONRVSM MEDEVAC' })).sts).toBe('MEDEVAC');
    expect(classifyFlight(ofpWith({ item18: 'STS/HUM' })).kind).toBe('sched_pax');
  });

  it("the user's choice wins; the recognized kind stays", () => {
    const k = classifyFlight(ofpWith({ pax: 0, freight: 900 }), 'charter_pax');
    expect(k).toMatchObject({ kind: 'charter_pax', auto: 'cargo', override: 'charter_pax' });
  });
});

describe('scenario field operations (T89)', () => {
  const base: ScenarioDef = {
    id: 'pax_only',
    version: 1,
    category: 'irregular',
    title: 'Pax',
    enabled_by_default: true,
    trigger: { on: 'phase_enter', phase: 'BOARDING' },
    steps: [{ send: { body: 'PAX {flight.kind}' } }],
  };

  it('an unknown kind or an empty list fails the compile', () => {
    expect(() => compileScenario({ ...base, operations: ['tanker' as FlightKind] })).toThrowError(
      ScenarioError,
    );
    expect(() => compileScenario({ ...base, operations: [] })).toThrowError(ScenarioError);
    expect(compileScenario({ ...base, operations: ['cargo'] }).def.operations).toEqual(['cargo']);
  });
});

describe('the engine filters by the kind of flight (T89)', () => {
  const sc = (id: string, d: Partial<ScenarioDef> = {}): CompiledScenario =>
    compileScenario({
      id,
      version: 1,
      category: 'irregular',
      title: id,
      enabled_by_default: true,
      trigger: { on: 'phase_enter', phase: 'TAXI_OUT' },
      steps: [{ send: { body: `${id.toUpperCase()} {flight.kind}` } }],
      ...d,
    });
  const pax = sc('pax_story', { operations: ['sched_pax', 'charter_pax'] });
  const any = sc('any_story');
  const manual = sc('manual_story', {
    operations: ['sched_pax'],
    trigger: { on: 'phase_enter', phase: 'DONE' },
  });

  interface Run {
    readonly out: OutboundMessage[];
    readonly events: CoreEvent[];
    readonly core: AcarsCore;
  }

  function fly(
    ofp: Ofp,
    o: {
      flightKind?: { override: FlightKind | null };
      choose?: { at: 'GATE' | 'CRUISE'; override: FlightKind | null };
      force?: 'GATE';
    } = {},
  ): Run {
    const flight = generateSyntheticFlight({ ofp });
    const core = AcarsCore.create({
      ofp,
      scenarios: [pax, any, manual],
      seed: 'kind',
      ...(o.flightKind === undefined ? {} : { flightKind: o.flightKind }),
    });
    core.startFlight();
    const chooseAt = o.choose === undefined ? -1 : stageIndex(flight, o.choose.at, 30);
    const forceAt = o.force === undefined ? -1 : stageIndex(flight, o.force, 30);
    const out: OutboundMessage[] = [];
    const events: CoreEvent[] = [];
    flight.snapshots.forEach((s, i) => {
      const r = core.tick({
        now: s.t,
        telemetry: s,
        ...(i === chooseAt && o.choose !== undefined
          ? { flightKind: { override: o.choose.override } }
          : {}),
        ...(i === forceAt ? { force: ['manual_story'] } : {}),
      });
      out.push(...r.outbound);
      events.push(...r.events);
    });
    return { out, events, core };
  }

  // Scenarios starting on one tick go by priority, then id.
  const sent = (r: Run) => r.out.map((m) => m.message.text).sort();
  const cargo = ofpWith({ pax: 0, freight: 30_000 });
  const pass = ofpWith({});

  // The formatter writes `_` as `-` (allowed characters of the display profile).
  it('a passenger scenario does not start on cargo; one without operations does', () => {
    const r = fly(cargo, { flightKind: { override: null } });
    expect(sent(r)).toEqual(['ANY-STORY CARGO']);
    expect(r.events).toContainEqual(
      expect.objectContaining({ type: 'SCENARIO_SKIPPED', id: 'pax_story', reason: 'operation' }),
    );
    expect(r.core.flightKind).toMatchObject({ kind: 'cargo', auto: 'cargo', locked: true });
    expect(r.core.report().flightKind).toBe('cargo');
  });

  it('"run now" does not get round the kind', () => {
    const r = fly(cargo, { flightKind: { override: null }, force: 'GATE' });
    expect(r.events).toContainEqual(
      expect.objectContaining({
        type: 'FORCED',
        id: 'manual_story',
        result: 'operation',
        detail: 'cargo',
      }),
    );
    expect(sent(r).some((t) => t.startsWith('MANUAL-STORY'))).toBe(false);
  });

  it('without the option (recordings before T89) nothing is filtered', () => {
    const r = fly(cargo);
    expect(sent(r)).toEqual(['ANY-STORY CARGO', 'PAX-STORY CARGO']);
    expect(r.core.flightKind).toBeNull();
    expect(r.core.report().flightKind).toBeUndefined();
  });

  it("the user's choice at the start and before OUT applies", () => {
    expect(sent(fly(cargo, { flightKind: { override: 'sched_pax' } }))).toEqual([
      'ANY-STORY SCHED-PAX',
      'PAX-STORY SCHED-PAX',
    ]);
    const r = fly(pass, {
      flightKind: { override: null },
      choose: { at: 'GATE', override: 'ferry' },
    });
    expect(sent(r)).toEqual(['ANY-STORY FERRY']);
    expect(r.events).toContainEqual(
      expect.objectContaining({
        type: 'FLIGHT_KIND',
        kind: 'ferry',
        override: 'ferry',
        applied: true,
      }),
    );
  });

  it('after OUT the kind is fixed', () => {
    const r = fly(cargo, {
      flightKind: { override: null },
      choose: { at: 'CRUISE', override: 'sched_pax' },
    });
    expect(r.events).toContainEqual(
      expect.objectContaining({ type: 'FLIGHT_KIND', kind: 'cargo', applied: false }),
    );
    expect(r.core.flightKind?.kind).toBe('cargo');
  });

  it('the choice survives the state (restore)', () => {
    const flight = generateSyntheticFlight({ ofp: cargo });
    const options = {
      ofp: cargo,
      scenarios: [pax, any],
      seed: 'kind',
      flightKind: { override: null },
    };
    const core = AcarsCore.create(options);
    core.startFlight();
    const [first] = flight.snapshots;
    core.tick({
      now: first?.t ?? 0,
      telemetry: first ?? null,
      flightKind: { override: 'charter_pax' },
    });
    const again = AcarsCore.fromState(core.getState(), options);
    expect(again.flightKind).toMatchObject({ kind: 'charter_pax', override: 'charter_pax' });
  });
});
