// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { modelFamily } from '../ext/aircraft-models.js';
import { airlineHub, airlineType, hubRoutesFor } from '../ext/airline.js';
import { type ConnexData, connexCandidates } from '../ext/connex.js';
import { type RouteStatsData, routeCandidates } from '../ext/routes.js';
import type { Ofp } from '../ofp/types.js';
import { createRng, type Rng } from '../random/rng.js';
import { aircraftInfo } from './aircraft.js';

/**
 * Per-flight "airline data" that several scenarios must agree on (T07): the last-minute
 * change between preliminary and final loadsheet, the CTOT, the arrival gate, the next
 * leg. Values come from deterministic logic over the OFP and a seeded Rng (invariant 8),
 * computed once per flight, so the prelim and final loadsheets, or the expected gate and
 * the arrival info, never contradict each other.
 *
 * The Rng is `${seed}/#ops` (`#` cannot appear in a scenario id). Draw order is part of
 * the replay contract: append new draws at the end.
 *
 * Belt and transfer numbers are placeholders. The arrival gate is NOT invented (T43): `arrGate`
 * stays null until the engine takes a real one from the OSM stands (T13).
 */

export interface FlightLoad {
  readonly pax: number;
  /** Final − planned. */
  readonly paxLmc: number;
  readonly cargoKg: number;
  readonly cargoLmcKg: number;
  /** Total mass change of the LMC, kg. */
  readonly lmcKg: number;
  readonly zfwKg: number;
  readonly towKg: number;
  readonly ldwKg: number | null;
  /** Allowed TOW − TOW (min of MTOW, MZFW + TOF, MLW + trip). */
  readonly underloadKg: number;
  readonly lmc: boolean;
}

export interface FlightOps {
  readonly slotDelayMin: number;
  /** Calculated take-off time, epoch ms UTC. */
  readonly ctot: number;
  /** A real gate/stand ref from OSM; null while there is none. */
  readonly arrGate: string | null;
  /** What `arrGate` is: an `aeroway=gate` or a parking position (remote stand). */
  readonly gateKind: 'gate' | 'stand' | null;
  readonly belt: number;
  readonly transferPax: number;
  readonly turnaroundMin: number;
  /** Next leg with this aircraft (T53: from the hub after a flight into it, else back). */
  readonly nextFlight: string;
  /** Departure of the next leg: the destination of this one. */
  readonly nextOrig: string;
  readonly nextDest: string;
  readonly nextStd: number;
  /**
   * Where the next leg comes from (T55): `fids` — a real departure (number, place, STD),
   * `routes` — a route of the airline from the statistics (place only), null — OpenFlights / back.
   */
  readonly nextLive: 'fids' | 'routes' | null;
  readonly cabinCrew: number;
  /** How much earlier a ready (RDY) flight may get its CTOT, minutes (T44, assumption). */
  readonly rdyGainMin: number;
}

export interface FlightData {
  readonly load: FlightLoad;
  readonly ops: FlightOps;
}

/** Standard mass per passenger when the OFP has none (kg). */
const DEFAULT_PAX_KG = 84;
const MIN = 60_000;

/**
 * How the next leg is chosen (T53): version 1 = always back to the origin with number + 1 (as
 * recorded before T53); 2 = after a flight into the hub, a route of the airline from the hub;
 * 3 (T55) = first a real departure of the airline from the destination (`live.connex`), then a
 * route from its statistics (`live.routes`), else as 2. `hub`: the user's hub (setting), instead
 * of the OpenFlights one.
 */
export interface NextLegOptions {
  readonly version: 1 | 2 | 3;
  readonly hub: string | null;
  /** AeroDataBox data of the flight (version 3). */
  readonly live?: {
    readonly connex?: ConnexData | null | undefined;
    readonly routes?: RouteStatsData | null | undefined;
  };
}

const NEXT_LEG_DEFAULT: NextLegOptions = { version: 2, hub: null };

