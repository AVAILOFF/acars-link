// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { DivertAirport } from '../ext/data.js';
import type { Ofp } from '../ofp/types.js';
import type { OooiKind, OooiSample } from '../phase/fsm.js';
import type { DelayPart } from '../scenario/delay-codes.js';
import { airportHere, HERE_WITHIN_NM, type Place } from '../scenario/divert.js';
import type { FlightKind } from '../scenario/flight-kind.js';
import type { ScenarioCategory } from '../scenario/types.js';

/**
 * The flight report after ON_BLOCK (T69): what happened against the plan of the OFP. Only numbers
 * of the data (invariant 8): the OOOI times and the fuel of the snapshots at them, the OFP's
 * schedule and fuel plan, the sim's touchdown rate; no grades (decision of 2026-10-30). A value
 * the data do not give is null ("no data"), never a guess.
 *
 * Rules (approved by the user 2026-10-30):
 * - fuel on board at OUT, OFF, ON, IN against the OFP's ramp, take-off and landing fuel; burns are
 *   the differences: taxi out = OUT − OFF (plan: `taxi`), trip = OFF − ON (`enroute_burn`), taxi in
 *   = ON − IN, block = OUT − IN (no plan for these two in the OFP);
 * - block time IN − OUT against `sched_block`, flight time ON − OFF against `est_time_enroute`;
 * - the landing airport: the nearest to the touchdown of the OFP's airports (destination, origin,
 *   alternates, ETOPS) and the diversion airport, if within {@link LANDED_WITHIN_NM}; farther =
 *   unknown (the position is still given). Diverted = landed elsewhere than the destination.
 */

/** A touchdown farther than this from every known airport is at an unknown one, NM (2026-10-30). */
export const LANDED_WITHIN_NM = HERE_WITHIN_NM;

export const FLIGHT_REPORT_VERSION = 1;

/** Actual against planned; `diff` = actual − plan, null when either is missing. */
export interface PlanFigure {
  readonly actual: number | null;
  readonly plan: number | null;
  readonly diff: number | null;
}

export interface FlightReport {
  readonly v: typeof FLIGHT_REPORT_VERSION;
  readonly callsign: string;
  readonly flightNumber: string | null;
  readonly origin: string;
  /** The planned destination (OFP). */
  readonly destination: string;
  readonly aircraftIcao: string;
  readonly aircraftReg: string | null;
  /**
   * Kind of flight in force at the end (T89); absent without the kind filter and in reports made
   * before T89.
   */
  readonly flightKind?: FlightKind;
  /** OOOI times, epoch ms UTC, against the OFP schedule (`sched_out` … `sched_in`). */
  readonly times: Readonly<Record<OooiKind, PlanFigure>>;
  /** IN − OUT against `sched_block`, ms. */
  readonly blockMs: PlanFigure;
  /** ON − OFF against `est_time_enroute`, ms. */
  readonly airMs: PlanFigure;
  /** Fuel on board, kg, rounded: OUT/OFF/ON against the plan; IN has no plan. */
  readonly fuelKg: Readonly<Record<OooiKind, PlanFigure>>;
  /** Fuel burnt, kg: taxi out, trip (OFF → ON), taxi in, block (OUT → IN). */
  readonly burnKg: {
    readonly taxiOut: PlanFigure;
    readonly trip: PlanFigure;
    readonly taxiIn: PlanFigure;
    readonly block: PlanFigure;
  };
  /** Descent rate at touchdown from the sim, ft/min; null = the sim gave none. */
  readonly touchdownFpm: number | null;
  /** Where the aircraft landed; null = no touchdown recorded. `icao` null = not a known airport. */
  readonly landed: {
    readonly icao: string | null;
    readonly lat: number;
    readonly lon: number;
    /** Landed elsewhere than the destination (a known airport or not). */
    readonly diverted: boolean;
  } | null;
  /** The diversion airport the airline or the pilot set (`DIVERT`, T50); null = none. */
  readonly divert: string | null;
  readonly goArounds: number;
  /** The departure delay the airline coded (late start, slot, `DELAY`): minutes and IATA codes (T43). */
  readonly delay: {
    readonly min: number;
    readonly parts: readonly { readonly code: string; readonly min: number }[];
  };
  /** Airline messages produced, pilot telexes to the airline, of them answers to a scenario. */
  readonly messages: {
    readonly airline: number;
    readonly pilot: number;
    readonly replies: number;
  };
  /** Irregular scenarios that started in the flight, oldest first (ids). */
  readonly irregular: readonly string[];
}

