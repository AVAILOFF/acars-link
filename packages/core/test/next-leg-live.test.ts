import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyExtData,
  buildFlightData,
  type ConnexData,
  type ConnexFlight,
  checkExtDataUpdate,
  EMPTY_EXT,
  ExtDataError,
  modelFamily,
  type NextLegOptions,
  type Ofp,
  parseSimbriefOfp,
  RoutePolyline,
  type RouteStatsData,
  routeCandidates,
} from '../src/index.js';

/**
 * T55: the next leg from the AeroDataBox data of the flight (levels 1 → 2 → 3, R1–R6), the model
 * table (R2) and the `routes` update field.
 */

const kg: Ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'ofp', 'rctp-rjbb-a35k-kgs.json'), 'utf8'),
  ),
);
const MIN = 60_000;
const sta = kg.times.schedInMs;
const seeds = Array.from({ length: 60 }, (_, i) => `seed-${i}`);

const dep = (number: string, min: number, o: Partial<ConnexFlight> = {}): ConnexFlight => ({
  number,
  dest: 'RJTT',
  std: sta + min * MIN,
  terminal: null,
  gate: null,
  codeshare: false,
  model: 'Airbus A350-900',
  ...o,
});
const connex = (...list: ConnexFlight[]): ConnexData => ({ icao: 'RJBB', list });
const routes = (...list: RouteStatsData['list']): RouteStatsData => ({ icao: 'RJBB', list });
const v3 = (live: NonNullable<NextLegOptions['live']>): NextLegOptions => ({
  version: 3,
  hub: null,
  live,
});
const leg = (o: NextLegOptions, seed = 's') => {
  const { ops } = buildFlightData(kg, seed, o);
  return { ...ops, text: `${ops.nextFlight} ${ops.nextOrig}-${ops.nextDest}` };
};

describe('modelFamily (R2): the strings of a live AeroDataBox answer', () => {
  it('maps every string seen at EDDF on 2026-10-21', () => {
    const table: Record<string, string | null> = {
      'ATR 72': 'ATR',
      'Airbus A220-100': null,
      'Airbus A220-300': null,
      'Airbus A319': 'A320',
      'Airbus A320': 'A320',
      'Airbus A320 (Sharklets)': 'A320',
      'Airbus A320 NEO': 'A320',
      'Airbus A321': 'A320',
      'Airbus A321 (Sharklets)': 'A320',
      'Airbus A321 (sharklets)': 'A320',
      'Airbus A321 NEO': 'A320',
      'Airbus A330': 'A330',
      'Airbus A350-900': 'A350',
      'Airbus A380': 'A380',
      'Boeing 737 MAX 8': 'B737',
      'Boeing 737-800': 'B737',
      'Boeing 747': 'B747',
      'Boeing 747-8': 'B747',
      'Boeing 777': 'B777',
      'Boeing 777-200': 'B777',
      'Boeing 777-300': 'B777',
      'Boeing 787-10': 'B787',
      'Boeing 787-8': 'B787',
      'Boeing 787-9': 'B787',
      'Embraer 190': 'E-JET',
      'Embraer 195': 'E-JET',
      'Regional-Jet': null,
    };
    for (const [model, family] of Object.entries(table))
      expect(modelFamily(model), model).toBe(family);
  });

  it('unknown text, spacing, nothing', () => {
    expect(modelFamily('  airbus   a320  ')).toBe('A320');
    expect(modelFamily('Airbus A321XLR')).toBeNull(); // not seen: no guess
    expect(modelFamily('')).toBeNull();
    expect(modelFamily(null)).toBeNull();
    expect(modelFamily(undefined)).toBeNull();
  });
});

describe('next leg, level 1 (R1, R3): a real departure of the same family', () => {
  const turn = buildFlightData(kg, 's', v3({})).ops.turnaroundMin;

  it('number of the airline + the digits, the place and the real STD; with the source', () => {
    const got = leg(v3({ connex: connex(dep('SJX862', turn + 20)) }));
    expect(got.text).toBe('SJX862 RJBB-RJTT');
    expect(got.nextStd).toBe(sta + (turn + 20) * MIN);
    expect(got.nextLive).toBe('fids');
  });

  it('never a codeshare, back to the origin, before the turnaround, another or unknown type', () => {
    const none = connex(
      dep('SJX1', turn + 20, { codeshare: true }),
      dep('SJX2', turn + 20, { dest: 'RCTP' }),
      dep('SJX3', turn - 5),
      dep('SJX4', turn + 20, { model: 'Boeing 787-9' }),
      dep('SJX5', turn + 20, { model: 'Regional-Jet' }),
      dep('SJX6', turn + 20, { model: null }),
      (({ model: _, ...f }) => f)(dep('SJX7', turn + 20)), // no model field (before T55)
      dep('SJX8', turn + 20, { std: null }), // purged (C9)
    );
    // Seed `s`: the turnaround of `turn`. Each of them alone, so none hides another (C6 pairs).
    for (const f of none.list) expect(leg(v3({ connex: connex(f) })).nextLive, f.number).toBeNull();
  });

  it('a seeded pick among the suitable ones; the same seed, the same leg', () => {
    const list = connex(dep('SJX10', turn + 10), dep('SJX20', turn + 60), dep('SJX30', turn + 120));
    const got = new Set(seeds.map((s) => leg(v3({ connex: list }), s).nextFlight));
    expect(got).toEqual(new Set(['SJX10', 'SJX20', 'SJX30']));
    expect(leg(v3({ connex: list }), 'x')).toEqual(leg(v3({ connex: list }), 'x'));
  });

  it('the rest of the ops data stays as in version 2', () => {
    const strip = ({ nextFlight, nextDest, nextStd, nextLive, ...rest }: ReturnType<typeof leg>) =>
      rest;
    const live = v3({ connex: connex(dep('SJX862', turn + 20)) });
    for (const seed of seeds.slice(0, 10)) {
      const a = leg({ version: 2, hub: null }, seed);
      const b = leg(live, seed);
      const { text: _a, ...ra } = a;
      const { text: _b, ...rb } = b;
      expect(strip({ ...rb, text: '' })).toEqual(strip({ ...ra, text: '' }));
    }
  });
});

