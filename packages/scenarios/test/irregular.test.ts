// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import {
  AcarsCore,
  buildFlightData,
  generateSyntheticFlight,
  type Ofp,
  stageIndex,
  type Value,
  withPause,
  withTouchdown,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { withHoldMin } from './hold.js';
import {
  all,
  byId,
  type Case,
  daysBefore,
  errors,
  FLIGHTS,
  fly,
  ids,
  irregular,
  irregularFiles,
  kg,
  late,
  nextDay,
  normal,
  type Run,
  SETUP,
  shaped,
  textsOf,
  toCurfew,
} from './irregular-fixture.js';

/**
 * T14: the irregular scenarios (`irregular/*.yaml`, docs/02 "Нестандартные"): the chains inside
 * a flight (diversion, gate change, connection outcome) and between flights (flags: MEL item,
 * disruptive passenger, commander's discretion, rush bags). Each alone on the 3 synthetic
 * flights: `irregular-alone-*.test.ts`.
 */

describe('irregular scenario files', () => {
  it('15+ scenarios, file name = id, category irregular, each with a test setup', () => {
    expect(irregular.length).toBeGreaterThanOrEqual(15);
    expect(irregular.map((s) => `${s.id}.yaml`)).toEqual(irregularFiles.map((f) => f.file));
    expect(irregular.every((s) => s.def.category === 'irregular')).toBe(true);
    // UI texts in English (the telexes too); the Russian ones — `locales/ru.yaml` (index.test.ts, T85).
    for (const s of irregular) expect(s.def.description, s.id).toMatch(/^[ -~]+$/);
    // Questions are tested answer by answer: every scenario that asks lists its answers.
    for (const s of irregular) {
      const asks = s.steps.some((x) => x.kind === 'wait_reply');
      expect(asks, s.id).toBe((SETUP[s.id]?.answers?.length ?? 0) > 0);
    }
  });
});

