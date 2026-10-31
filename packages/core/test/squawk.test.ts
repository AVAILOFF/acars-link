// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { describe, expect, it } from 'vitest';
import {
  assignable,
  assignSquawk,
  createRng,
  SPECIAL_CODES,
  type SquawkFlight,
  squawkPlan,
} from '../src/index.js';

/**
 * T24: transponder codes from the regional tables. "Real" = the squawk of a real departure
 * clearance decoded from ACARS (plane-watch/acars-parser test samples, airframes.io
 * acars-message-documentation A3, dates in the names); FIRs as VATSpy.dat v2610.1 names them.
 */

const flight = (
  f: Partial<SquawkFlight> & Pick<SquawkFlight, 'origin' | 'destination'>,
): SquawkFlight => ({
  originFir: null,
  destinationFir: null,
  routeFirs: [],
  originCountry: null,
  destinationCountry: null,
  ...f,
});

describe('special codes', () => {
  it('never assigns emergency, conspicuity and reserved codes, nor xx00', () => {
    for (const c of [
      '7500',
      '7600',
      '7700',
      '2000',
      '7000',
      '1000',
      '1200',
      '0000',
      '7400',
      '7777',
      '7501',
      '7607',
      '7707',
    ]) {
      expect(SPECIAL_CODES.has(c), c).toBe(true);
      expect(assignable(c), c).toBe(false);
    }
    expect(assignable('2300')).toBe(false); // non-discrete
    expect(assignable('8123')).toBe(false); // not octal
    expect(assignable('0437')).toBe(true);
  });

  it('no plan ever contains one (random region included)', () => {
    const plans = [
      squawkPlan(flight({ origin: 'SBGR', destination: 'SEQM' })),
      squawkPlan(
        flight({ origin: 'KMSP', destination: 'KRDU', originFir: 'KZMP', destinationFir: 'KZDC' }),
      ),
      squawkPlan(flight({ origin: 'EGLL', destination: 'OTHH', originFir: 'EGTT' })),
    ];
    for (const p of plans) for (const c of p.codes) expect(assignable(c), c).toBe(true);
    expect(plans[0]?.source).toBe('random');
    // 4096 codes − 64 ending in 00 − 87 special + 9 special ones that end in 00.
    expect(SPECIAL_CODES.size).toBe(87);
    expect(plans[0]?.codes).toHaveLength(3954);
  });
});

describe('EUR: EUROCONTROL CAL v4.13', () => {
  it.each([
    // [origin, destination, origin FIR, real squawk, sample]
    ['EFHK', 'ESSA', 'EFIN', '0437', 'FIN5LA 2025-12-29'],
    ['EGLL', 'OTHH', 'EGTT', '3403', 'QTR58U 2025-12-29'],
    ['EGLL', 'RKSI', 'EGTT', '4622', 'KAL908 2025-12-29'],
    ['EDDF', 'KATL', 'EDGG', '0122', 'DLA15 2023-02-01'],
    ['LSZH', 'EFIV', 'LSAS', '3016', 'EDW308L 2025-12-30'],
  ])('%s → %s: the real code %s is allowed (%s)', (origin, destination, originFir, code) => {
    const p = squawkPlan(flight({ origin, destination, originFir }));
    expect(p.source).toBe('eur-cal');
    expect(p.codes).toContain(code);
  });

  it('protection and via: codes protected in the destination or a route FIR are left out', () => {
    // CAL: 0401–0477 assigned by LE for ALL destinations, protection LF.
    const lisbon = squawkPlan(flight({ origin: 'LEMD', destination: 'LPPT', originFir: 'LECM' }));
    const paris = squawkPlan(flight({ origin: 'LEMD', destination: 'LFPG', originFir: 'LECM' }));
    const london = squawkPlan(
      flight({
        origin: 'LEMD',
        destination: 'EGLL',
        originFir: 'LECM',
        routeFirs: ['LECM', 'LFBB', 'LFFF', 'EGTT'],
      }),
    );
    expect(lisbon.codes).toContain('0401');
    expect(paris.codes).not.toContain('0401');
    expect(london.codes).not.toContain('0401');
    // 1330–1377: assigned by ED, via EG/EH/LF/EB/EDYY — only when the route goes there.
    const viaNone = squawkPlan(
      flight({ origin: 'EDDF', destination: 'KJFK', originFir: 'EDGG', routeFirs: ['EDGG'] }),
    );
    const viaEh = squawkPlan(
      flight({
        origin: 'EDDF',
        destination: 'KJFK',
        originFir: 'EDGG',
        routeFirs: ['EDGG', 'EHAA'],
      }),
    );
    expect(viaNone.codes).not.toContain('1330');
    expect(viaEh.codes).toContain('1330');
  });
});

describe('US: FAA NBCAP (JO 7110.66H)', () => {
  it.each([
    ['KMSP', 'KRDU', 'KZMP', 'KZDC', '3631', 'DAL2699 2025-12-29'],
    ['KPHL', 'KDTW', 'KZNY', 'KZOB', '2747', 'DAL1540 2025-12-30'],
    ['KPHL', 'CYUL', 'KZNY', 'CZUL', '1772', 'PDT5898'],
  ])(
    '%s → %s: the real code %s is in the external primary blocks (%s)',
    (origin, destination, originFir, destinationFir, code) => {
      const p = squawkPlan(flight({ origin, destination, originFir, destinationFir }));
      expect(p.source).toBe('faa-nbcap');
      expect(p.rule).toMatch(/external primary$/);
      expect(p.codes).toContain(code);
    },
  );

  it('internal blocks when the destination is in the same ARTCC; ZAN without P/S/T', () => {
    const p = squawkPlan(
      flight({ origin: 'KMSP', destination: 'KDLH', originFir: 'KZMP', destinationFir: 'KZMP' }),
    );
    expect(p.rule).toBe('ZMP internal primary');
    expect(p.codes.every((c) => c.startsWith('42') || c.startsWith('45'))).toBe(true);
    const ak = squawkPlan(
      flight({ origin: 'PANC', destination: 'KSEA', originFir: 'PAZA', destinationFir: 'KZSE' }),
    );
    expect(ak.rule).toBe('ZAN external');
    expect(ak.codes).toContain('3401');
  });
});

