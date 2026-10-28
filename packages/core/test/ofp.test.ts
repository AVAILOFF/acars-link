// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  alignOfpDay,
  OfpParseError,
  parseSimbriefOfp,
  parseSimbriefOfpText,
} from '../src/index.js';

// Fixtures are produced by tools/anonymize-ofp.mjs from a real json=v2 OFP.
const FIXTURES = join(import.meta.dirname, 'fixtures', 'ofp');
const KGS = 'rctp-rjbb-a35k-kgs.json';
const LBS = 'rctp-rjbb-a35k-lbs-synthetic.json';

// biome-ignore lint/suspicious/noExplicitAny: tests mutate raw JSON freely
type RawOfp = any;
const load = (name: string): RawOfp => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));

describe('parseSimbriefOfp — real OFP planned in kg (A35K RCTP-RJBB)', () => {
  const ofp = parseSimbriefOfp(load(KGS));

  it('maps flight identity', () => {
    expect(ofp.callsign).toBe('SJX822');
    expect(ofp.airlineIcao).toBe('SJX');
    expect(ofp.flightNumber).toBe('822');
    expect(ofp.costIndex).toBe(109);
    expect(ofp.initialAltitudeFt).toBe(39000);
    expect(ofp.sid).toBe('MOLK1A');
    expect(ofp.star).toBe('NIXOVB');
    expect(ofp.source.plannedUnit).toBe('kg');
    expect(ofp.source.generatedAtMs).toBe(Date.UTC(2026, 9, 8, 7, 2, 44));
  });

  it('maps airports, runways, transition altitude and ATIS', () => {
    expect(ofp.origin).toMatchObject({
      icao: 'RCTP',
      iata: 'TPE',
      planRwy: '05R',
      transAltFt: 11000,
      transLevelFt: 13000,
      elevationFt: 108,
      utcOffsetH: 8,
    });
    expect(ofp.origin.atis[0]?.letter).toBe('B');
    expect(ofp.destination).toMatchObject({ icao: 'RJBB', planRwy: '06L', transAltFt: 14000 });
    expect(ofp.alternates.map((a) => a.icao)).toEqual(['RJGG']);
  });

  it('maps aircraft', () => {
    expect(ofp.aircraft).toEqual({
      icao: 'A35K',
      name: 'A350-1000',
      reg: 'G-KXWB',
      engines: 'TRENT XWB-97',
      wakeCategory: 'H',
      equip: 'SDE2E3GHIJ3J4J5LM1ORWXY',
      maxPax: 367,
    });
  });

  it('maps weights and fuel in kg', () => {
    expect(ofp.weights).toMatchObject({
      paxCount: 266,
      paxWeightKg: 79,
      cargoKg: 6650,
      payloadKg: 27664,
      estZfwKg: 182664,
      maxZfwKg: 223000,
      estTowKg: 204741,
      maxTowKg: 247944,
    });
    expect(ofp.fuel).toMatchObject({ planRampKg: 22677, planTakeoffKg: 22077, taxiKg: 600 });
  });

  it('maps times to epoch ms and durations to seconds', () => {
    expect(ofp.times.schedOutMs).toBe(Date.UTC(2026, 9, 8, 7, 45));
    expect(ofp.times.schedInMs).toBe(Date.UTC(2026, 9, 8, 10, 20));
    expect(ofp.times.estInMs).toBe(Date.UTC(2026, 9, 8, 10, 22, 23));
    expect(ofp.times.estTimeEnrouteSec).toBe(2 * 3600 + 4 * 60 + 23);
    expect(ofp.times.taxiOutSec).toBe(25 * 60);
    expect(ofp.times.schedBlockSec).toBe(2 * 3600 + 35 * 60);
  });

  it('maps the navlog with TOC/TOD and cumulative distance', () => {
    expect(ofp.navlog).toHaveLength(28);
    const toc = ofp.navlog.find((f) => f.ident === 'TOC');
    const tod = ofp.navlog.find((f) => f.ident === 'TOD');
    expect(toc).toMatchObject({ type: 'ltlg', stage: 'CLB', altitudeFt: 39000 });
    expect(tod).toMatchObject({ type: 'ltlg', stage: 'CRZ', altitudeFt: 39000 });
    expect(ofp.navlog.at(-1)?.ident).toBe('RJBB');
    expect(ofp.navlog.at(-1)?.cumDistNm).toBe(ofp.routeDistanceNm);
    expect(ofp.navlog[0]).toMatchObject({ viaAirway: 'MOLK1A', isSidStar: true, legDistNm: 4 });
  });

  it('maps per-leg magnetic track, MORA, FIR and SimBrief valid levels', () => {
    const molka = ofp.navlog.find((f) => f.ident === 'MOLKA');
    expect(molka).toMatchObject({ trackMag: 30, moraFt: 2000, fir: 'RCAA' });
    // M750: FL270 and up, odd levels (track 030).
    expect(molka?.validLevelsFt?.slice(0, 3)).toEqual([27000, 29000, 31000]);
    const bb650 = ofp.navlog.find((f) => f.ident === 'BB650');
    expect(bb650).toMatchObject({ trackMag: 343, fir: 'RJJJ' });
    expect(bb650?.validLevelsFt?.slice(0, 2)).toEqual([2000, 4000]);
  });

  it('is stable (snapshot)', () => {
    expect(ofp).toMatchSnapshot();
  });
});

