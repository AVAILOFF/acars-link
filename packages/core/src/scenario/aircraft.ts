// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

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
 * - A300, B767, MD-11 (T90, approved by the user 2026-11-04): designators checked against ICAO
 *   Doc 8643 (doc8643.icao.int data, 2026-11-04): A306 A-300B4/C4/F4-600, A30B A-300B2/B4,
 *   B762/B763/B764 767-200/-300/-400, MD11 MD-11. Holds as the other wide-bodies (no airport-
 *   planning document read). EICAS of the 767 is common knowledge like the 757's `[ПРОВЕРИТЬ]`;
 *   the A300 (classic and -600 differ) and the MD-11 get no alerting system name.
 * - Business aviation (T92, approved by the user 2026-11-04): business jets and turboprops by ICAO
 *   Doc 8643 (doc8643.icao.int data, 2026-11-04), the maker as Doc 8643 names it. No alerting
 *   system name (CAS of Garmin / Collins avionics `[ПРОВЕРИТЬ]`), no seats and holds of their own:
 *   `{seat}` / `{hold}` as for an unknown type. These types make a flight business aviation
 *   (`flight-kind.ts`); BBJ / ACJ share the airliners' designators and are recognized by FPL
 *   type `G` only.
 */

export const AIRCRAFT_FAMILIES = [
  'A320',
  'A330',
  'A350',
  'A380',
  'A300',
  'B737',
  'B747',
  'B757',
  'B767',
  'B777',
  'B787',
  'MD-11',
  'E-JET',
  'CRJ',
  'ATR',
  'DH8',
  // Business aviation (T92).
  'CITATION',
  'CHALLENGER',
  'GLOBAL',
  'GULFSTREAM',
  'FALCON',
  'LEARJET',
  'PHENOM',
  'PRAETOR',
  'PC-24',
  'HONDAJET',
  'VISION',
  'HAWKER',
  'ECLIPSE',
  'KING AIR',
  'PC-12',
  'TBM',
] as const;
export type AircraftFamily = (typeof AIRCRAFT_FAMILIES)[number];

export interface AircraftInfo {
  readonly family: AircraftFamily;
  readonly maker: string;
  readonly body: 'NARROW' | 'WIDE';
  /**
   * `null`: no central alerting system of ECAM / EICAS kind (turboprops, 737: annunciator panel),
   * or none named (A300, MD-11).
   */
  readonly alertSys: 'ECAM' | 'EICAS' | null;
}

const FAMILY_INFO: Readonly<Record<AircraftFamily, Omit<AircraftInfo, 'family'>>> = {
  A320: { maker: 'AIRBUS', body: 'NARROW', alertSys: 'ECAM' },
  A330: { maker: 'AIRBUS', body: 'WIDE', alertSys: 'ECAM' },
  A350: { maker: 'AIRBUS', body: 'WIDE', alertSys: 'ECAM' },
  A380: { maker: 'AIRBUS', body: 'WIDE', alertSys: 'ECAM' },
  A300: { maker: 'AIRBUS', body: 'WIDE', alertSys: null },
  B737: { maker: 'BOEING', body: 'NARROW', alertSys: null },
  B747: { maker: 'BOEING', body: 'WIDE', alertSys: 'EICAS' },
  B757: { maker: 'BOEING', body: 'NARROW', alertSys: 'EICAS' },
  B767: { maker: 'BOEING', body: 'WIDE', alertSys: 'EICAS' },
  B777: { maker: 'BOEING', body: 'WIDE', alertSys: 'EICAS' },
  B787: { maker: 'BOEING', body: 'WIDE', alertSys: 'EICAS' },
  'MD-11': { maker: 'BOEING', body: 'WIDE', alertSys: null },
  'E-JET': { maker: 'EMBRAER', body: 'NARROW', alertSys: 'EICAS' },
  CRJ: { maker: 'BOMBARDIER', body: 'NARROW', alertSys: 'EICAS' },
  ATR: { maker: 'ATR', body: 'NARROW', alertSys: null },
  DH8: { maker: 'DE HAVILLAND', body: 'NARROW', alertSys: null },
  CITATION: { maker: 'CESSNA', body: 'NARROW', alertSys: null },
  CHALLENGER: { maker: 'BOMBARDIER', body: 'NARROW', alertSys: null },
  GLOBAL: { maker: 'BOMBARDIER', body: 'NARROW', alertSys: null },
  GULFSTREAM: { maker: 'GULFSTREAM AEROSPACE', body: 'NARROW', alertSys: null },
  FALCON: { maker: 'DASSAULT', body: 'NARROW', alertSys: null },
  LEARJET: { maker: 'LEARJET', body: 'NARROW', alertSys: null },
  PHENOM: { maker: 'EMBRAER', body: 'NARROW', alertSys: null },
  PRAETOR: { maker: 'EMBRAER', body: 'NARROW', alertSys: null },
  'PC-24': { maker: 'PILATUS', body: 'NARROW', alertSys: null },
  HONDAJET: { maker: 'HONDA', body: 'NARROW', alertSys: null },
  VISION: { maker: 'CIRRUS', body: 'NARROW', alertSys: null },
  HAWKER: { maker: 'HAWKER BEECHCRAFT', body: 'NARROW', alertSys: null },
  ECLIPSE: { maker: 'ECLIPSE', body: 'NARROW', alertSys: null },
  'KING AIR': { maker: 'BEECH', body: 'NARROW', alertSys: null },
  'PC-12': { maker: 'PILATUS', body: 'NARROW', alertSys: null },
  TBM: { maker: 'SOCATA', body: 'NARROW', alertSys: null },
};