describe('chains inside a flight', () => {
  const c = FLIGHTS[0] as Case;
  const withBase = (id: string) => [
    byId(id),
    ...all.filter((s) => s.def.category !== 'irregular' && s.def.trigger.on !== 'command'),
  ];

  it('DIVERT of a medical case sets the diversion: no arrival messages for the destination', () => {
    const r = fly(c, withBase('medical_onboard'), { answer: 'DIVERT' });
    expect(errors(r)).toEqual([]);
    const set = r.events.find((e) => e.type === 'SET' && e.name === 'flight.divert');
    // The nearest of the origin and the alternate at that moment.
    expect(set).toMatchObject({ name: 'flight.divert', applied: true });
    const icao = (set as { value: string }).value;
    expect(['RCTP', 'RJGG']).toContain(icao);
    expect(textsOf(r, 'medical_onboard')[2]).toMatch(
      new RegExp(`ROGER DIVERT ${icao} [0-9]+ NM FROM PRESENT POS`),
    );
    for (const id of ['arrival_info', 'welcome_turnaround']) expect(ids(r)).not.toContain(id);
    const cont = fly(c, withBase('medical_onboard'), { answer: 'CONTINUE' });
    expect(ids(cont)).toContain('arrival_info');
  });

  it('a gate change moves the gate of arrival_info and REQ GATE', () => {
    const scenarios = [...withBase('gate_reassignment'), byId('cmd_req_gate')];
    const r = fly(c, scenarios);
    const before = /EXPECTED GATE (\w+)/.exec(textsOf(r, 'gate_assignment')[0] ?? '')?.[1];
    const after = /NEW GATE (\w+)/.exec(textsOf(r, 'gate_reassignment')[0] ?? '')?.[1];
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect(textsOf(r, 'gate_reassignment')[0]).toContain(`GATE ${before} OCCUPIED`);
    expect(textsOf(r, 'arrival_info')[0]).toContain(`GATE ${after} CONFIRMED`);
  });

  it('a short connection ends made, held or missed, never two of them', () => {
    const set = ['short_connection', 'connection_made', 'connection_held', 'connection_missed'].map(
      byId,
    );
    const made = fly(c, set, { delayMin: 30 });
    const missed = fly(late(kg, 90), set);
    expect(ids(made).filter((x) => x !== '#ops')).toEqual(['short_connection', 'connection_made']);
    expect(ids(missed).filter((x) => x !== '#ops')).toEqual([
      'short_connection',
      'connection_missed',
    ]);
    const held = fly(late(kg, 30), set);
    expect(ids(held).filter((x) => x !== '#ops')).toEqual(['short_connection', 'connection_held']);
    // The passengers are a share of the transfer passengers.
    const pax = Number(/(\d+) PAX TO/.exec(textsOf(held, 'short_connection')[0] ?? '')?.[1]);
    expect(pax).toBeGreaterThan(0);
    const transfer = buildFlightData(kg, 'irregular').ops.transferPax;
    expect(pax).toBeLessThanOrEqual(Math.ceil(transfer / 2));
  });

  it('without the test hook: only an airline with departures from the destination (OpenFlights, T43)', () => {
    const set = ['short_connection', 'connection_made'].map(byId);
    // SJX has no routes in OpenFlights (2014): no onward flight is invented.
    expect(
      ids(fly(c, set, { delayMin: 30, synthetic: false })).filter((x) => x !== '#ops'),
    ).toEqual([]);
    // ANA flew from RJBB: an onward flight, without a number.
    const ana: Ofp = { ...kg, airlineIcao: 'ANA', callsign: 'ANA822' };
    const r = fly({ ...c, ofp: ana }, set, { delayMin: 30, synthetic: false });
    expect(ids(r).filter((x) => x !== '#ops')).toEqual(['short_connection', 'connection_made']);
    expect(textsOf(r, 'short_connection')[0]).toMatch(/\d+ PAX TO ONWARD FLT/);
    expect(textsOf(r, 'connection_made')[0]).toContain('ONWARD FLT WILL WAIT');
    for (const m of r.out) expect(m.message.text).not.toMatch(/ANA\d{3}/);
  });

  it('next leg version 3 (T55): an own route in the AeroDataBox statistics is an onward flight', () => {
    const set = ['short_connection', 'connection_made'].map(byId);
    const o = { delayMin: 30, synthetic: false, nextLegVersion: 3 } as const;
    const routes = (operators: string[]) => ({
      icao: kg.destination.icao,
      list: [{ dest: 'RJTT', daily: 6.5, operators }],
    });
    // SJX is not in OpenFlights; with its route in the statistics it flies on.
    const r = fly(c, set, { ...o, routes: routes(['ANA', 'SJX']) });
    expect(ids(r).filter((x) => x !== '#ops')).toEqual(['short_connection', 'connection_made']);
    expect(textsOf(r, 'short_connection')[0]).toMatch(/\d+ PAX TO ONWARD FLT/);
    // Only other airlines on the route, or version 2: as before (OpenFlights).
    expect(ids(fly(c, set, { ...o, routes: routes(['ANA']) })).filter((x) => x !== '#ops')).toEqual(
      [],
    );
    const v2 = fly(c, set, { ...o, nextLegVersion: 2, routes: routes(['SJX']) });
    expect(ids(v2).filter((x) => x !== '#ops')).toEqual([]);
  });

  it('a real departure (T30, AeroDataBox) replaces the synthetic one, with the source line', () => {
    const set = ['short_connection', 'connection_made', 'connection_held', 'connection_missed'].map(
      byId,
    );
    const sta = kg.times.schedInMs;
    const connex = {
      icao: kg.destination.icao,
      list: [
        {
          number: 'SJX862',
          dest: 'RCTP',
          std: sta + 50 * 60_000,
          terminal: '1',
          gate: 'B12',
          codeshare: false,
        },
      ],
    };
    for (const synthetic of [true, false]) {
      const r = fly(late(kg, 30), set, { synthetic, connex });
      expect(ids(r).filter((x) => x !== '#ops')).toEqual(['short_connection', 'connection_missed']);
      const text = textsOf(r, 'short_connection')[0] ?? '';
      expect(text).toMatch(/\d+ PAX TO SJX862/);
      const std = new Date(sta + 50 * 60_000).toISOString().slice(11, 16).replace(':', '');
      expect(text).toContain(`STD ${std}Z`);
      // textsOf joins the lines: the source is the end of the text.
      expect(text).toMatch(/ SRC AERODATABOX$/);
      expect(textsOf(r, 'connection_missed')[0]).toMatch(/ SRC AERODATABOX$/);
    }
    // The synthetic flight carries no source line.
    for (const m of fly(late(kg, 30), set).out) expect(m.message.text).not.toContain('AERODATABOX');
  });

  it('the curfew needs a delay; UNABLE diverts to the alternate', () => {
    const itami = toCurfew(c);
    expect(ids(fly(itami, [byId('curfew_dest')]))).toEqual([]);
    const r = fly(itami, [byId('curfew_dest')], { delayMin: 90, answer: 'UNABLE' });
    // 21:00 local at Itami (UTC+9), 45 min from the estimate, 90 min late: -45.
    expect(textsOf(r, 'curfew_dest')[0]).toContain(
      'NOISE CURFEW AT RJOO LATEST LANDING 1200Z LOCAL 2100 MARGIN -45 MIN EXPEDITE IF ABLE REPLY ABLE OR UNABLE',
    );
    expect(textsOf(r, 'curfew_dest')[1]).toContain('PLAN DIVERT RJGG');
    expect(r.events).toContainEqual(
      expect.objectContaining({ type: 'SET', name: 'flight.divert', value: 'RJGG' }),
    );
  });

  it('no curfew message where the destination has none (Kansai), whatever the delay', () => {
    for (const delayMin of [90, 600])
      expect(ids(fly(c, [byId('curfew_dest')], { delayMin })).filter((x) => x !== '#ops')).toEqual(
        [],
      );
  });

  it('de-icing only at a cold origin', () => {
    expect(ids(fly(c, [byId('deicing_holdover')]))).toEqual([]);
    const r = fly(c, [byId('deicing_holdover')], { cold: true, answer: 'READY' });
    expect(textsOf(r, 'deicing_holdover')[0]).toContain('OAT -2 C');
    // The pad of both messages is the same; the scratch flags are gone after.
    const pad = /PAD (\d)/.exec(textsOf(r, 'deicing_holdover')[0] ?? '')?.[1];
    expect(textsOf(r, 'deicing_holdover')[1]).toContain(`PAD ${pad}`);
    expect(r.core.flags).toEqual({});
  });
});

