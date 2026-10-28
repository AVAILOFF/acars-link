// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { bearingDeg, destinationPoint, distanceNm, type LatLon } from '../geo/geo.js';
import type { Ofp } from '../ofp/types.js';
import { createRng } from '../random/rng.js';
import type { TelemetrySnapshot } from '../telemetry/types.js';

/**
 * Deterministic synthetic flight for unit tests without MSFS (docs/04 "Тестирование").
 *
 * A tiny kinematic model, not a flight model: gate with refuelling → pushback with engine
 * start → taxi → takeoff roll → climb → cruise → 3° path descent → landing → taxi in →
 * shutdown. The aircraft moves along the OFP navlog. Same options → same snapshots.
 * A go-around is built in (`goAround`); pause, sim rate, teleport and telemetry gaps are
 * applied afterwards by `synthetic/anomalies.ts`.
 */

export type SyntheticStage =
  | 'GATE'
  | 'PUSHBACK'
  | 'TAXI_OUT'
  | 'TAKEOFF_ROLL'
  | 'CLIMB'
  | 'CRUISE'
  | 'DESCENT'
  | 'APPROACH'
  | 'GO_AROUND'
  | 'ROLLOUT'
  | 'TAXI_IN'
  | 'PARKED';

export interface SyntheticFlightOptions {
  readonly ofp: Ofp;
  /** First sample time. Default: boarding starts so that pushback begins at `sched_out`. */
  readonly startMs?: number;
  /** Sample period. Default 1000 (1 Hz, like the bridge). */
  readonly stepMs?: number;
  /** Seed for small instrument noise. Default `${callsign}/${requestId}`. */
  readonly seed?: number | string;
  /** Add ±1 kt / ±40 fpm style noise while airborne. Default true. */
  readonly noise?: boolean;
  readonly engineCount?: number;
  /** Time at the gate before pushback. Default 35 min. */
  readonly boardingSec?: number;
  /** Start at the gate with ~45 % of ramp fuel and refuel during boarding. Default true. */
  readonly refuel?: boolean;
  /** Pushback + taxi to the runway. Default OFP `taxi_out` or 10 min. */
  readonly taxiOutSec?: number;
  /** Taxi from runway exit to the stand. Default OFP `taxi_in` or 5 min. */
  readonly taxiInSec?: number;
  readonly aircraftTitle?: string;
  /**
   * Go around once on the first approach at this height above the destination, fly a
   * level circuit at 3000 ft AGL and land from the second approach. Default: no go-around.
   */
  readonly goAroundAglFt?: number;
}

export interface SyntheticStageMark {
  readonly stage: SyntheticStage;
  /** Index of the first snapshot in this stage. */
  readonly index: number;
  readonly t: number;
}

export interface SyntheticFlight {
  readonly snapshots: readonly TelemetrySnapshot[];
  readonly stages: readonly SyntheticStageMark[];
}

const PUSHBACK_SEC = 150;
const PARKED_SEC = 300;
const DOOR_CLOSE_BEFORE_PUSH_SEC = 180;
const BEACON_ON_BEFORE_PUSH_SEC = 60;
const ROTATE_KT = 150;
const TAXI_KT = 15;
const CLIMB_FPM = 2500;
const PATH_FT_PER_NM = 318; // 3° glide path
const APPROACH_AGL_FT = 3000;
const MISSED_APPROACH_AGL_FT = 3000;
/** How far out the go-around circuit turns back to the runway. */
const CIRCUIT_OUTBOUND_NM = 15;
const SAFETY_LIMIT_SEC = 24 * 3600;

class Route {
  private readonly points: LatLon[];
  private readonly cum: number[];
  readonly totalNm: number;

  constructor(ofp: Ofp) {
    this.points = [ofp.origin, ...ofp.navlog];
    this.cum = [0];
    for (let i = 1; i < this.points.length; i++) {
      const a = this.points[i - 1] as LatLon;
      const b = this.points[i] as LatLon;
      this.cum.push((this.cum[i - 1] as number) + distanceNm(a, b));
    }
    this.totalNm = this.cum.at(-1) as number;
  }