const CODES: Readonly<Record<AircraftFamily, string>> = {
  A320: 'A318 A319 A320 A321 A19N A20N A21N',
  A330: 'A332 A333 A338 A339',
  A350: 'A359 A35K',
  A380: 'A388',
  A300: 'A306 A30B',
  B737: 'B731 B732 B733 B734 B735 B736 B737 B738 B739 B37M B38M B39M B3XM',
  B747: 'B741 B742 B743 B744 B748 B74D B74R B74S',
  B757: 'B752 B753',
  B767: 'B762 B763 B764',
  B777: 'B772 B773 B77L B77W B778 B779',
  B787: 'B788 B789 B78X',
  'MD-11': 'MD11',
  'E-JET': 'E170 E75S E75L E190 E195 E290 E295',
  CRJ: 'CRJ1 CRJ2 CRJ7 CRJ9 CRJX',
  ATR: 'AT43 AT44 AT45 AT46 AT72 AT73 AT75 AT76',
  DH8: 'DH8A DH8B DH8C DH8D',
  CITATION: 'C501 C510 C525 C25A C25B C25C C25M C550 C560 C56X C650 C680 C68A C700 C750',
  CHALLENGER: 'CL30 CL35 CL60',
  GLOBAL: 'GLEX GL5T GL7T',
  GULFSTREAM: 'G280 GLF4 GLF5 GLF6 GA5C GA6C GA7C GA8C',
  FALCON: 'FA10 FA20 FA50 FA6X FA7X FA8X F2TH F900',
  LEARJET: 'LJ35 LJ45 LJ60 LJ75',
  PHENOM: 'E50P E55P',
  PRAETOR: 'E545 E550',
  'PC-24': 'PC24',
  HONDAJET: 'HDJT',
  VISION: 'SF50',
  HAWKER: 'H25B BE40 PRM1',
  ECLIPSE: 'EA50',
  'KING AIR': 'BE20 BE30 B350',
  'PC-12': 'PC12',
  TBM: 'TBM7 TBM8 TBM9',
};

/** Business aviation families (T92): a flight on one of these types is business aviation. */
export const BIZAV_FAMILIES: ReadonlySet<AircraftFamily> = new Set([
  'CITATION',
  'CHALLENGER',
  'GLOBAL',
  'GULFSTREAM',
  'FALCON',
  'LEARJET',
  'PHENOM',
  'PRAETOR',
  'PC-24',
  'HONDAJET',
  'VISION',
  'HAWKER',
  'ECLIPSE',
  'KING AIR',
  'PC-12',
  'TBM',
]);

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

/** A business aviation type (T92), by the ICAO designator. */
export function isBizAviationType(icao: string | null | undefined): boolean {
  const a = aircraftInfo(icao);
  return a !== null && BIZAV_FAMILIES.has(a.family);
}

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
  if (family === null || BIZAV_FAMILIES.has(family as AircraftFamily)) return 'CARGO HOLD';
  const holds = NO_BULK_HOLD.has(family as AircraftFamily)
    ? ['FWD', 'AFT']
    : ['FWD', 'AFT', 'BULK'];
  const hold = rng.pick(holds) as string;
  if (hold === 'BULK') return 'BULK HOLD';
  return body === 'WIDE' ? `${hold} HOLD ${rng.pick([...ULD_KINDS])}` : `${hold} HOLD`;
}