describe('continuations (T41)', () => {
  const c = FLIGHTS[0] as Case;
  const med = (seed: string, answer: string) => fly(c, [byId('medical_onboard')], { seed, answer });

  it('HOLD: arrivals / the runway reopen when the drawn time is over (T50)', () => {
    for (const id of ['drone_activity', 'runway_closure_dest']) {
      const r = fly(c, [withHoldMin(byId(id), 5)], { answer: 'HOLD' });
      const t = textsOf(r, id);
      expect(t, id).toHaveLength(3);
      expect(t.slice(0, 2).join(' ')).toMatch(/NO ESTIMATE, NEXT UPDATE \d{4}Z/);
      expect(t[2]).toContain('ARRIVALS RESUMED');
      // DIVERT: no continuation.
      expect(textsOf(fly(c, [withHoldMin(byId(id), 5)], { answer: 'DIVERT' }), id)).toHaveLength(2);
    }
    const closed = textsOf(
      fly(c, [withHoldMin(byId('runway_closure_dest'), 5)], { answer: 'HOLD' }),
      'runway_closure_dest',
    );
    expect(closed[2]).toContain(`RWY ${kg.destination.planRwy} REOPENED`);
  });

  it('dest_fire: smoke drift from the METAR wind, 20 min hold, DIVERT ends the chain (T33)', () => {
    const hold = textsOf(
      fly(c, [withHoldMin(byId('dest_fire'), 5)], { answer: 'HOLD' }),
      'dest_fire',
    );
    expect(hold).toHaveLength(3);
    expect(hold[0]).toMatch(
      new RegExp(
        String.raw`FIRE REPORTED\s+(NEAR|[NSEW]{1,2} SIDE OF) RWY ` + kg.destination.planRwy,
      ),
    );
    expect(hold[0]).toMatch(/SMOKE DRIFTING [NSEW]{1,2}, WIND \d{3}\/\d+KT/);
    expect(hold[0]).toContain('PREPARE DIVERSION');
    expect(hold[1]).toMatch(/NEXT UPDATE \d{4}Z/);
    expect(hold[2]).toContain('UNDER CONTROL');
    const div = fly(c, [byId('dest_fire')], { answer: 'DIVERT' });
    expect(textsOf(div, 'dest_fire')).toHaveLength(2);
    expect(div.events).toContainEqual(
      expect.objectContaining({ type: 'SET', name: 'flight.divert' }),
    );
  });

  it('atc_flow_delay needs the CTOT of slot_ctot', () => {
    expect(ids(fly(c, [byId('atc_flow_delay')]))).toEqual([]);
    expect(ids(fly(c, [byId('atc_flow_delay'), byId('slot_ctot')]))).toContain('atc_flow_delay');
  });

  it('the alternate: an update before TOD', () => {
    const r = fly(c, [byId('altn_wx_deterioration')], { answer: 'OK' });
    const t = textsOf(r, 'altn_wx_deterioration');
    expect(t).toHaveLength(3);
    expect(t[2]).toContain('NO NEW OBSERVATION RECEIVED');
    const low = fly(c, [byId('altn_wx_deterioration')], { answer: 'LOW' });
    expect(textsOf(low, 'altn_wx_deterioration')).toHaveLength(2);
  });

  it('medical: the doctor decides the advice, paramedics meet the aircraft on block', () => {
    const seen = new Set<string>();
    for (let n = 1; n <= 12; n++) {
      const r = med(`m${n}`, 'CONTINUE');
      const t = textsOf(r, 'medical_onboard');
      expect(t).toHaveLength(4);
      const doc = /DOCTOR ON BOARD (YES|NO)/.exec(t[0] ?? '')?.[1] ?? '?';
      seen.add(doc);
      expect(t[1]).toContain(
        doc === 'NO' ? 'STRONGLY ADVISES DIVERT NOW' : 'DIVERT IF NO IMPROVEMENT',
      );
      expect(t[3]).toContain('PARAMEDICS AT AIRCRAFT DOOR');
      expect(t[3]).toContain('GATE');
      expect(r.core.flags).toEqual({});
    }
    expect([...seen].sort()).toEqual(['NO', 'YES']);
    // Diverted: the same door message, no gate of the destination.
    const d = textsOf(med('m1', 'DIVERT'), 'medical_onboard');
    expect(d).toHaveLength(4);
    expect(d[3]).toContain('PARAMEDICS AT AIRCRAFT DOOR');
    expect(d[3]).not.toContain('GATE');
  });

  it('medical: what the commander adds to the answer comes back in the reply', () => {
    const r = fly(c, [byId('medical_onboard')], {
      seed: 'm1',
      answer: 'CONTINUE PAX NOW CONSCIOUS',
    });
    expect(textsOf(r, 'medical_onboard').join(' ')).toContain('CREW INFO: PAX NOW CONSCIOUS');
  });

  it('a restrained passenger: police meet the aircraft on block, seat as reported', () => {
    const r = fly(c, [byId('unruly_passenger')], { answer: 'RESTRAIN' });
    const t = textsOf(r, 'unruly_passenger');
    expect(t).toHaveLength(3);
    const seat = /SEAT (\d+[A-K]) /.exec(t[0] ?? '')?.[1];
    expect(t[2]).toContain('POLICE AT AIRCRAFT DOOR');
    expect(t[2]).toContain(`PAX SEAT ${seat}`);
  });

  it('crew duty: NO and still not off block at the limit → a crew change with a new time', () => {
    // The sim is paused at the gate for 90 min: off block long after the limit.
    const paused: Case = {
      name: 'paused at the gate',
      ofp: kg,
      flight: withPause(normal, { atIndex: stageIndex(normal, 'GATE', 1200), durationSec: 5400 }),
    };
    const r = fly(paused, [byId('crew_duty_limit')], { delayMin: 45, answer: 'NO' });
    const t = textsOf(r, 'crew_duty_limit');
    expect(t).toHaveLength(3);
    expect(t[2]).toMatch(/CREW CHANGE ORDERED NEW CREW REPORTS \d{4}Z EXPECT DELAY \d\d MIN/);
    // OUT in time: no crew change.
    const ok = fly(c, [byId('crew_duty_limit')], { delayMin: 45, answer: 'NO' });
    expect(textsOf(ok, 'crew_duty_limit')).toHaveLength(2);
  });

  it('gate change: the baggage belt line; VIP seat in the first rows', () => {
    const r = fly(c, [byId('gate_reassignment'), byId('gate_assignment'), byId('arrival_info')]);
    const belt = /BELT (\d+)/.exec(textsOf(r, 'arrival_info')[0] ?? '')?.[1];
    expect(textsOf(r, 'gate_reassignment')[0]).toContain(`BAGGAGE BELT ${belt} UNCHANGED`);
    const v = textsOf(fly(c, [byId('vip_onboard')]), 'vip_onboard');
    expect(v[0]).toMatch(/VIP ON BOARD SEAT [12][A-K]/);
  });
});