/** Counters the core keeps over a flight for the report. */
export interface ReportCounts {
  readonly airline: number;
  readonly pilot: number;
  readonly replies: number;
}

export interface ReportInput {
  readonly ofp: Ofp;
  readonly oooi: Readonly<Record<OooiKind, number | null>>;
  readonly oooiAt: Readonly<Record<OooiKind, OooiSample | null>>;
  readonly goArounds: number;
  readonly touchdownFpm: number | null;
  /** The engine's delay, ms (null before its first tick). */
  readonly delayMs: number | null;
  readonly delayParts: readonly DelayPart[];
  readonly divert: string | null;
  /** Reserve airports and places the core fetched (T50): where the diversion airport is. */
  readonly divertApts?: readonly DivertAirport[];
  readonly places?: Readonly<Record<string, Place | null>>;
  readonly counts: ReportCounts;
  /** Kind of flight (T89); absent = no kind filter. */
  readonly flightKind?: FlightKind;
  readonly started: readonly { readonly id: string; readonly category: ScenarioCategory }[];
}

const OOOI: readonly OooiKind[] = ['OUT', 'OFF', 'ON', 'IN'];
const MIN = 60_000;

const fig = (actual: number | null, plan: number | null): PlanFigure => ({
  actual,
  plan,
  diff: actual === null || plan === null ? null : actual - plan,
});
const sub = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);
const kg = (x: number | null | undefined) => (x == null ? null : Math.round(x));

export function flightReport(i: ReportInput): FlightReport {
  const { ofp, oooi } = i;
  const t = ofp.times;
  const sched: Record<OooiKind, number | null> = {
    OUT: t.schedOutMs,
    OFF: t.schedOffMs,
    ON: t.schedOnMs,
    IN: t.schedInMs,
  };
  const fuel = (k: OooiKind) => kg(i.oooiAt[k]?.fuelKg);
  const f = ofp.fuel;
  const plan: Record<OooiKind, number | null> = {
    OUT: kg(f.planRampKg),
    OFF: kg(f.planTakeoffKg),
    ON: kg(f.planLandingKg),
    IN: null,
  };
  const on = i.oooiAt.ON;
  return {
    v: FLIGHT_REPORT_VERSION,
    callsign: ofp.callsign,
    flightNumber: ofp.flightNumber,
    origin: ofp.origin.icao,
    destination: ofp.destination.icao,
    aircraftIcao: ofp.aircraft.icao,
    aircraftReg: ofp.aircraft.reg,
    ...(i.flightKind === undefined ? {} : { flightKind: i.flightKind }),
    times: byKind((k) => fig(oooi[k], sched[k])),
    blockMs: fig(sub(oooi.IN, oooi.OUT), t.schedBlockSec === null ? null : t.schedBlockSec * 1000),
    airMs: fig(sub(oooi.ON, oooi.OFF), t.estTimeEnrouteSec * 1000),
    fuelKg: byKind((k) => fig(fuel(k), plan[k])),
    burnKg: {
      taxiOut: fig(sub(fuel('OUT'), fuel('OFF')), kg(f.taxiKg)),
      trip: fig(sub(fuel('OFF'), fuel('ON')), kg(f.enrouteBurnKg)),
      taxiIn: fig(sub(fuel('ON'), fuel('IN')), null),
      block: fig(sub(fuel('OUT'), fuel('IN')), null),
    },
    touchdownFpm: i.touchdownFpm === null ? null : Math.round(i.touchdownFpm),
    landed: on === null ? null : landedAt(i, on),
    divert: i.divert,
    goArounds: i.goArounds,
    delay: {
      min: Math.round((i.delayMs ?? 0) / MIN),
      parts: i.delayParts.map((p) => ({ code: p.code, min: Math.round(p.ms / MIN) })),
    },
    messages: { ...i.counts },
    irregular: i.started.filter((s) => s.category === 'irregular').map((s) => s.id),
  };
}

function byKind<T>(f: (k: OooiKind) => T): Record<OooiKind, T> {
  return Object.fromEntries(OOOI.map((k) => [k, f(k)])) as Record<OooiKind, T>;
}

/** The nearest known airport within {@link LANDED_WITHIN_NM} of the touchdown. */
function landedAt(i: ReportInput, on: OooiSample): NonNullable<FlightReport['landed']> {
  const { ofp } = i;
  const icao = airportHere(ofp, on, i.divert, i.divertApts, i.places)?.icao ?? null;
  return {
    icao,
    lat: on.lat,
    lon: on.lon,
    diverted: icao !== ofp.destination.icao,
  };
}
