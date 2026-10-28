// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyExtData,
  CONNEX_ATTRIBUTION,
  type ConnexData,
  type ConnexFlight,
  checkExtDataUpdate,
  connexCandidates,
  connexGate,
  EMPTY_EXT,
  ExtDataError,
  type Ofp,
  parseSimbriefOfp,
  pickConnection,
  RoutePolyline,
} from '../src/index.js';

/** T30 (docs/07 C6, C8–C10): selection of the onward departure among the AeroDataBox ones. */

const ofp: Ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'ofp', 'rctp-rjbb-a35k-kgs.json'), 'utf8'),
  ),
);
const sta = ofp.times.schedInMs;
const at = (min: number) => sta + min * 60_000;
const flight = (number: string, min: number, o: Partial<ConnexFlight> = {}): ConnexFlight => ({
  number,
  dest: 'RCTP',
  std: at(min),
  terminal: null,
  gate: null,
  codeshare: false,
  ...o,
});
const data = (...list: ConnexFlight[]): ConnexData => ({ icao: 'RJBB', list });

describe('connexCandidates', () => {
  it('keeps the window STA+30…STA+240 in time order, without the destination itself', () => {
    const got = connexCandidates(
      data(
        flight('SJX3', 200),
        flight('SJX1', 29),
        flight('SJX2', 30),
        flight('SJX4', 241),
        flight('SJX5', 90, { dest: 'RJBB' }),
      ),
      ofp,
    );
    expect(got.map((f) => f.number)).toEqual(['SJX2', 'SJX3']);
  });

  it('an operating flight wins over its codeshare twin (same time, same place)', () => {
    const got = connexCandidates(
      data(
        flight('SJX9862', 75, { codeshare: true }),
        flight('SJX862', 75),
        flight('SJX7001', 75, { dest: 'RCKH', codeshare: true }),
      ),
      ofp,
    );
    expect(got.map((f) => f.number)).toEqual(['SJX7001', 'SJX862']);
  });

  it('nothing for another airport, no data, or purged times (C9)', () => {
    expect(connexCandidates({ icao: 'RJTT', list: [flight('SJX1', 60)] }, ofp)).toEqual([]);
    expect(connexCandidates(null, ofp)).toEqual([]);
    expect(connexCandidates(data(flight('SJX1', 60, { std: null })), ofp)).toEqual([]);
  });
});

describe('pickConnection', () => {
  const list = data(flight('SJX1', 40), flight('SJX2', 100), flight('SJX3', 200));

  it('is a function of the data and the seed', () => {
    expect(pickConnection(list, ofp, 'a')).toEqual(pickConnection(list, ofp, 'a'));
  });

  it('chooses among the first 2 h of the window, else among all (C6)', () => {
    const picked = new Set(
      Array.from({ length: 60 }, (_, i) => pickConnection(list, ofp, `s${i}`)?.number),
    );
    expect(picked).toEqual(new Set(['SJX1', 'SJX2']));
    expect(pickConnection(data(flight('SJX3', 200)), ofp, 'x')?.number).toBe('SJX3');
    expect(pickConnection(data(), ofp, 'x')).toBeNull();
  });
});

describe('connexGate', () => {
  it('gate, else the terminal, else null', () => {
    expect(connexGate(flight('SJX1', 60, { gate: 'B12', terminal: '1' }))).toBe('B12');
    expect(connexGate(flight('SJX1', 60, { terminal: '2' }))).toBe('TERM 2');
    expect(connexGate(flight('SJX1', 60))).toBeNull();
  });
});

describe('ExtDataUpdate.connex', () => {
  it('is checked and replaces the list of the destination only', () => {
    const u = checkExtDataUpdate({ t: 0, connex: data(flight('SJX1', 60)) });
    const route = new RoutePolyline(ofp);
    expect(applyExtData(EMPTY_EXT, u, ofp, route).connex).toEqual(data(flight('SJX1', 60)));
    const other = checkExtDataUpdate({ t: 0, connex: { icao: 'RJTT', list: [] } });
    expect(applyExtData(EMPTY_EXT, other, ofp, route).connex).toBeUndefined();
  });

  it('rejects bad items', () => {
    for (const bad of [
      { icao: 'RJBB', list: [{ ...flight('SJX 1', 60) }] },
      { icao: 'RJBB', list: [{ ...flight('SJX1', 60), dest: 'X' }] },
      { icao: 'RJBB', list: [{ ...flight('SJX1', 60), gate: 'GATE 12' }] },
      { icao: 'RJBB', list: [{ ...flight('SJX1', 60), codeshare: 'no' }] },
      { icao: 'RJBB' },
    ]) {
      expect(() => checkExtDataUpdate({ t: 0, connex: bad })).toThrow(ExtDataError);
    }
  });

  it('the attribution line is the one of the terms (C4)', () => {
    expect(CONNEX_ATTRIBUTION).toBe('SRC AERODATABOX');
  });
});