describe('airline memory lifetime (T41)', () => {
  const day = 86_400_000;
  const out = kg.times.schedOutMs;
  const family = (date: number) => ({
    mel_item: 'X',
    mel_reg: 'R',
    mel_date: date,
    unruly_seat: '1A',
    unruly_flight: 'F',
    unruly_date: date,
    crew_discretion: 'F',
    crew_discretion_date: date,
    rush_bags: 3,
    rush_from: 'A',
    rush_to: 'B',
    rush_date: date,
    other: 'kept',
  });
  const start = (flags: Readonly<Record<string, Value>>) =>
    Object.keys(AcarsCore.create({ ofp: kg, scenarios: [], seed: 's', flags }).flags).sort();

  it('MEL 10 days, no-fly and discretion 30 days, rush bags 3 days', () => {
    expect(start(family(out - 2 * day))).toHaveLength(13);
    expect(start(family(out - 4 * day)).filter((n) => n.startsWith('rush'))).toEqual([]);
    expect(start(family(out - 4 * day))).toHaveLength(9);
    expect(start(family(out - 11 * day)).filter((n) => n.startsWith('mel'))).toEqual([]);
    expect(start(family(out - 11 * day))).toHaveLength(6);
    // 31 days: only what belongs to no family.
    expect(start(family(out - 31 * day))).toEqual(['other']);
  });

  it('a family without a date is kept', () => {
    expect(start({ mel_item: 'X', mel_reg: 'R' })).toEqual(['mel_item', 'mel_reg']);
  });
});