describe('next leg, level 2 (R4): a route of the airline from the statistics', () => {
  const stats = routes(
    { dest: 'RJTT', daily: 9, operators: ['ANA', 'SJX'] },
    { dest: 'ROAH', daily: 1, operators: ['SJX'] },
    { dest: 'RCTP', daily: 20, operators: ['SJX'] }, // back to the origin
    { dest: 'RKSI', daily: 30, operators: ['KAL'] }, // another airline
    { dest: 'VHHH', daily: null, operators: ['SJX'] }, // purged (C9)
  );

  it('weighted by the daily average, a seeded number, the STD of STA + turnaround', () => {
    const count: Record<string, number> = {};
    for (const seed of Array.from({ length: 400 }, (_, i) => `w${i}`)) {
      const got = leg(v3({ routes: stats }), seed);
      expect(got.nextLive).toBe('routes');
      expect(got.nextFlight).toMatch(/^SJX\d{3}$/);
      expect(got.nextFlight).not.toBe('SJX822');
      expect(got.nextStd).toBe(leg({ version: 2, hub: null }, seed).nextStd);
      count[got.nextDest] = (count[got.nextDest] ?? 0) + 1;
    }
    expect(Object.keys(count).sort()).toEqual(['RJTT', 'ROAH']);
    // 9 : 1 → about 360 : 40.
    expect(count['RJTT']).toBeGreaterThan(320);
    expect(count['ROAH']).toBeGreaterThan(15);
  });

  it('only when level 1 has nothing', () => {
    const turn = buildFlightData(kg, 's', v3({})).ops.turnaroundMin;
    expect(leg(v3({ connex: connex(dep('SJX862', turn + 20)), routes: stats })).nextLive).toBe(
      'fids',
    );
    expect(leg(v3({ connex: connex(), routes: stats })).nextLive).toBe('routes');
  });

  it('candidates: own, not back, not purged, for this destination only', () => {
    expect(routeCandidates(stats, kg).map((r) => r.dest)).toEqual(['RJTT', 'ROAH']);
    expect(routeCandidates({ ...stats, icao: 'RJTT' }, kg)).toEqual([]);
    expect(routeCandidates(stats, { ...kg, airlineIcao: null })).toEqual([]);
    expect(routeCandidates(null, kg)).toEqual([]);
  });
});

describe('next leg, level 3 and older versions', () => {
  it('no data, or nothing usable: as version 2 (OpenFlights / back)', () => {
    const v2 = leg({ version: 2, hub: null });
    expect(v2.nextLive).toBeNull();
    for (const live of [{}, { connex: connex() }, { routes: routes() }, { connex: null }]) {
      expect(leg(v3(live))).toEqual(v2);
    }
  });

  it('versions 1 and 2 ignore the data', () => {
    const live = {
      connex: connex(dep('SJX862', 200)),
      routes: routes({ dest: 'RJTT', daily: 9, operators: ['SJX'] }),
    };
    for (const version of [1, 2] as const) {
      expect(leg({ version, hub: null, live })).toEqual(leg({ version, hub: null }));
    }
  });
});

describe('ExtDataUpdate.routes and connex.model (T55)', () => {
  const route = new RoutePolyline(kg);

  it('routes: checked, the destination only, replaces the list', () => {
    const r = routes({ dest: 'RJTT', daily: 6.5, operators: ['SJX'] });
    const u = checkExtDataUpdate({ t: 0, routes: r });
    expect(applyExtData(EMPTY_EXT, u, kg, route).routes).toEqual(r);
    const other = checkExtDataUpdate({ t: 0, routes: { icao: 'RJTT', list: [] } });
    expect(applyExtData(EMPTY_EXT, other, kg, route).routes).toBeUndefined();
    for (const bad of [
      { icao: 'RJBB' },
      { icao: 'RJBB', list: [{ dest: 'X', daily: 1, operators: [] }] },
      { icao: 'RJBB', list: [{ dest: 'RJTT', daily: -1, operators: [] }] },
      { icao: 'RJBB', list: [{ dest: 'RJTT', daily: 1, operators: ['sjx'] }] },
      { icao: 'RJBB', list: [{ dest: 'RJTT', daily: 1 }] },
    ]) {
      expect(() => checkExtDataUpdate({ t: 0, routes: bad })).toThrow(ExtDataError);
    }
    expect(() =>
      checkExtDataUpdate({ t: 0, routes: routes({ dest: 'RJTT', daily: null, operators: [] }) }),
    ).not.toThrow();
  });

  it('connex: a model is optional, printable, short', () => {
    const ok = (model: unknown) => () =>
      checkExtDataUpdate({ t: 0, connex: { icao: 'RJBB', list: [{ ...dep('SJX1', 60), model }] } });
    expect(ok('Airbus A320 NEO')).not.toThrow();
    expect(ok(null)).not.toThrow();
    expect(ok(undefined)).not.toThrow();
    expect(ok('x'.repeat(61))).toThrow(ExtDataError);
    expect(ok('A320\n')).toThrow(ExtDataError);
    expect(ok(320)).toThrow(ExtDataError);
  });
});