describe('parseSimbriefOfp — synthetic variant planned in lbs', () => {
  const kg = parseSimbriefOfp(load(KGS));
  const lb = parseSimbriefOfp(load(LBS));

  const expectClose = (
    a: Readonly<Record<string, number | null>>,
    b: Readonly<Record<string, number | null>>,
    section: string,
  ) => {
    for (const key of Object.keys(a)) {
      const x = a[key] ?? null;
      const y = b[key] ?? null;
      if (x === null || y === null) expect(y, `${section}.${key}`).toBe(x);
      else expect(Math.abs(x - y), `${section}.${key}`).toBeLessThanOrEqual(1);
    }
  };

  it('converts every mass to kg (±1 kg rounding)', () => {
    expect(lb.source.plannedUnit).toBe('lb');
    expectClose({ ...kg.weights }, { ...lb.weights }, 'weights');
    expectClose({ ...kg.fuel }, { ...lb.fuel }, 'fuel');
  });

  it('keeps counts unconverted', () => {
    expect(lb.weights.paxCount).toBe(266);
    expect(lb.weights.bagCount).toBe(266);
  });

  it('treats empty airline / flight number as null', () => {
    expect(lb.airlineIcao).toBeNull();
    expect(lb.flightNumber).toBeNull();
    expect(lb.callsign).toBe('SJX822');
  });

  it('keeps several alternates in OFP order', () => {
    expect(lb.alternates.map((a) => a.icao)).toEqual(['RJGG', 'ZZZZ']);
    expect(lb.alternates[1]?.planRwy).toBeNull();
    expect(lb.alternates[1]?.atis).toEqual([]);
  });
});

