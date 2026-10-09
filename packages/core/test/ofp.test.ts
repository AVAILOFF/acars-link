import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OfpParseError, parseSimbriefOfp, parseSimbriefOfpText } from '../src/index.js';

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
