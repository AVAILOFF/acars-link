import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AcarsCore,
  aircraftInfo,
  compileScenario,
  createRng,
  generateSyntheticFlight,
  holdPosition,
  parseSimbriefOfp,
  type ScenarioDef,
  seatLetters,
} from '../src/index.js';

/** T40: aircraft family table and the `{seat}` / `{hold}` generators. */

describe('aircraftInfo', () => {
  it.each([
    ['A20N', 'A320', 'AIRBUS', 'NARROW', 'ECAM'],
    ['A321', 'A320', 'AIRBUS', 'NARROW', 'ECAM'],
    ['B38M', 'B737', 'BOEING', 'NARROW', null],
    ['B77W', 'B777', 'BOEING', 'WIDE', 'EICAS'],
    ['A359', 'A350', 'AIRBUS', 'WIDE', 'ECAM'],
    ['A35K', 'A350', 'AIRBUS', 'WIDE', 'ECAM'],
    ['A388', 'A380', 'AIRBUS', 'WIDE', 'ECAM'],
    ['B748', 'B747', 'BOEING', 'WIDE', 'EICAS'],
    ['B789', 'B787', 'BOEING', 'WIDE', 'EICAS'],
    ['A333', 'A330', 'AIRBUS', 'WIDE', 'ECAM'],
    ['E190', 'E-JET', 'EMBRAER', 'NARROW', 'EICAS'],
    ['CRJ9', 'CRJ', 'BOMBARDIER', 'NARROW', 'EICAS'],
    ['AT76', 'ATR', 'ATR', 'NARROW', null],
    ['DH8D', 'DH8', 'DE HAVILLAND', 'NARROW', null],
  ] as const)('%s → %s', (icao, family, maker, body, alertSys) => {
    expect(aircraftInfo(icao)).toEqual({ family, maker, body, alertSys });
  });

  it('is case- and space-insensitive; unknown or missing types give null', () => {
    expect(aircraftInfo(' a20n ')?.family).toBe('A320');
    for (const x of ['C172', 'ZZZZ', '', null, undefined]) expect(aircraftInfo(x)).toBeNull();
  });
});

describe('seat letters and hold positions', () => {
  it('letters by family and body', () => {
    expect(seatLetters('A320', 'NARROW')).toBe('ABCDEF');
    expect(seatLetters('B777', 'WIDE')).toBe('ABCDEFGHJK');
    for (const f of ['E-JET', 'CRJ', 'ATR', 'DH8']) expect(seatLetters(f, 'NARROW')).toBe('ACDF');
    expect(seatLetters(null, null)).toBe('ABCDEF');
  });

  it('hold: compartments only, ULD kind on wide-bodies, never a position number', () => {
    const rng = createRng('hold');
    const seen = (f: string | null, b: string | null) =>
      new Set(Array.from({ length: 200 }, () => holdPosition(f, b, rng)));
    expect([...seen('A320', 'NARROW')].sort()).toEqual(['AFT HOLD', 'BULK HOLD', 'FWD HOLD']);
    expect([...seen('B777', 'WIDE')].sort()).toEqual([
      'AFT HOLD LD3',
      'AFT HOLD PALLET',
      'BULK HOLD',
      'FWD HOLD LD3',
      'FWD HOLD PALLET',
    ]);
    expect([...seen('ATR', 'NARROW')].sort()).toEqual(['AFT HOLD', 'FWD HOLD']);
    expect([...seen(null, null)]).toEqual(['CARGO HOLD']);
  });
});

describe('in scenarios', () => {
  const ofp = parseSimbriefOfp(
    JSON.parse(
      readFileSync(join(import.meta.dirname, 'fixtures', 'ofp', 'rctp-rjbb-a35k-kgs.json'), 'utf8'),
    ),
  );
  const flight = generateSyntheticFlight({ ofp });
  const def: ScenarioDef = {
    id: 'ac',
    version: 1,
    category: 'ops',
    title: 'ac',
    enabled_by_default: true,
    trigger: { on: 'phase_enter', phase: 'CRUISE' },
    steps: [
      {
        send: {
          body: '{aircraft.family} {aircraft.maker} {aircraft.body} {aircraft.alert_sys} {seat} {hold}',
        },
      },
    ],
  };
  const run = (icao: string) => {
    const o = { ...ofp, aircraft: { ...ofp.aircraft, icao } };
    const core = AcarsCore.create({ ofp: o, scenarios: [compileScenario(def)], seed: 's' });
    core.startFlight();
    for (const s of flight.snapshots) {
      const r = core.tick({ now: s.t, telemetry: s });
      const m = r.outbound[0];
      if (m !== undefined) return m.message.text.replaceAll('\n', ' ');
    }
    throw new Error('nothing sent');
  };

  it('A35K: wide-body Airbus', () => {
    expect(run('A35K')).toMatch(
      /^A350 AIRBUS WIDE ECAM \d{1,2}[A-HJK] (FWD|AFT) HOLD (LD3|PALLET)$|^A350 AIRBUS WIDE ECAM \d{1,2}[A-HJK] BULK HOLD$/,
    );
  });

  it('unknown type: variables are empty and the generators use the general text', () => {
    expect(run('ZZZZ')).toMatch(/^---- ---- ---- ---- \d{1,2}[A-F] CARGO HOLD$/);
  });
});