export function buildFlightData(
  ofp: Ofp,
  seed: number | string,
  nextLegOptions: NextLegOptions = NEXT_LEG_DEFAULT,
): FlightData {
  const rng = createRng(`${String(seed)}/#ops`);
  const w = ofp.weights;
  const f = ofp.fuel;
  const t = ofp.times;

  // LMC (docs/01: ±5 pax at p = 0.5, ±200 kg cargo at p = 0.5).
  const maxPax = ofp.aircraft.maxPax ?? Number.POSITIVE_INFINITY;
  const paxDraw = rng.chance(0.5) ? rng.int(-5, 5) : 0;
  const pax = Math.min(maxPax, Math.max(0, w.paxCount + paxDraw));
  const cargoDraw = rng.chance(0.5) ? rng.int(-20, 20) * 10 : 0;
  const cargoKg = Math.max(0, w.cargoKg + cargoDraw);
  const paxLmc = pax - w.paxCount;
  const cargoLmcKg = cargoKg - w.cargoKg;
  const perPax = (w.paxWeightKg ?? DEFAULT_PAX_KG) + (w.bagWeightKg ?? 0);
  const lmcKg = Math.round(paxLmc * perPax) + cargoLmcKg;
  const zfwKg = w.estZfwKg + lmcKg;
  const towKg = w.estTowKg + lmcKg;
  const ldwKg = w.estLdwKg === null ? null : w.estLdwKg + lmcKg;
  const allowed = [w.maxTowKg, w.maxZfwKg + f.planTakeoffKg];
  if (w.maxLdwKg !== null) allowed.push(w.maxLdwKg + f.enrouteBurnKg);

  const slotDelayMin = rng.int(5, 30);
  const offMs = t.schedOffMs ?? t.schedOutMs + (t.taxiOutSec ?? 600) * 1000;
  // Still drawn (and dropped) so that the rest of the draw order stays as in older recordings.
  rng.pick(['A', 'B', 'C', 'D', 'E']);
  rng.int(1, 40);
  const belt = rng.int(1, 12);
  const transferPax = Math.round((pax * rng.int(5, 25)) / 100);
  const heavy = ofp.aircraft.wakeCategory === 'H' || ofp.aircraft.wakeCategory === 'J';
  // By airline type (T43, user's numbers 2026-10-15): low-cost 45–55 min, hub carriers about
  // two hours (105–135), others 50–70 (heavy 75–95 as before). One draw, as before.
  const type = airlineType(ofp.airlineIcao);
  const [turnBase, turnSteps] =
    type === 'LCC' ? [45, 2] : type === 'HUB' ? [105, 6] : heavy ? [75, 4] : [50, 4];
  const turnaroundMin = turnBase + rng.int(0, turnSteps) * 5;
  const seats = ofp.aircraft.maxPax ?? pax;
  // Appended last: the draw order of older recordings stays.
  const rdyGainMin = rng.int(5, 15);
  const next = nextLeg(ofp, seed, nextLegOptions, turnaroundMin);

  return {
    load: {
      pax,
      paxLmc,
      cargoKg,
      cargoLmcKg,
      lmcKg,
      zfwKg,
      towKg,
      ldwKg,
      underloadKg: Math.min(...allowed) - towKg,
      lmc: paxLmc !== 0 || cargoLmcKg !== 0,
    },
    ops: {
      slotDelayMin,
      ctot: offMs + slotDelayMin * MIN,
      arrGate: null,
      gateKind: null,
      belt,
      transferPax,
      turnaroundMin,
      nextFlight: next.flight,
      nextOrig: ofp.destination.icao,
      nextDest: next.dest,
      nextStd: next.std ?? roundTo5Min(t.schedInMs + turnaroundMin * MIN),
      nextLive: next.live,
      // The OFP crew list when there is one (T43); else one per 50 seats.
      cabinCrew: ofp.crew?.cabin || Math.max(1, Math.ceil(seats / 50)),
      rdyGainMin,
    },
  };
}

/**
 * The next leg (T53, approved by the user 2026-10-15). After a flight into the hub (the user's,
 * else the OpenFlights one) from elsewhere: a seeded pick among the airline's routes from the hub
 * flown with this aircraft type, not back to the origin, under a seeded number of the same
 * length. Otherwise, or with no such route: back to the origin, number + 1. Own Rng stream
 * `#next`, so the draws of `#ops` stay as recorded.
 */