describe('Asia/Pacific: ICAO APAC eANP Table ATM II-APAC-2', () => {
  it.each([
    ['WSSS', 'WIII', 'WSJC', '2214', 'SIA964 2023-02-01'],
    ['VHHH', 'WMKK', 'VHHK', '5132', 'CPA729 2023-02-01'],
    ['VTBS', 'RPLL', 'VTBB', '0747', 'KLM803 2023-02-01'],
    ['RKSI', 'KSFO', 'RKDA', '7135', 'UAL892 2023-02-01'],
  ])(
    '%s → %s: the real code %s is in the international blocks (%s)',
    (origin, destination, originFir, code) => {
      const p = squawkPlan(
        flight({ origin, destination, originFir, originCountry: 'X', destinationCountry: 'Y' }),
      );
      expect(p.source).toBe('icao-apac');
      expect(p.rule).toMatch(/international$/);
      expect(p.codes).toContain(code);
    },
  );

  it('domestic blocks within a country; restricted blocks (notes 11–16) are not used', () => {
    const tw = squawkPlan(
      flight({
        origin: 'RCTP',
        destination: 'RCKH',
        originFir: 'RCAA',
        originCountry: 'Taiwan',
        destinationCountry: 'Taiwan',
      }),
    );
    expect(tw.rule).toBe('TAIBEI domestic');
    expect(tw.codes).toContain('0301');
    expect(tw.codes).not.toContain('2601'); // TAIBEI 2600 is international
    // Hong Kong 5700 is I(16): not for flights to or over the Fukuoka FIR — never used.
    const hk = squawkPlan(
      flight({
        origin: 'VHHH',
        destination: 'RJAA',
        originFir: 'VHHK',
        originCountry: 'HK',
        destinationCountry: 'JP',
      }),
    );
    expect(hk.codes).not.toContain('5701');
    expect(hk.codes).toContain('5101');
  });

  it('Australia domestic: any code except the international blocks of the FIR', () => {
    const p = squawkPlan(
      flight({
        origin: 'YSSY',
        destination: 'YMML',
        originFir: 'YGUN',
        originCountry: 'Australia',
        destinationCountry: 'Australia',
      }),
    );
    expect(p.rule).toBe('MELBOURNE domestic');
    expect(p.codes).not.toContain('1301'); // MELBOURNE 1300 is international
    expect(p.codes).toContain('2101');
  });

  it('Yangon international has only xx00 codes: falls back to a random code', () => {
    const p = squawkPlan(
      flight({
        origin: 'VYYY',
        destination: 'VTBS',
        originFir: 'VYYF',
        originCountry: 'Myanmar',
        destinationCountry: 'Thailand',
      }),
    );
    expect(p.source).toBe('random');
  });
});

describe('assignSquawk', () => {
  it('is deterministic for a seed and stays inside the plan', () => {
    const f = flight({ origin: 'EGLL', destination: 'OTHH', originFir: 'EGTT' });
    const a = assignSquawk(f, createRng('x'));
    expect(assignSquawk(f, createRng('x'))).toEqual(a);
    expect(squawkPlan(f).codes).toContain(a.code);
    expect(a.source).toBe('eur-cal');
  });
});

describe('public tables (T72): the US table only, random elsewhere', () => {
  const eu = flight({ origin: 'EGLL', destination: 'OTHH', originFir: 'EGTT' });
  const apac = flight({
    origin: 'VHHH',
    destination: 'WMKK',
    originFir: 'VHHK',
    originCountry: 'X',
    destinationCountry: 'Y',
  });
  const us = flight({
    origin: 'KMSP',
    destination: 'KRDU',
    originFir: 'KZMP',
    destinationFir: 'KZDC',
  });

  it('EUR and APAC departures get the random plan, not the tables', () => {
    for (const f of [eu, apac]) {
      expect(squawkPlan(f, 'full').source).not.toBe('random');
      const p = squawkPlan(f, 'public');
      expect(p.source).toBe('random');
      expect(p.rule).toBe('no table');
    }
  });

  it('the US keeps FAA NBCAP', () => {
    expect(squawkPlan(us, 'public')).toEqual(squawkPlan(us, 'full'));
    expect(squawkPlan(us, 'public').source).toBe('faa-nbcap');
  });

  it('assigned codes are discrete octal, never special and never xx00', () => {
    for (const f of [eu, apac]) {
      for (let i = 0; i < 200; i++) {
        const a = assignSquawk(f, createRng(`seed-${i}`), 'public');
        expect(a.source).toBe('random');
        expect(assignable(a.code), a.code).toBe(true);
        expect(SPECIAL_CODES.has(a.code), a.code).toBe(false);
        expect(a.code.endsWith('00'), a.code).toBe(false);
      }
    }
  });

  it('is deterministic for a seed', () => {
    expect(assignSquawk(eu, createRng('x'), 'public')).toEqual(
      assignSquawk(eu, createRng('x'), 'public'),
    );
  });
});