  /** Position and course at `d` NM along the route; extrapolates past both ends. */
  at(d: number): { pos: LatLon; course: number } {
    const n = this.points.length;
    const first = this.points[0] as LatLon;
    if (d <= 0) {
      const course = bearingDeg(first, this.points[1] as LatLon);
      return { pos: destinationPoint(first, course, d), course };
    }
    if (d >= this.totalNm) {
      const prev = this.points[n - 2] as LatLon;
      const last = this.points[n - 1] as LatLon;
      const course = bearingDeg(prev, last);
      return { pos: destinationPoint(last, course, d - this.totalNm), course };
    }
    let i = 1;
    while ((this.cum[i] as number) < d) i++;
    const a = this.points[i - 1] as LatLon;
    const b = this.points[i] as LatLon;
    const course = bearingDeg(a, b);
    return { pos: destinationPoint(a, course, d - (this.cum[i - 1] as number)), course };
  }
}

const round = (x: number, dp: number): number => {
  const k = 10 ** dp;
  return Math.round(x * k) / k;
};

/** True airspeed ≈ IAS + 2 % per 1000 ft; no wind, so GS = TAS. */
const tasKt = (ias: number, altFt: number): number => ias * (1 + 0.02 * (altFt / 1000));

export function generateSyntheticFlight(options: SyntheticFlightOptions): SyntheticFlight {
  const { ofp } = options;
  const stepMs = options.stepMs ?? 1000;
  if (!(stepMs > 0)) throw new RangeError(`stepMs must be > 0, got ${stepMs}`);
  const dt = stepMs / 1000;
  const engineCount = options.engineCount ?? 2;
  const boardingSec = options.boardingSec ?? 35 * 60;
  const taxiOutSec = Math.max(
    options.taxiOutSec ?? ofp.times.taxiOutSec ?? 600,
    PUSHBACK_SEC + 120,
  );
  const taxiInSec = options.taxiInSec ?? ofp.times.taxiInSec ?? 300;
  const noise = options.noise ?? true;
  const rng = createRng(options.seed ?? `${ofp.callsign}/${ofp.source.requestId}`);
  const title = options.aircraftTitle ?? `SYNTHETIC ${ofp.aircraft.icao}`;

  const route = new Route(ofp);
  const originElev = ofp.origin.elevationFt;
  const destElev = ofp.destination.elevationFt;
  const cruiseAlt = ofp.initialAltitudeFt;
  const elevAt = (d: number) =>
    originElev + (destElev - originElev) * Math.min(1, Math.max(0, d / route.totalNm));
  const pathAlt = (d: number) => destElev + Math.max(0, route.totalNm - d) * PATH_FT_PER_NM;

  const rampKg = ofp.fuel.planRampKg;
  const taxiFlow = (ofp.fuel.taxiKg ?? 600) / taxiOutSec; // kg/s
  const airFlow = ofp.fuel.enrouteBurnKg / ofp.times.estTimeEnrouteSec; // kg/s

  // Mutable aircraft state.
  let t = options.startMs ?? ofp.times.schedOutMs - boardingSec * 1000;
  // `as` keeps the full union: `enter()` mutates it inside a closure, which TS can't track.
  let stage = 'GATE' as SyntheticStage;
  let stageSec = 0;
  let along = 0;
  let alt = originElev;
  let ias = 0;
  let gs = 0;
  let vs = 0;
  let onGround = true;
  let brake = true;
  let beacon = false;
  let gear = true;
  let flaps = 0;
  let xpdr = 1;
  let fuel = (options.refuel ?? true) ? Math.round(rampKg * 0.45) : rampKg;
  const refuelStart = fuel;
  const running: boolean[] = Array.from({ length: engineCount }, () => false);
  const n2: number[] = Array.from({ length: engineCount }, () => 0);
  const doors = [100, 0, 0, 0];
  let goAroundDone = false;
  // GO_AROUND legs: climb straight ahead → fly back away from the runway → turn inbound.
  let circuit: 'climb' | 'outbound' | 'inbound' = 'climb';

  const snapshots: TelemetrySnapshot[] = [];
  const stages: SyntheticStageMark[] = [];
  const enter = (next: SyntheticStage) => {
    stage = next;
    stageSec = 0;
  };

  const n2Target = (): number => {
    switch (stage) {
      case 'TAKEOFF_ROLL':
      case 'CLIMB':
      case 'GO_AROUND':
        return 88;
      case 'CRUISE':
        return 78;
      case 'DESCENT':
      case 'APPROACH':
        return 66;
      default:
        return 60;
    }
  };

  for (let guard = 0; ; guard++) {
    if (guard * dt > SAFETY_LIMIT_SEC) throw new Error('synthetic flight did not finish in 24 h');
    // --- stage logic: update controls and targets for this tick ---
    switch (stage) {
      case 'GATE': {
        const refuelEnd = boardingSec * 0.6;
        if (stageSec < refuelEnd) {
          fuel = Math.round(
            refuelStart + (rampKg - refuelStart) * Math.min(1, stageSec / refuelEnd),
          );
        } else fuel = rampKg;
        if (stageSec >= boardingSec - DOOR_CLOSE_BEFORE_PUSH_SEC) doors[0] = 0;
        if (stageSec >= boardingSec - BEACON_ON_BEFORE_PUSH_SEC) beacon = true;
        if (stageSec >= boardingSec) {
          brake = false;
          xpdr = 4;
          enter('PUSHBACK');
        }
        break;
      }
      case 'PUSHBACK': {
        gs = stageSec < PUSHBACK_SEC - 20 ? 3 : 0;
        if (gs === 0) brake = true;
        for (let i = 0; i < engineCount; i++) if (stageSec >= 40 + i * 30) running[i] = true;
        if (stageSec >= PUSHBACK_SEC && running.every(Boolean)) {
          brake = false;
          flaps = 2;
          enter('TAXI_OUT');
        }
        break;
      }
      case 'TAXI_OUT': {
        const left = taxiOutSec - PUSHBACK_SEC - stageSec;
        gs = left > 30 ? Math.min(TAXI_KT, gs + 2 * dt) : Math.max(0, gs - 2 * dt);
        if (left <= 0) enter('TAKEOFF_ROLL');
        break;
      }
      case 'TAKEOFF_ROLL': {
        gs = Math.min(ROTATE_KT, gs + 3 * dt);
        if (gs >= ROTATE_KT) {
          onGround = false;
          enter('CLIMB');
        }
        break;
      }
      case 'CLIMB': {
        vs = Math.min(CLIMB_FPM, vs + 150 * dt);
        const iasTarget = alt < 10000 ? 250 : 290;
        ias = Math.min(iasTarget, Math.max(ias, ROTATE_KT) + 2 * dt);
        if (alt - elevAt(along) > 300) gear = false;
        if (alt - elevAt(along) > 3000) flaps = 0;
        if (pathAlt(along) <= alt) enter('DESCENT');
        else if (alt >= cruiseAlt) {
          alt = cruiseAlt;
          vs = 0;
          enter('CRUISE');
        }
        break;
      }
      case 'CRUISE': {
        vs = 0;
        ias = Math.max(270, ias - 1 * dt);
        if (pathAlt(along) <= alt) enter('DESCENT');
        break;
      }
      case 'DESCENT':
      case 'APPROACH': {
        const target = stage === 'APPROACH' ? 140 : alt < 10000 ? 250 : 280;
        ias = ias > target ? Math.max(target, ias - 1.5 * dt) : target;
        if (stage === 'DESCENT' && alt - destElev < APPROACH_AGL_FT) {
          gear = true;
          flaps = 3;
          enter('APPROACH');
        }
        const ga = options.goAroundAglFt;
        if (stage === 'APPROACH' && ga !== undefined && !goAroundDone && alt - destElev < ga) {
          goAroundDone = true;
          circuit = 'climb';
          flaps = 2;
          enter('GO_AROUND');
          break;
        }
        if (along >= route.totalNm) {
          onGround = true;
          alt = destElev;
          vs = 0;
          flaps = 4;
          enter('ROLLOUT');
        }
        break;
      }
      case 'GO_AROUND': {
        const maAlt = destElev + MISSED_APPROACH_AGL_FT;
        ias = Math.min(180, ias + 2 * dt);
        if (stageSec > 5) gear = false;
        if (circuit === 'climb') {
          vs = Math.min(2000, vs + 300 * dt);
          if (alt >= maAlt) {
            alt = maAlt;
            vs = 0;
            circuit = 'outbound';
          }
        } else vs = 0;
        if (circuit === 'outbound' && route.totalNm - along >= CIRCUIT_OUTBOUND_NM) {
          circuit = 'inbound';
        }
        if (circuit === 'inbound' && pathAlt(along) <= alt) {
          gear = true;
          flaps = 3;
          enter('APPROACH');
        }
        break;
      }
      case 'ROLLOUT': {
        gs = Math.max(TAXI_KT, gs - 3 * dt);
        if (gs <= TAXI_KT) {
          flaps = 0;
          enter('TAXI_IN');
        }
        break;
      }
      case 'TAXI_IN': {
        const left = taxiInSec - stageSec;
        gs = left > 10 ? TAXI_KT : Math.max(0, gs - 2 * dt);
        if (left <= 0 && gs === 0) {
          brake = true;
          enter('PARKED');
        }
        break;
      }
      case 'PARKED': {
        if (stageSec >= 30) running.fill(false);
        if (stageSec >= 60) {
          beacon = false;
          xpdr = 1;
        }
        if (stageSec >= 90) doors[0] = 100;
        break;
      }
    }
    if (stage === 'PARKED' && stageSec > PARKED_SEC) break;

    // --- kinematics ---
    if (!onGround) {
      gs = tasKt(ias, alt);
      if (stage === 'DESCENT' || stage === 'APPROACH') {
        const nextAlong = along + (gs * dt) / 3600;
        const nextAlt = Math.max(destElev, Math.min(alt, pathAlt(nextAlong)));
        vs = ((nextAlt - alt) / dt) * 60;
      }
    } else {
      ias = gs;
      if (stage !== 'ROLLOUT' && stage !== 'TAKEOFF_ROLL') vs = 0;
    }
    for (let i = 0; i < engineCount; i++) {
      const target = running[i] ? n2Target() : 0;
      n2[i] = (n2[i] as number) + (target - (n2[i] as number)) * Math.min(1, dt / 8);
    }

    // --- emit ---
    if (stages.at(-1)?.stage !== stage) stages.push({ stage, index: snapshots.length, t });
    const backwards = stage === 'PUSHBACK' || (stage === 'GO_AROUND' && circuit === 'outbound');
    const { pos, course: track } = route.at(along);
    const course = stage === 'GO_AROUND' && circuit === 'outbound' ? (track + 180) % 360 : track;
    const jitter = (amp: number) => (noise && !onGround ? (rng.next() - 0.5) * 2 * amp : 0);
    const agl = onGround ? 0 : Math.max(0, alt - elevAt(along));
    snapshots.push({
      v: 1,
      t,
      lat: round(pos.lat, 6),
      lon: round(pos.lon, 6),
      altFt: Math.round(alt + jitter(10)),
      aglFt: Math.round(agl),
      iasKt: Math.round(ias + jitter(1)),
      gsKt: Math.round(gs),
      vsFpm: Math.round(vs + jitter(40)),
      hdgTrue: round(course + jitter(0.3), 1),
      onGround,
      parkingBrake: brake,
      beacon,
      engRunning: [...running],
      engN2: n2.map((x) => round(x, 1)),
      fuelKg: Math.round(fuel),
      gearDown: gear,
      flapsIdx: flaps,
      doorsOpen: [...doors],
      xpdrState: xpdr,
      simRate: 1,
      paused: false,
      aircraftTitle: title,
    });

    // --- integrate to next tick ---
    along += ((backwards ? -gs : gs) * dt) / 3600;
    if (!onGround) alt = Math.max(elevAt(along), alt + (vs * dt) / 60);
    if (running.some(Boolean)) fuel = Math.max(0, fuel - (onGround ? taxiFlow : airFlow) * dt);
    t += stepMs;
    stageSec += dt;
  }

  return { snapshots, stages };
}
