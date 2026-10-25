import type { Rng } from '../random/rng.js';

/**
 * Aircraft type tables for scenarios (T40): `aircraft.family|maker|body|alert_sys` from the
 * ICAO type designator of the OFP, and the `{seat}` / `{hold}` generators that depend on them.
 *
 * Sources and checks (docs/07 T40, 2026-10-14):
 * - The designator → family table is NOT checked against ICAO Doc 8643 (no machine-readable
 *   export was available); the codes are written from the designators' usual meaning and are
 *   `[ПРОВЕРИТЬ]` on real OFPs. An unknown designator gives `null` everywhere.
 * - Hold names (`FWD`, `AFT`, `BULK`) and the ULD kinds (`LD3`, `PALLET`) of the wide-bodies are
 *   from the manufacturers' airport-planning documents (Airbus AC A320 Rev. 44, A330 Rev. 32;
 *   Boeing 737NG D6-58325-7 Rev C). Those documents carry no ULD position codes, so none are
 *   generated. Other families (777, 787, 350, 380, 747, regionals) are assumed to match.
 * - Seat letters are an approved assumption: the layout depends on the airline.
 * - B757 (T60, approved by the user 2026-10-25): narrow 3-3 and EICAS are common knowledge, no
 *   dated primary source for EICAS `[ПРОВЕРИТЬ]`. Holds: FAA AD 2024-13014 names only the
 *   "forward and aft lower lobe cargo compartments" (the 757 airport-planning document was not
 *   read), so no bulk hold.
 */

export const AIRCRAFT_FAMILIES = [
  'A320',
  'A330',
  'A350',
  'A380',
  'B737',
  'B747',
  'B757',
  'B777',
  'B787',
  'E-JET',
  'CRJ',
  'ATR',
  'DH8',
] as const;
export type AircraftFamily = (typeof AIRCRAFT_FAMILIES)[number];

export interface AircraftInfo {
  readonly family: AircraftFamily;
  readonly maker: string;
  readonly body: 'NARROW' | 'WIDE';
  /** `null`: no central alerting system of ECAM / EICAS kind (turboprops, 737: annunciator panel). */
  readonly alertSys: 'ECAM' | 'EICAS' | null;
}

const FAMILY_INFO: Readonly<Record<AircraftFamily, Omit<AircraftInfo, 'family'>>> = {
  A320: { maker: 'AIRBUS', body: 'NARROW', alertSys: 'ECAM' },
  A330: { maker: 'AIRBUS', body: 'WIDE', alertSys: 'ECAM' },
  A350: { maker: 'AIRBUS', body: 'WIDE', alertSys: 'ECAM' },
  A380: { maker: 'AIRBUS', body: 'WIDE', alertSys: 'ECAM' },
  B737: { maker: 'BOEING', body: 'NARROW', alertSys: null },
  B747: { maker: 'BOEING', body: 'WIDE', alertSys: 'EICAS' },
  B757: { maker: 'BOEING', body: 'NARROW', alertSys: 'EICAS' },
  B777: { maker: 'BOEING', body: 'WIDE', alertSys: 'EICAS' },
  B787: { maker: 'BOEING', body: 'WIDE', alertSys: 'EICAS' },
  'E-JET': { maker: 'EMBRAER', body: 'NARROW', alertSys: 'EICAS' },
  CRJ: { maker: 'BOMBARDIER', body: 'NARROW', alertSys: 'EICAS' },
  ATR: { maker: 'ATR', body: 'NARROW', alertSys: null },
  DH8: { maker: 'DE HAVILLAND', body: 'NARROW', alertSys: null },
};

const CODES: Readonly<Record<AircraftFamily, string>> = {
  A320: 'A318 A319 A320 A321 A19N A20N A21N',
  A330: 'A332 A333 A338 A339',
  A350: 'A359 A35K',
  A380: 'A388',
  B737: 'B731 B732 B733 B734 B735 B736 B737 B738 B739 B37M B38M B39M B3XM',
  B747: 'B741 B742 B743 B744 B748 B74D B74R B74S',
  B757: 'B752 B753',
  B777: 'B772 B773 B77L B77W B778 B779',
  B787: 'B788 B789 B78X',
  'E-JET': 'E170 E75S E75L E190 E195 E290 E295',
  CRJ: 'CRJ1 CRJ2 CRJ7 CRJ9 CRJX',
  ATR: 'AT43 AT44 AT45 AT46 AT72 AT73 AT75 AT76',
  DH8: 'DH8A DH8B DH8C DH8D',
};

const BY_CODE: ReadonlyMap<string, AircraftFamily> = new Map(
  AIRCRAFT_FAMILIES.flatMap((f) => CODES[f].split(' ').map((c) => [c, f] as const)),
);

/** Family data for an ICAO type designator; null when the type is not in the table. */
export function aircraftInfo(icao: string | null | undefined): AircraftInfo | null {
  if (typeof icao !== 'string') return null;
  const family = BY_CODE.get(icao.trim().toUpperCase());
  return family === undefined ? null : { family, ...FAMILY_INFO[family] };
}

/** The `aircraft.*` context variables of T40 (null for an unknown type). */
export function aircraftVariables(icao: string | null | undefined): {
  readonly 'aircraft.family': string | null;
  readonly 'aircraft.maker': string | null;
  readonly 'aircraft.body': string | null;
  readonly 'aircraft.alert_sys': string | null;
} {
  const a = aircraftInfo(icao);
  return {
    'aircraft.family': a?.family ?? null,
    'aircraft.maker': a?.maker ?? null,
    'aircraft.body': a?.body ?? null,
    'aircraft.alert_sys': a?.alertSys ?? null,
  };
}

const REGIONAL: ReadonlySet<AircraftFamily> = new Set(['E-JET', 'CRJ', 'ATR', 'DH8']);

/** Families with forward and aft holds only: the regionals and the 757 (T60). */
const NO_BULK_HOLD: ReadonlySet<AircraftFamily> = new Set([...REGIONAL, 'B757']);

/** Seat letters: regional 2-2 `ACDF`, narrow `A–F`, wide `A–K` without I; unknown type `A–F`. */
export function seatLetters(family: string | null, body: string | null): string {
  if (family !== null && REGIONAL.has(family as AircraftFamily)) return 'ACDF';
  return body === 'WIDE' ? 'ABCDEFGHJK' : 'ABCDEF';
}

const ULD_KINDS = ['LD3', 'PALLET'] as const;

/**
 * Where in the hold: `FWD HOLD`, `AFT HOLD`, `BULK HOLD`; the wide-bodies add the ULD kind
 * to the forward and aft holds (`AFT HOLD LD3`), never a position number. Regional types and
 * the 757 have no bulk hold in this table; an unknown type is `CARGO HOLD`.
 */
export function holdPosition(family: string | null, body: string | null, rng: Rng): string {
  if (family === null) return 'CARGO HOLD';
  const holds = NO_BULK_HOLD.has(family as AircraftFamily)
    ? ['FWD', 'AFT']
    : ['FWD', 'AFT', 'BULK'];
  const hold = rng.pick(holds) as string;
  if (hold === 'BULK') return 'BULK HOLD';
  return body === 'WIDE' ? `${hold} HOLD ${rng.pick([...ULD_KINDS])}` : `${hold} HOLD`;
}