describe('parseSimbriefOfp — format errors', () => {
  const cases: Array<[string, (o: RawOfp) => void, string, RegExp]> = [
    ['missing callsign', (o) => delete o.atc.callsign, 'atc.callsign', /missing/],
    ['empty callsign', (o) => (o.atc.callsign = ''), 'atc.callsign', /missing/],
    ['non-numeric weight', (o) => (o.weights.est_zfw = 'abc'), 'weights.est_zfw', /number/],
    ['number instead of string', (o) => (o.fuel.plan_ramp = 22677), 'fuel.plan_ramp', /string/],
    ['unknown unit', (o) => (o.params.units = 'stone'), 'params.units', /kgs.*lbs/],
    ['unix time (v2:1 style)', (o) => (o.times.sched_out = '1791445500'), 'times.sched_out', /UTC/],
    [
      'impossible date',
      (o) => (o.times.sched_out = '2026-02-30T07:45:00Z'),
      'times.sched_out',
      /invalid calendar/,
    ],
    [
      'bad duration',
      (o) => (o.times.est_time_enroute = '124'),
      'times.est_time_enroute',
      /HH:MM:SS/,
    ],
    [
      'arrival before departure',
      (o) => (o.times.sched_in = '2026-10-08T07:00:00Z'),
      'times.sched_in',
      /not after/,
    ],
    ['missing section', (o) => delete o.weights, 'weights', /object/],
    [
      'single alternate as object (v2:1 style)',
      (o) => (o.alternate = o.alternate[0]),
      'alternate',
      /array/,
    ],
    ['empty navlog', (o) => (o.navlog = []), 'navlog', /empty/],
    ['latitude out of range', (o) => (o.navlog[3].pos_lat = '95'), 'navlog[3].pos_lat', /range/],
    ['unknown stage', (o) => (o.navlog[2].stage = 'HOLD'), 'navlog[2].stage', /CLB, CRZ or DSC/],
    [
      'SimBrief error status',
      (o) => (o.fetch.status = 'Error: Unknown UserID'),
      'fetch.status',
      /Unknown UserID/,
    ],
  ];

  it.each(cases)('%s → OfpParseError at %s', (_name, mutate, path, message) => {
    const json = load(KGS);
    mutate(json);
    let error: unknown;
    try {
      parseSimbriefOfp(json);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(OfpParseError);
    const err = error as OfpParseError;
    expect(err.path).toBe(path);
    expect(err.message).toMatch(message);
    expect(err.message).toContain(`"${path}"`);
  });

  it('rejects non-object input', () => {
    expect(() => parseSimbriefOfp(null)).toThrow(OfpParseError);
    expect(() => parseSimbriefOfp([])).toThrow(/JSON object/);
  });

  it('rejects text that is not JSON (e.g. SimBrief XML error body)', () => {
    expect(() => parseSimbriefOfpText('<OFP><fetch><status>Error</status></fetch></OFP>')).toThrow(
      /not valid JSON/,
    );
  });

  it('parses valid response text', () => {
    const text = readFileSync(join(FIXTURES, KGS), 'utf8');
    expect(parseSimbriefOfpText(text).callsign).toBe('SJX822');
  });
});

describe('parseSimbriefOfp — TLR and crew (T43)', () => {
  const TLR = 'rctp-rjbb-a35k-kgs-tlr.json';

  it('takes flaps, thrust and V-speeds of the planned runway, VREF of the planned surface', () => {
    const ofp = parseSimbriefOfp(load(TLR));
    // 05L in the same TLR has FLEX 72: the planned 05R is picked.
    expect(ofp.takeoffPerf).toEqual({
      runway: '05R',
      flaps: '1',
      thrust: 'FLEX',
      flexTempC: 71,
      v1Kt: 139,
      vrKt: 139,
      v2Kt: 146,
    });
    expect(ofp.landingPerf).toEqual({ runway: '06L', flaps: 'FULL', vrefKt: 131 });
  });

  it('counts the crew: captain and FO, purser and flight attendants', () => {
    expect(parseSimbriefOfp(load(TLR)).crew).toEqual({ cockpit: 2, cabin: 16 });
  });

  it('is null without TLR / crew in the OFP', () => {
    const ofp = parseSimbriefOfp(load(KGS));
    expect(ofp.takeoffPerf).toBeNull();
    expect(ofp.landingPerf).toBeNull();
    expect(ofp.crew).toBeNull();
  });

  it('wet surface: VREF of distance_wet', () => {
    const json = load(TLR);
    json.tlr.landing.conditions.surface_condition = 'wet';
    json.tlr.landing.distance_wet.speeds_vref = '133';
    expect(parseSimbriefOfp(json).landingPerf?.vrefKt).toBe(133);
  });

  it('one runway given as an object, not a list', () => {
    const json = load(TLR);
    json.tlr.takeoff.runway = json.tlr.takeoff.runway.find(
      (r: { identifier: string }) => r.identifier === '05R',
    );
    expect(parseSimbriefOfp(json).takeoffPerf?.v2Kt).toBe(146);
  });

  it('planned runway not in the TLR, or a speed missing → null, the OFP still parses', () => {
    const other = load(TLR);
    other.tlr.takeoff.conditions.planned_runway = '10';
    expect(parseSimbriefOfp(other).takeoffPerf).toBeNull();
    const noSpeed = load(TLR);
    for (const r of noSpeed.tlr.takeoff.runway) r.speeds_v1 = '';
    noSpeed.tlr.landing.distance_dry.speeds_vref = 'N/A';
    const ofp = parseSimbriefOfp(noSpeed);
    expect(ofp.takeoffPerf).toBeNull();
    expect(ofp.landingPerf).toBeNull();
  });
});

describe('parseSimbriefOfp — ETOPS (T50)', () => {
  // A real ETOPS OFP (RJTT–KLAX A35K, rule 370, generated 2026-10-15), anonymized with
  // tools/anonymize-ofp.mjs --with-etops.
  const ofp = parseSimbriefOfp(load('rjtt-klax-a35k-etops.json'));

  it('takes the rule, the entry and exit airports and the suitable airports in OFP order', () => {
    expect(ofp.etops?.ruleMin).toBe(370);
    expect(ofp.etops?.entry).toMatchObject({ icao: 'RJSS' });
    expect(ofp.etops?.exit).toMatchObject({ icao: 'KRDD' });
    expect(ofp.etops?.suitable.map((a) => a.icao)).toEqual(['RJCM', 'PACD', 'KRDD']);
    expect(ofp.etops?.suitable[1]).toEqual({
      icao: 'PACD',
      name: 'COLD BAY',
      lat: 55.205917,
      lon: -162.72625,
    });
    // The entry point gives the airport's position, not the fix's.
    expect(ofp.etops?.entry?.lat).toBeCloseTo(38.142272, 5);
  });

  it('is null when the flight is not planned ETOPS (`etops: []`) or the key is missing', () => {
    expect(parseSimbriefOfp(load(KGS)).etops).toBeNull();
    const raw = load(KGS);
    delete raw.etops;
    expect(parseSimbriefOfp(raw).etops).toBeNull();
  });

  it('one suitable airport given as an object, not a list', () => {
    const raw = load('rjtt-klax-a35k-etops.json');
    raw.etops.suitable_airport = raw.etops.suitable_airport[0];
    expect(parseSimbriefOfp(raw).etops?.suitable.map((a) => a.icao)).toEqual(['RJCM']);
  });
});

describe('alignOfpDay (docs/05 "Дата OFP")', () => {
  const ofp = parseSimbriefOfp(load(KGS));
  const DAY = 86_400_000;
  const STD = ofp.times.schedOutMs;

  it('within 12 h of STD: the OFP as it is', () => {
    expect(alignOfpDay(ofp, STD - 11 * 3_600_000)).toEqual({ ofp, days: 0 });
    expect(alignOfpDay(ofp, STD + 11 * 3_600_000).days).toBe(0);
  });

  it('planned for tomorrow: every absolute time moves back a day, durations stay', () => {
    const { ofp: a, days } = alignOfpDay(ofp, STD - DAY - 30 * 60_000);
    expect(days).toBe(-1);
    const t = ofp.times;
    expect(a.times).toEqual({
      ...t,
      schedOutMs: t.schedOutMs - DAY,
      schedOffMs: t.schedOffMs === null ? null : t.schedOffMs - DAY,
      schedOnMs: t.schedOnMs === null ? null : t.schedOnMs - DAY,
      schedInMs: t.schedInMs - DAY,
      estOutMs: t.estOutMs - DAY,
      estOffMs: t.estOffMs === null ? null : t.estOffMs - DAY,
      estOnMs: t.estOnMs === null ? null : t.estOnMs - DAY,
      estInMs: t.estInMs - DAY,
    });
    expect({ ...a, times: t }).toEqual(ofp);
  });

  it('a week old plan, STD just after midnight: the nearest day', () => {
    expect(alignOfpDay(ofp, STD + 7 * DAY - 40 * 60_000).days).toBe(7);
    expect(alignOfpDay(ofp, STD + 7 * DAY + 40 * 60_000).days).toBe(7);
  });
});
