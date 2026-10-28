// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  airportPlace,
  DIVERT_RESERVE_NM,
  type DivertAirport,
  distanceNm,
  ofpCandidates,
  parseSimbriefOfp,
  pickDivert,
  RUNWAY_NEEDS,
  type RunwayNeed,
  runwayNeedFor,
  suitableReserve,
} from '../src/index.js';

/** T50 part B: where a diverting aircraft is sent — the OFP's airports, a reserve when far. */

const ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'ofp', 'rctp-rjbb-a35k-kgs.json'), 'utf8'),
  ),
);
const NEED = { A350: { lengthM: 2500, widthM: 45 } } satisfies Record<string, RunwayNeed>;

/** An airport `nm` north of the point. */
const north = (p: { lat: number; lon: number }, nm: number) => ({
  lat: p.lat + nm / 60,
  lon: p.lon,
});
const apt = (icao: string, at: { lat: number; lon: number }, o: Partial<DivertAirport> = {}) =>
  ({ icao, ...at, rwyM: 3000, widthM: 60, large: true, ...o }) satisfies DivertAirport;

describe('candidates', () => {
  it('the origin and the alternates, never the destination or a repeat', () => {
    const icaos = ofpCandidates(ofp).map((a) => a.icao);
    expect(icaos).toEqual(['RCTP', 'RJGG']);
    const withDest = {
      ...ofp,
      alternates: [...ofp.alternates, ofp.destination, ofp.origin],
    };
    expect(ofpCandidates(withDest).map((a) => a.icao)).toEqual(['RCTP', 'RJGG']);
  });

  it('the table of needs: checked families only, by type designator', () => {
    expect(Object.keys(RUNWAY_NEEDS).sort()).toEqual(
      ['A320', 'A330', 'A350', 'A380', 'B737', 'B747', 'B777', 'B787'].sort(),
    );
    expect(runwayNeedFor('A35K')).toEqual({ lengthM: 2150, widthM: 45 });
    expect(runwayNeedFor('A21N')).toEqual({ lengthM: 1750, widthM: 30 });
    expect(runwayNeedFor('A388')).toMatchObject({ widthM: 45, large: true });
    // Regional families were not checked: no reserve for them.
    expect(runwayNeedFor('E190')).toBeUndefined();
    expect(runwayNeedFor('ZZZZ')).toBeUndefined();
  });

  it('an A380 is not sent to a short, narrow or medium airport', () => {
    const need = runwayNeedFor('A388');
    const here = { lat: 25, lon: 150 };
    const list = [
      apt('SHRT', north(here, 10), { rwyM: 1900, widthM: 60 }),
      apt('NARO', north(here, 20), { rwyM: 3500, widthM: 30 }),
      apt('MEDM', north(here, 30), { rwyM: 3500, widthM: 60, large: false }),
      apt('GOOD', north(here, 40), { rwyM: 3500, widthM: 60 }),
    ];
    expect(suitableReserve(list, need, new Set()).map((a) => a.icao)).toEqual(['GOOD']);
  });
});

describe('ETOPS airports of the OFP (T50)', () => {
  const etops = parseSimbriefOfp(
    JSON.parse(
      readFileSync(
        join(import.meta.dirname, 'fixtures', 'ofp', 'rjtt-klax-a35k-etops.json'),
        'utf8',
      ),
    ),
  );

  it('join the candidates after the origin and the alternates, the destination never', () => {
    expect(ofpCandidates(etops).map((a) => a.icao)).toEqual([
      'RJTT',
      'KONT',
      'RJSS',
      'RJCM',
      'PACD',
      'KRDD',
    ]);
  });

  it('over the Pacific the nearest is an ETOPS airport, not the origin', () => {
    // The first equal time point of the OFP: RJCM 1188 NM, PACD 1236 NM by the plan.
    const etp = { lat: 43.056287622048, lon: 171.52241904248 };
    const got = pickDivert({
      pos: etp,
      ofp: etops,
      reserve: undefined,
      family: 'A350',
      mode: 'ofp',
    });
    expect(got?.icao).toBe('RJCM');
    // Without the ETOPS plan the same position diverts to the origin.
    const plain = { ...etops, etops: null };
    expect(
      pickDivert({ pos: etp, ofp: plain, reserve: undefined, family: 'A350', mode: 'ofp' })?.icao,
    ).toBe('RJTT');
  });

  it('an ETOPS airport is a known airport for DIVERT <ICAO> (T51)', () => {
    expect(airportPlace(etops, undefined, 'PACD')).toMatchObject({ icao: 'PACD', lat: 55.205917 });
    expect(airportPlace({ ...etops, etops: null }, undefined, 'PACD')).toBeNull();
  });

  it('a recording made before T50 (no `etops`) still works', () => {
    const { etops: _drop, ...old } = etops;
    expect(ofpCandidates(old as typeof etops).map((a) => a.icao)).toEqual(['RJTT', 'KONT']);
  });
});