function nextLeg(
  ofp: Ofp,
  seed: number | string,
  o: NextLegOptions,
  turnaroundMin: number,
): NextLeg {
  if (o.version === 3) {
    const live = liveNextLeg(ofp, seed, o, turnaroundMin);
    if (live !== null) return live;
  }
  const orig = ofp.origin.icao;
  const dest = ofp.destination.icao;
  const back: NextLeg = {
    flight: flightNumber(ofp, (n) => n + 1),
    dest: orig,
    std: null,
    live: null,
  };
  if (o.version === 1) return back;
  const hub = o.hub ?? airlineHub(ofp.airlineIcao);
  if (hub === null || dest !== hub || orig === hub) return back;
  const routes = hubRoutesFor(ofp.airlineIcao, hub, ofp.aircraft.icao).filter((d) => d !== orig);
  if (routes.length === 0) return back;
  const rng = createRng(`${String(seed)}/#next`);
  const to = rng.pick(routes);
  return {
    flight: flightNumber(ofp, (n, digits) => randomNumber(rng, n, digits)),
    dest: to,
    std: null,
    live: null,
  };
}

interface NextLeg {
  readonly flight: string;
  readonly dest: string;
  /** Real STD (level 1); null = STA + turnaround. */
  readonly std: number | null;
  readonly live: FlightOps['nextLive'];
}

/**
 * Levels 1 and 2 of T55 (approved by the user 2026-10-16, R1–R4). Level 1: an own operating
 * departure (not a codeshare, R3) from the destination of the same T40 family by its
 * `aircraft.model` (R2), not before STA + turnaround, not back to the origin — its number (the
 * airline's ICAO code + the digits), place and STD (R1). Level 2: an own route from the
 * statistics, not back, weighted by the daily average, under a seeded number; the STD stays STA +
 * turnaround (R4, user's decision 2026-10-21). Own Rng stream `#next-live`; null = neither.
 */
function liveNextLeg(
  ofp: Ofp,
  seed: number | string,
  o: NextLegOptions,
  turnaroundMin: number,
): NextLeg | null {
  const rng = createRng(`${String(seed)}/#next-live`);
  const family = aircraftInfo(ofp.aircraft.icao)?.family ?? null;
  const earliest = ofp.times.schedInMs + turnaroundMin * MIN;
  const flights =
    family === null || ofp.airlineIcao === null
      ? []
      : connexCandidates(o.live?.connex, ofp).filter(
          (f) =>
            !f.codeshare &&
            (f.std as number) >= earliest &&
            f.dest !== ofp.origin.icao &&
            modelFamily(f.model) === family &&
            /\d+[A-Z]?$/.test(f.number),
        );
  if (flights.length > 0) {
    const f = rng.pick(flights);
    const digits = /(\d+[A-Z]?)$/.exec(f.number)?.[1] as string;
    return { flight: `${ofp.airlineIcao}${digits}`, dest: f.dest, std: f.std, live: 'fids' };
  }
  const routes = routeCandidates(o.live?.routes, ofp);
  if (routes.length === 0) return null;
  // Weights in hundredths of a flight a day (the source gives two decimals).
  const weights = routes.map((r) => Math.max(1, Math.round((r.daily as number) * 100)));
  let x = rng.int(
    1,
    weights.reduce((a, b) => a + b, 0),
  );
  let i = 0;
  while (x > (weights[i] as number)) x -= weights[i++] as number;
  return {
    flight: flightNumber(ofp, (n, digits) => randomNumber(rng, n, digits)),
    dest: (routes[i] as (typeof routes)[number]).dest,
    std: null,
    live: 'routes',
  };
}

/** A number of `digits` digits other than `n`. */
function randomNumber(rng: Rng, n: number, digits: number): number {
  const lo = digits <= 1 ? 1 : 10 ** (digits - 1);
  const hi = 10 ** digits - 1;
  const x = rng.int(lo, hi);
  return x !== n ? x : x < hi ? x + 1 : lo;
}

/**
 * `SJX` + `822` → `SJX` + next(822); without an airline flight number, the callsign's number;
 * without one either, the callsign as it is.
 */
function flightNumber(ofp: Ofp, next: (n: number, digits: number) => number): string {
  const n = /^(\d+)([A-Z]?)$/.exec(ofp.flightNumber ?? '');
  if (n !== null && ofp.airlineIcao !== null) {
    const d = n[1] as string;
    return `${ofp.airlineIcao}${next(Number(d), d.length)}`;
  }
  const c = /^(.*?)(\d+)([A-Z]?)$/.exec(ofp.callsign);
  if (c === null) return ofp.callsign;
  const d = c[2] as string;
  return `${c[1]}${next(Number(d), d.length)}`;
}

const roundTo5Min = (ms: number) => Math.round(ms / (5 * MIN)) * 5 * MIN;