describe('realism (T42)', () => {
  const types = new Map<string, Case>();
  const withType = (icao: string): Case => {
    const known = types.get(icao);
    if (known !== undefined) return known;
    const ofp = { ...kg, aircraft: { ...kg.aircraft, icao } };
    const c = { name: icao, ofp, flight: generateSyntheticFlight({ ofp }) };
    types.set(icao, c);
    return c;
  };
  /** After the `n`-th message of `id`: the rest of the flight has nothing for these tests. */
  const sent = (id: string, n: number) => (r: Run) => textsOf(r, id).length >= n;

  it('dg_notoc: UN3481 with IMP code, dry ice in kg, a hold position, never UN3480', () => {
    const seen = new Set<string>();
    for (let n = 1; n <= 40; n++) {
      const r = fly(withType('B77W'), [byId('dg_notoc')], {
        seed: `dg${n}`,
        answer: 'ACK',
        until: sent('dg_notoc', 1),
      });
      const t = textsOf(r, 'dg_notoc')[0] ?? '';
      expect(t).not.toContain('UN3480');
      expect(t).toMatch(/POS (FWD|AFT|BULK) HOLD/);
      expect(t).not.toContain('CAO YES');
      const item = /(UN\d{4})/.exec(t)?.[1] ?? '?';
      seen.add(item);
      if (item === 'UN3481') expect(t).toMatch(/SEC I IMP RLI|SEC II IMP ELI/);
      if (item === 'UN1845') expect(t).toMatch(/NET (25|50|100) KG/);
    }
    expect([...seen].sort()).toEqual(['UN1266', 'UN1845', 'UN2814', 'UN3481']);
  });

  it('tech_defect_mel: MMEL items of the family, alerting system by the type', () => {
    const items = (icao: string) => {
      const out = new Set<string>();
      // 15 seeds: one of three equal items is missed with a chance of 3 × (2/3)^15 ≈ 0.7 %;
      // the seeds are fixed, so the test only has to hold for these.
      for (let n = 1; n <= 15; n++) {
        // The second message answers CONFIRM: the flag is set by then.
        const r = fly(withType(icao), [byId('tech_defect_mel')], {
          seed: `mel${n}`,
          answer: 'CONFIRM',
          until: sent('tech_defect_mel', 2),
        });
        expect(errors(r)).toEqual([]);
        const flags = r.core.flags;
        out.add(String(flags['mel_item']));
        expect(String(flags['mel_item']).length).toBeLessThanOrEqual(80);
        const first = textsOf(r, 'tech_defect_mel')[0] ?? '';
        expect(first).toContain(
          icao === 'A20N' ? 'ON ECAM' : icao === 'B38M' ? 'ON CREW ALERTING' : 'ON ECAM',
        );
      }
      return [...out].sort();
    };
    expect(items('A20N')).toEqual([
      '21-51-01 PACK FLOW CTL VALVE SECURED CLOSED - PACK INOP',
      '30-42-01 ONE WINDOW HEAT COMPUTER INOP - NO ICING OPS',
      '49-10-01 APU INOP - GPU AND ASU AT DEST',
    ]);
    expect(items('B38M')).toEqual([
      '21-01-01 ONE PACK INOP - MAX FL250',
      '30-01-02 ONE WING A/I VALVE INOP - NO ICING OPS',
      '49-01-01A APU INOP - GPU AND ASU AT DEST',
    ]);
    // Another type: the generic items, none of the above.
    const other = items('A359');
    expect(other.length).toBeGreaterThan(1);
    expect(other.some((x) => x.startsWith('49-01-01A') || x.startsWith('49-10-01'))).toBe(false);
  });
});