describe('reserve airports', () => {
  const here = { lat: 25, lon: 150 };
  const list = [
    apt('AAAA', north(here, 100)),
    apt('SHRT', north(here, 10), { rwyM: 2000 }),
    apt('NARO', north(here, 20), { widthM: 30 }),
    apt('MEDM', north(here, 30), { large: false }),
    apt('NOWD', north(here, 40), { widthM: null }),
    apt('RJGG', north(here, 5)),
    apt('RJBB', north(here, 6)),
  ];

  it('long and wide enough, not an OFP airport; no width counts as wide enough', () => {
    const ok = suitableReserve(list, NEED.A350, new Set(['RJGG', 'RJBB'])).map((a) => a.icao);
    expect(ok).toEqual(['AAAA', 'MEDM', 'NOWD']);
    expect(
      suitableReserve(list, { ...(NEED.A350 as RunwayNeed), large: true }, new Set()).map(
        (a) => a.icao,
      ),
    ).not.toContain('MEDM');
  });

  it('a type without a need gets none', () => {
    expect(suitableReserve(list, undefined, new Set())).toEqual([]);
  });
});

describe('pickDivert', () => {
  const origin = ofp.origin;
  const reserveAt = (p: { lat: number; lon: number }, nm: number) => [apt('RSRV', north(p, nm))];
  const pick = (
    pos: { lat: number; lon: number },
    mode: 'ofp' | 'any',
    reserve: readonly DivertAirport[] | undefined,
    needs: Readonly<Record<string, RunwayNeed>> = NEED,
    family: 'A350' | null = 'A350',
  ) => pickDivert({ pos, ofp, reserve, family, mode, needs });

  it('OFP airports only: the nearest of them, as before T50', () => {
    const pos = north(origin, 40);
    expect(pick(pos, 'ofp', undefined)).toMatchObject({ icao: 'RCTP', nm: 40 });
    expect(pick(pos, 'any', [])).toMatchObject({ icao: 'RCTP' });
  });

  it('near an OFP airport the OFP wins (ofp), the closer reserve wins (any)', () => {
    const pos = north(origin, 100);
    const r = reserveAt(pos, 20);
    expect(pick(pos, 'ofp', r)?.icao).toBe('RCTP');
    expect(pick(pos, 'any', r)).toMatchObject({ icao: 'RSRV', nm: 20 });
    // The OFP airport nearer than the reserve: both rules take it.
    expect(pick(pos, 'any', reserveAt(pos, 150))?.icao).toBe('RCTP');
  });

  it('far from the OFP airports the closer reserve wins in both rules', () => {
    const pos = { lat: 20, lon: 160 };
    const far = Math.min(...ofpCandidates(ofp).map((a) => distanceNm(pos, a)));
    expect(far).toBeGreaterThan(DIVERT_RESERVE_NM);
    const r = reserveAt(pos, 60);
    for (const mode of ['ofp', 'any'] as const) {
      expect(pick(pos, mode, r)).toMatchObject({ icao: 'RSRV', nm: 60 });
    }
    // A reserve farther than the OFP airport is no use.
    const farther = reserveAt(pos, Math.round(far) + 300);
    expect(pick(pos, 'ofp', farther)?.icao).not.toBe('RSRV');
  });

  it('no need for the type, an unknown type, or no reserve: the OFP airports', () => {
    const pos = { lat: 20, lon: 160 };
    const r = reserveAt(pos, 60);
    expect(pick(pos, 'any', r, {})?.icao).not.toBe('RSRV');
    expect(pick(pos, 'any', r, NEED, null)?.icao).not.toBe('RSRV');
  });

  it('the destination is never a candidate, not even as a reserve airport', () => {
    const dest = ofp.destination;
    const pos = north(dest, 30);
    const r = [apt(dest.icao, north(dest, 1))];
    expect(pick(pos, 'any', r)?.icao).not.toBe(dest.icao);
  });

  it('is deterministic and rounds the distance', () => {
    const pos = { lat: 20.123, lon: 160.456 };
    const a = pick(pos, 'any', reserveAt(pos, 77));
    expect(a).toEqual(pick(pos, 'any', reserveAt(pos, 77)));
    expect(Number.isInteger(a?.nm)).toBe(true);
  });
});

describe('airportPlace', () => {
  it('the OFP airports, then the reserve ones, else null', () => {
    const r = [apt('RSRV', { lat: 1, lon: 2 })];
    expect(airportPlace(ofp, r, 'RJGG')).toMatchObject({ icao: 'RJGG' });
    expect(airportPlace(ofp, r, 'RJBB')).toMatchObject({ icao: 'RJBB' });
    expect(airportPlace(ofp, r, 'RSRV')).toMatchObject({ lat: 1, lon: 2 });
    expect(airportPlace(ofp, r, 'EGLL')).toBeNull();
    expect(airportPlace(ofp, undefined, 'RSRV')).toBeNull();
  });
});
