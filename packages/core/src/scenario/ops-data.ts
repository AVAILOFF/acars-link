import type { Ofp } from '../ofp/types.js';
import { createRng } from '../random/rng.js';

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
  /** Next leg back to the origin. */
  readonly nextFlight: string;
  readonly nextStd: number;
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

export function buildFlightData(ofp: Ofp, seed: number | string): FlightData {
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
  const turnaroundMin = (heavy ? 75 : 40) + rng.int(0, 4) * 5;
  const seats = ofp.aircraft.maxPax ?? pax;
  // Appended last: the draw order of older recordings stays.
  const rdyGainMin = rng.int(5, 15);

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
      nextFlight: nextFlight(ofp),
      nextStd: roundTo5Min(t.schedInMs + turnaroundMin * MIN),
      // The OFP crew list when there is one (T43); else one per 50 seats.
      cabinCrew: ofp.crew?.cabin || Math.max(1, Math.ceil(seats / 50)),
      rdyGainMin,
    },
  };
}

/** `SJX` + `822` → `SJX823`; without an airline flight number, the callsign's number + 1. */
function nextFlight(ofp: Ofp): string {
  const n = /^(\d+)([A-Z]?)$/.exec(ofp.flightNumber ?? '');
  if (n !== null && ofp.airlineIcao !== null) return `${ofp.airlineIcao}${Number(n[1]) + 1}`;
  const c = /^(.*?)(\d+)([A-Z]?)$/.exec(ofp.callsign);
  return c === null ? ofp.callsign : `${c[1]}${Number(c[2]) + 1}`;
}

const roundTo5Min = (ms: number) => Math.round(ms / (5 * MIN)) * 5 * MIN;
