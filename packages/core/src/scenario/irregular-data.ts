import { airlineDepartsFrom, airlineType } from '../ext/airline.js';
import type { ParkingStand } from '../ext/data.js';
import type { Ofp } from '../ofp/types.js';
import { createRng } from '../random/rng.js';

/**
 * Per-flight data of the irregular scenarios (T14) that a condition and a message, or two
 * messages, must agree on: the destination curfew, the onward connection, the extra fuel of a
 * tankering offer, the flow-control delay, the crew duty buffer, the gate a reassignment moves
 * to, the bags left behind. Deterministic logic over the OFP and Rng `${seed}/#irr`
 * (invariant 8); computed from the published schedule, so a delay brings a curfew or a
 * connection closer instead of moving it. Draw order is part of the replay contract: append
 * new draws at the end.
 */

export interface IrregularData {
  /** Latest landing at the destination (noise curfew), epoch ms UTC. */
  readonly curfew: number;
  readonly connectFlight: string;
  /**
   * The airline has own departures from the destination (OpenFlights routes, T43): an onward
   * flight of it is plausible, its number and time are not known.
   */
  readonly onwardRoute: boolean;
  /** STD of the onward connection, epoch ms UTC. */
  readonly connectStd: number;
  readonly connectPax: number;
  /** Extra fuel offered for tankering, kg. */
  readonly tankerKg: number;
  readonly flowDelayMin: number;
  /** Minutes the crew's duty allows after the estimated off-block. */
  readonly fdpBufferMin: number;
  readonly lostBags: number;
  /** Delay a crew change adds when the duty limit is passed, minutes (T41). */
  readonly crewChangeMin: number;
}

const MIN = 60_000;
const ceilTo = (ms: number, step: number) => Math.ceil(ms / step) * step;

export function buildIrregularData(
  ofp: Ofp,
  seed: number | string,
  transferPax: number,
): IrregularData {
  const rng = createRng(`${String(seed)}/#irr`);
  const t = ofp.times;
  const on = t.schedOnMs ?? t.schedInMs - (t.taxiInSec ?? 300) * 1000;
  const curfew = ceilTo(on + rng.int(20, 60) * MIN, 15 * MIN);
  // Onward flight after STA by airline type (T43, assumption 2026-10-15): low-cost 30–50 min,
  // hub carriers 100–140 (about two hours), others 50–95 as before. One draw, as before.
  const type = airlineType(ofp.airlineIcao);
  const [connMin, connMax] = type === 'LCC' ? [30, 50] : type === 'HUB' ? [100, 140] : [50, 95];
  const connectStd = ceilTo(t.schedInMs + rng.int(connMin, connMax) * MIN, 5 * MIN);
  const connectNo = rng.int(100, 989);
  // 20–50 % of the transfer passengers (`ops.transfer_pax`) take this one connection.
  const connectPax = Math.max(1, Math.round((transferPax * rng.int(20, 50)) / 100));
  // 10–25 % of the trip fuel, in 100 kg steps.
  const tankerKg = Math.round((ofp.fuel.enrouteBurnKg * rng.int(10, 25)) / 100 / 100) * 100;
  const flowDelayMin = rng.int(3, 8) * 5;
  const fdpBufferMin = rng.int(3, 8) * 5;
  const lostBags = rng.int(2, 9);
  const crewChangeMin = rng.int(8, 18) * 5;
  const prefix =
    ofp.airlineIcao ?? /^([A-Z]+)\d/.exec(ofp.callsign)?.[1] ?? ofp.callsign.slice(0, 3);
  return {
    curfew,
    connectFlight: `${prefix}${connectNo}`,
    onwardRoute: airlineDepartsFrom(ofp.airlineIcao, ofp.destination.icao),
    connectStd,
    connectPax,
    tankerKg,
    flowDelayMin,
    fdpBufferMin,
    lostBags,
    crewChangeMin,
  };
}

/**
 * The gate a reassignment moves to: another stand of the OSM list; never `current`. Null when
 * there is none (T43: no invented gates). One draw of `${seed}/#irr-gate`.
 */
export function reassignedGate(
  current: string | null,
  stands: readonly ParkingStand[] | null,
  seed: number | string,
): string | null {
  const rng = createRng(`${String(seed)}/#irr-gate`);
  const pool = [...new Set((stands ?? []).map((s) => s.ref))].filter((r) => r !== current).sort();
  return pool.length > 0 ? rng.pick(pool) : null;
}
