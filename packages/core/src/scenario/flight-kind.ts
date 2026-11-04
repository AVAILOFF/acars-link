// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { Ofp } from '../ofp/types.js';

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

/** The kinds that carry passengers in a cabin (the passenger scenarios, T89). */
export const PASSENGER_KINDS: readonly FlightKind[] = ['sched_pax', 'charter_pax'];

/** `STS/` reasons that make an air ambulance flight (ICAO Doc 4444, appendix 2, item 18). */
const MEDEVAC_STS: readonly string[] = ['HOSP', 'MEDEVAC'];

/**
 * Which rule of {@link classifyFlight} gave the recognized kind: `sts` — `STS/HOSP` or
 * `STS/MEDEVAC` in item 18; `cargo` — no passengers, freight on board; `ferry` — no passengers, no
 * freight; `flight_type` — FPL item 8b `G` (general aviation); `default` — none of these.
 */
export type FlightKindRule = 'sts' | 'cargo' | 'ferry' | 'flight_type' | 'default';

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
}

/**
 * The kind of a flight (T89, approved by the user 2026-11-04): the user's choice first; then
 * `STS/HOSP` / `STS/MEDEVAC` → medevac; no passengers and freight → cargo, whatever the type
 * (freight in the cabin, belly-only); no passengers and no freight → ferry; FPL type `G` →
 * business aviation; else a scheduled passenger flight. A charter is never recognized (item 8b `N`
 * is not used, decision of 2026-11-04): only the user's choice makes one. `M` and `X` follow the
 * same rules.
 */
export function classifyFlight(ofp: Ofp, override: FlightKind | null = null): FlightKindInfo {
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
            : ['sched_pax', 'default'];
  return {
    kind: override ?? auto,
    auto,
    override,
    rule,
    paxCount: w.paxCount,
    freightKg,
    flightType,
    sts,
  };
}
