// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { Ofp } from '../ofp/types.js';
import { isBizAviationType } from './aircraft.js';

/**
 * Kind of flight (T89): what the scenarios are for. Scheduled and charter passenger flights, cargo,
 * ferry / positioning, business aviation, air ambulance. Scenarios name the kinds they are for in
 * `operations` (`types.ts`); without it a scenario is for every kind.
 */
export const FLIGHT_KINDS = [
  'sched_pax',
  'charter_pax',
  'cargo',
  'ferry',
  'bizav',
  'medevac',
] as const;
export type FlightKind = (typeof FLIGHT_KINDS)[number];

export const isFlightKind = (v: unknown): v is FlightKind =>
  typeof v === 'string' && (FLIGHT_KINDS as readonly string[]).includes(v);

/**
 * Type of a charter (T107): `tour` — a package-holiday charter of a tour operator (the default when
 * the user did not choose one), `sports` — a sports team, `vip` — a one-off VIP party. Scenarios of
 * a charter name their types in `charter` (`types.ts`); without it a scenario is for every type.
 */
export const CHARTER_TYPES = ['tour', 'sports', 'vip'] as const;
export type CharterType = (typeof CHARTER_TYPES)[number];

export const isCharterType = (v: unknown): v is CharterType =>
  typeof v === 'string' && (CHARTER_TYPES as readonly string[]).includes(v);

/** The type of a charter the user did not choose (T107, approved by the user 2026-11-07). */
export const DEFAULT_CHARTER_TYPE: CharterType = 'tour';

/**
 * The user's choice of the kind of flight (T89, null = automatic) and of the type of charter (T107,
 * null = the default type). `charter` absent = no charter type, as in recordings before T107.
 */
export interface KindChoice {
  readonly override: FlightKind | null;
  readonly charter?: CharterType | null;
}

/** The kinds that carry passengers in a cabin (the passenger scenarios, T89). */
export const PASSENGER_KINDS: readonly FlightKind[] = ['sched_pax', 'charter_pax'];

/** `STS/` reasons that make an air ambulance flight (ICAO Doc 4444, appendix 2, item 18). */
const MEDEVAC_STS: readonly string[] = ['HOSP', 'MEDEVAC'];

/**
 * Which rule of {@link classifyFlight} gave the recognized kind: `sts` — `STS/HOSP` or
 * `STS/MEDEVAC` in item 18; `cargo` — no passengers, freight on board; `ferry` — no passengers, no
 * freight; `flight_type` — FPL item 8b `G` (general aviation); `aircraft_type` — a business
 * aviation type (T92, `aircraft.ts`); `default` — none of these.
 */
export type FlightKindRule =
  | 'sts'
  | 'cargo'
  | 'ferry'
  | 'flight_type'
  | 'aircraft_type'
  | 'default';

export interface FlightKindInfo {
  /** The kind in force: the user's choice, else the recognized one. */
  readonly kind: FlightKind;
  /** Recognized from the OFP. */
  readonly auto: FlightKind;
  /** The user's choice for this flight; null = automatic. */
  readonly override: FlightKind | null;
  /** The rule that gave {@link auto}, and what it read (for the app's "based on" line). */
  readonly rule: FlightKindRule;
  readonly paxCount: number;
  /** Freight only, kg (`freightKg`; the OFP's cargo when that is absent). */
  readonly freightKg: number;
  /** FPL item 8b; null = not in the OFP. */
  readonly flightType: string | null;
  /** The `STS/` reason of rule `sts`, else null. */
  readonly sts: string | null;
  /** ICAO type designator of the OFP (rule `aircraft_type`, T92); null = not in the OFP. */
  readonly aircraftType: string | null;
  /**
   * Type of the charter in force (T107): the user's choice, else {@link DEFAULT_CHARTER_TYPE};
   * null when the kind is not `charter_pax` or without the type (recordings before T107).
   */
  readonly charter: CharterType | null;
  /** The user's choice of the charter type; null = not chosen (the default type). */
  readonly charterOverride: CharterType | null;
}

/**
 * The kind of a flight (T89, approved by the user 2026-11-04): the user's choice first; then
 * `STS/HOSP` / `STS/MEDEVAC` → medevac; no passengers and freight → cargo, whatever the type
 * (freight in the cabin, belly-only); no passengers and no freight → ferry; FPL type `G`, then a
 * business aviation type (T92, `aircraft.ts`) → business aviation; else a scheduled passenger
 * flight. A charter is never recognized (item 8b `N`
 * is not used, decision of 2026-11-04): only the user's choice makes one. `M` and `X` follow the
 * same rules.
 */
export function classifyFlight(
  ofp: Ofp,
  override: FlightKind | null = null,
  charterOverride?: CharterType | null,
): FlightKindInfo {
  const w = ofp.weights;
  const freightKg = w.freightKg ?? w.cargoKg;
  const flightType = ofp.flightType ?? null;
  const sts = (ofp.item18?.sts ?? []).find((s) => MEDEVAC_STS.includes(s)) ?? null;
  const [auto, rule]: [FlightKind, FlightKindRule] =
    sts !== null
      ? ['medevac', 'sts']
      : w.paxCount === 0 && freightKg > 0
        ? ['cargo', 'cargo']
        : w.paxCount === 0
          ? ['ferry', 'ferry']
          : flightType === 'G'
            ? ['bizav', 'flight_type']
            : isBizAviationType(ofp.aircraft.icao)
              ? ['bizav', 'aircraft_type']
              : ['sched_pax', 'default'];
  const kind = override ?? auto;
  return {
    kind,
    auto,
    override,
    rule,
    paxCount: w.paxCount,
    freightKg,
    flightType,
    sts,
    aircraftType: ofp.aircraft.icao ?? null,
    // T107: `charterOverride` absent = no charter type (recordings before T107).
    charter:
      kind === 'charter_pax' && charterOverride !== undefined
        ? (charterOverride ?? DEFAULT_CHARTER_TYPE)
        : null,
    charterOverride: charterOverride ?? null,
  };
}