describe('chains between flights (flags)', () => {
  const day1: Case = FLIGHTS[0] as Case;
  const ofp2 = nextDay(kg);
  const day2: Case = {
    name: 'next day',
    ofp: ofp2,
    flight: generateSyntheticFlight({ ofp: ofp2 }),
  };
  const ofp3 = { ...nextDay(kg, 2), aircraft: { ...kg.aircraft, reg: 'JA01XJ' } };
  const otherAc: Case = {
    name: 'other aircraft',
    ofp: ofp3,
    flight: generateSyntheticFlight({ ofp: ofp3 }),
  };

  it('a deferred MEL item comes back on the same aircraft and is closed after arrival', () => {
    const set = ['tech_defect_mel', 'mel_carry_over'].map(byId);
    const first = fly(day1, set, { answer: 'CONFIRM' });
    expect(ids(first)).toEqual(['tech_defect_mel', 'tech_defect_mel']);
    const flags = first.core.flags;
    expect(flags).toMatchObject({ mel_reg: kg.aircraft.reg, mel_date: kg.times.schedOutMs });
    const item = flags['mel_item'] as string;

    // Another aircraft: nothing, the item stays open.
    const other = fly(otherAc, set, { flags });
    expect(ids(other)).toEqual([]);
    expect(other.core.flags).toEqual(flags);

    const second = fly(day2, set, { flags });
    expect(ids(second)).toEqual(['mel_carry_over', 'mel_carry_over']);
    expect(textsOf(second, 'mel_carry_over')[0]).toContain(item);
    expect(textsOf(second, 'mel_carry_over')[1]).toContain('MEL ITEM CLOSED');
    expect(second.core.flags).toEqual({});
    // While an item is open on the aircraft, no new defect is raised.
    expect(ids(fly(day2, set, { flags, answer: 'CONFIRM' }))).not.toContain('tech_defect_mel');
  });

  it('NEGATIVE clears the defect: nothing carries over', () => {
    const set = ['tech_defect_mel', 'mel_carry_over'].map(byId);
    const first = fly(day1, set, { answer: 'NEGATIVE' });
    expect(first.core.flags).toEqual({});
  });

  it('a restrained passenger is reported on the next flight once', () => {
    const set = ['unruly_passenger', 'unruly_followup'].map(byId);
    const first = fly(day1, set, { answer: 'RESTRAIN' });
    const seat = /SEAT (\d+[A-K])/.exec(textsOf(first, 'unruly_passenger')[0] ?? '')?.[1];
    expect(first.core.flags['unruly_seat']).toBe(seat);
    const second = fly(day2, set, { flags: first.core.flags });
    expect(textsOf(second, 'unruly_followup')[0]).toContain(`SEAT ${seat}`);
    expect(second.core.flags).toEqual({});
    // CONTINUE: nothing for the next flight.
    expect(fly(day1, set, { answer: 'CONTINUE' }).core.flags).toEqual({});
  });

  it("commander's discretion: extended rest on the next flight", () => {
    const set = ['crew_duty_limit', 'discretion_followup'].map(byId);
    const first = fly(day1, set, { delayMin: 45, answer: 'EXTEND' });
    expect(first.core.flags['crew_discretion']).toBe(kg.callsign);
    expect(ids(first)).not.toContain('discretion_followup');
    const second = fly(day2, set, { flags: first.core.flags });
    expect(textsOf(second, 'discretion_followup')[0]).toContain(
      `AFTER DISCRETION ON ${kg.callsign}`,
    );
    expect(second.core.flags).toEqual({});
  });

  it('bags left behind: case closed on the next flight', () => {
    const first = fly(day1, [byId('lost_baggage'), byId('rush_bags_followup')]);
    const n = first.core.flags['rush_bags'];
    expect(ids(first)).toEqual(['lost_baggage']);
    expect(textsOf(first, 'lost_baggage')[0]).toContain(`${String(n)} BAGS NOT LOADED AT RCTP`);
    const second = fly(day2, [byId('rush_bags_followup')], { flags: first.core.flags });
    expect(textsOf(second, 'rush_bags_followup')[0]).toContain(`${String(n)} RUSH BAGS RCTP-RJBB`);
    expect(second.core.flags).toEqual({});
  });
});

describe('the whole set', () => {
  const c = FLIGHTS[0] as Case;
  const set = all.filter((s) => s.def.trigger.on !== 'command');

  it('with their own probabilities: a few irregular events per flight, no errors', () => {
    let total = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const r = fly(c, set, { seed: String(seed) });
      expect(errors(r)).toEqual([]);
      total += ids(r).filter((id) => irregular.some((s) => s.id === id)).length;
    }
    // ~0.3–2 irregular messages a flight on average: rare, but not never.
    expect(total).toBeGreaterThan(3);
    expect(total).toBeLessThan(60);
  });

  it('same seed and flags → same messages', () => {
    const forced = set.map((s) => ({ ...s, probability: 1 }));
    const flags = {
      mel_item: '49-11-01 APU INOP',
      mel_reg: kg.aircraft.reg,
      mel_date: daysBefore(kg, 1),
    };
    const a = fly(c, forced, { flags, answer: 'CONTINUE' });
    const b = fly(c, forced, { flags, answer: 'CONTINUE' });
    expect(b.out).toEqual(a.out);
    expect(b.core.flags).toEqual(a.core.flags);
  });
});

describe('T46: hard landing, fuel against the plan, battery fire', () => {
  const c = FLIGHTS[0] as Case;
  const hard = (fpm: number | null): Case =>
    fpm === null ? c : { ...c, flight: withTouchdown(c.flight, fpm) };
  const check = (cc: Case, answer?: string) =>
    fly(cc, [byId('hard_landing_check')], answer === undefined ? {} : { answer });

  it('hard landing: only above 350 ft/min and only with the sim reading', () => {
    expect(ids(check(hard(null)))).toEqual([]);
    expect(ids(check(hard(350)))).toEqual([]);
    expect(ids(check(hard(351), 'NEGATIVE')).length).toBeGreaterThan(0);
    const text = textsOf(check(hard(480), 'CONFIRM'), 'hard_landing_check');
    expect(text[0]).toContain('480 FPM');
  });

  it('CONFIRM leaves an inspection for the next flight of the same aircraft, NEGATIVE nothing', () => {
    const set = ['hard_landing_check', 'hard_landing_followup'].map(byId);
    const first = fly(hard(450), set, { answer: 'CONFIRM' });
    expect(first.core.flags).toMatchObject({
      hardland_reg: kg.aircraft.reg,
      hardland_date: kg.times.schedOutMs,
    });
    const day2 = nextDay(kg);
    const next: Case = { name: 'next', ofp: day2, flight: generateSyntheticFlight({ ofp: day2 }) };
    const second = fly(next, set, { flags: first.core.flags });
    expect(ids(second)).toEqual(['hard_landing_followup']);
    expect(second.core.flags).toEqual({});
    // Another aircraft: the flag waits.
    const other = { ...nextDay(kg, 2), aircraft: { ...kg.aircraft, reg: 'JA01XJ' } };
    const elsewhere: Case = {
      name: 'other',
      ofp: other,
      flight: generateSyntheticFlight({ ofp: other }),
    };
    expect(ids(fly(elsewhere, set, { flags: first.core.flags }))).toEqual([]);
    expect(fly(hard(450), set, { answer: 'NEGATIVE' }).core.flags).toEqual({});
  });

  it('the hard landing flags live 3 days', () => {
    const flags = { hardland_reg: 'R', hardland_date: kg.times.schedOutMs - 4 * 86_400_000 };
    expect(AcarsCore.create({ ofp: kg, scenarios: [], seed: 's', flags }).flags).toEqual({});
  });

  it('fuel monitoring: silent on the plan, asks when well below it, once', () => {
    const fm = [byId('fuel_monitoring')];
    expect(ids(fly(c, fm))).toEqual([]);
    const low = shaped(c, { fuelDropKg: 6000 });
    const r = fly(low, fm, { answer: 'LEAK' });
    expect(ids(r)).toEqual(['fuel_monitoring', 'fuel_monitoring']);
    expect(textsOf(r, 'fuel_monitoring')[0]).toMatch(/FUEL BELOW PLAN FOB \d+ KG \d+ KG LESS/);
    expect(textsOf(r, 'fuel_monitoring')[1]).toContain('FUEL LEAK SUSPECTED');
    // A drop inside the tolerance (5 % of the plan, at least 500 kg): nothing.
    expect(ids(fly(shaped(c, { fuelDropKg: 300 }), fm))).toEqual([]);
  });

  it('an OFP without a fuel plan at the fixes: no message', () => {
    const bare: Ofp = { ...kg, navlog: kg.navlog.map((f) => ({ ...f, planFobKg: null })) };
    const flight = shaped({ name: 'bare', ofp: bare, flight: normal }, { fuelDropKg: 6000 });
    expect(ids(fly({ ...flight, ofp: bare }, [byId('fuel_monitoring')]))).toEqual([]);
  });

  it('battery fire: DIVERT sets the diversion, CONTINUE does not; the advice is the SAFO one', () => {
    const pf = [byId('ped_fire_cabin')];
    const d = fly(c, pf, { answer: 'DIVERT' });
    const first = textsOf(d, 'ped_fire_cabin')[0] as string;
    expect(first).toContain('USE WATER OR HALON');
    expect(first).toContain('NO BURN BAG');
    expect(textsOf(d, 'ped_fire_cabin')[1]).toContain('ROGER DIVERT');
    expect(
      d.events.some((e) => e.type === 'SET' && (e as { name?: string }).name === 'flight.divert'),
    ).toBe(true);
    const k = fly(c, pf, { answer: 'CONTINUE' });
    expect(textsOf(k, 'ped_fire_cabin')[1]).toContain('NOTED CONTINUE');
    expect(k.events.some((e) => e.type === 'SET')).toBe(false);
    // The default chance is 0.5 %, set in the file.
    expect(irregular.find((s) => s.id === 'ped_fire_cabin')?.probability).toBe(0.005);
  });
});
