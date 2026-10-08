import { distanceNm, type LatLon } from '../geo/geo.js';
import type { Ofp } from '../ofp/types.js';
import type { FlightPhase, OooiKind } from '../phase/fsm.js';
import type { TelemetrySnapshot } from '../telemetry/types.js';
import type { Value } from './expr.js';
import type { FlightData } from './ops-data.js';

/**
 * Variables visible to scenario conditions and templates (docs/05: `ofp.*`, `tm.*`,
 * `phase`, `flight.*`, `aircraft.*`; `load.*` and `ops.*` from `ops-data.ts`, T07).
 * Names are snake_case and stable: scenarios depend on them. Masses kg, times epoch ms
 * UTC, distances NM, durations minutes. `wx.*` / `ext.*` arrive with the data adapters
 * (T13); until then `ofp.*_metar` is the METAR SimBrief put into the OFP.
 */
export const CONTEXT_VARIABLES = [
  'phase',
  // OFP
  'ofp.callsign',
  'ofp.flight',
  'ofp.airline',
  'ofp.orig',
  'ofp.dest',
  'ofp.orig_name',
  'ofp.dest_name',
  'ofp.orig_iata',
  'ofp.dest_iata',
  'ofp.orig_elev_ft',
  'ofp.dest_elev_ft',
  'ofp.orig_trans_alt_ft',
  'ofp.dest_trans_level_ft',
  'ofp.orig_metar',
  'ofp.dest_metar',
  'ofp.altn_metar',
  'ofp.orig_rwy',
  'ofp.dest_rwy',
  'ofp.altn',
  'ofp.route',
  'ofp.sid',
  'ofp.star',
  'ofp.cost_index',
  'ofp.cruise_alt_ft',
  'ofp.cruise_fl',
  'ofp.ac_icao',
  'ofp.ac_name',
  'ofp.ac_reg',
  'ofp.pax',
  'ofp.bags',
  'ofp.cargo_kg',
  'ofp.oew_kg',
  'ofp.payload_kg',
  'ofp.zfw_kg',
  'ofp.max_zfw_kg',
  'ofp.tow_kg',
  'ofp.max_tow_kg',
  'ofp.ldw_kg',
  'ofp.max_ldw_kg',
  'ofp.fuel_ramp_kg',
  'ofp.fuel_takeoff_kg',
  'ofp.fuel_burn_kg',
  'ofp.fuel_landing_kg',
  'ofp.fuel_taxi_kg',
  'ofp.fuel_cont_kg',
  'ofp.fuel_altn_kg',
  'ofp.fuel_reserve_kg',
  'ofp.fuel_extra_kg',
  'ofp.fuel_min_takeoff_kg',
  'ofp.sched_out',
  'ofp.sched_off',
  'ofp.sched_on',
  'ofp.sched_in',
  'ofp.est_out',
  'ofp.est_off',
  'ofp.est_on',
  'ofp.est_in',
  'ofp.block_time_min',
  'ofp.ete_min',
  // aircraft
  'aircraft.icao',
  'aircraft.cat',
  'aircraft.title',
  // telemetry
  'tm.alt_ft',
  'tm.agl_ft',
  'tm.ias_kt',
  'tm.gs_kt',
  'tm.vs_fpm',
  'tm.fuel_kg',
  'tm.on_ground',
  // flight (runtime)
  'flight.now',
  'flight.date',
  'flight.out',
  'flight.off',
  'flight.on',
  'flight.in',
  'flight.dist_to_dest_nm',
  'flight.dist_to_tod_nm',
  'flight.dist_from_orig_nm',
  'flight.minutes_to_tod',
  'flight.minutes_to_dest',
  'flight.minutes_to_sched_out',
  'flight.delay_min',
  'flight.minutes_since_off',
  'flight.eta',
  'flight.block_min',
  'flight.air_min',
  // final load (ops-data.ts)
  'load.pax',
  'load.pax_lmc',
  'load.cargo_kg',
  'load.cargo_lmc_kg',
  'load.lmc_kg',
  'load.zfw_kg',
  'load.tow_kg',
  'load.ldw_kg',
  'load.underload_kg',
  'load.lmc',
  // airline ops (ops-data.ts)
  'ops.slot_delay_min',
  'ops.ctot',
  'ops.arr_gate',
  'ops.belt',
  'ops.transfer_pax',
  'ops.turnaround_min',
  'ops.next_flight',
  'ops.next_std',
  'ops.cabin_crew',
] as const;

export type ContextVariable = (typeof CONTEXT_VARIABLES)[number];
export type ScenarioContext = Readonly<Record<ContextVariable, Value>>;

const KNOWN: ReadonlySet<string> = new Set(CONTEXT_VARIABLES);
export const isContextVariable = (path: string): path is ContextVariable => KNOWN.has(path);

/**
 * Remaining route distance: min over navlog fixes of (direct to the fix + route after
 * it). Exact when the next fix is ahead on the route, never below the true value
 * (triangle inequality), robust to being off track.
 */
export class RouteGeometry {
  private readonly fixes: readonly (LatLon & { readonly rest: number })[];
  /** Route distance from TOD to destination; null when the navlog has no TOD. */
  private readonly todToDestNm: number | null;
  readonly totalNm: number;

  constructor(ofp: Ofp) {
    const last = ofp.navlog.at(-1);
    this.totalNm = last?.cumDistNm ?? distanceNm(ofp.origin, ofp.destination);
    this.fixes = [
      ...ofp.navlog.map((f) => ({ lat: f.lat, lon: f.lon, rest: this.totalNm - f.cumDistNm })),
      { lat: ofp.destination.lat, lon: ofp.destination.lon, rest: 0 },
    ];
    // `[ПРОВЕРИТЬ]` docs/04: TOD is the navlog fix with ident "TOD" (type ltlg) in json=v2.
    const tod = ofp.navlog.find((f) => f.ident === 'TOD');
    this.todToDestNm = tod === undefined ? null : this.totalNm - tod.cumDistNm;
  }

  remainingNm(pos: LatLon): number {
    let best = Number.POSITIVE_INFINITY;
    for (const f of this.fixes) best = Math.min(best, distanceNm(pos, f) + f.rest);
    return best;
  }

  /** Route distance to TOD; negative after it. Null without TOD in the navlog. */
  toTodNm(pos: LatLon): number | null {
    return this.todToDestNm === null ? null : this.remainingNm(pos) - this.todToDestNm;
  }
}

export interface ContextInput {
  readonly ofp: Ofp;
  readonly route: RouteGeometry;
  readonly now: number;
  readonly phase: FlightPhase;
  readonly telemetry: TelemetrySnapshot | null;
  readonly oooi: Readonly<Record<OooiKind, number | null>>;
  readonly data: FlightData;
  /** Late-start delay (engine), ms. */
  readonly delayMs?: number;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const minutes = (ms: number) => Math.round(ms / 60_000);

export function buildContext(input: ContextInput): ScenarioContext {
  const { ofp, route, now, telemetry: tm, oooi } = input;
  const { load, ops } = input.data;
  const span = (a: number | null, b: number | null) =>
    a === null || b === null ? null : minutes(b - a);
  const w = ofp.weights;
  const f = ofp.fuel;
  const t = ofp.times;
  const toDest = tm === null ? null : route.remainingNm(tm);
  const toTod = tm === null ? null : route.toTodNm(tm);
  // Ground speed below 60 kt (taxi, gate) is no basis for an ETA.
  const gs = tm !== null && tm.gsKt >= 60 ? tm.gsKt : null;
  const eta = (nm: number | null) =>
    nm === null || gs === null ? null : Math.round((nm / gs) * 60);
  const block = t.schedBlockSec ?? (t.schedInMs - t.schedOutMs) / 1000;

  return {
    phase: input.phase,
    'ofp.callsign': ofp.callsign,
    'ofp.flight': ofp.flightNumber,
    'ofp.airline': ofp.airlineIcao,
    'ofp.orig': ofp.origin.icao,
    'ofp.dest': ofp.destination.icao,
    'ofp.orig_name': ofp.origin.name,
    'ofp.dest_name': ofp.destination.name,
    'ofp.orig_iata': ofp.origin.iata,
    'ofp.dest_iata': ofp.destination.iata,
    'ofp.orig_elev_ft': ofp.origin.elevationFt,
    'ofp.dest_elev_ft': ofp.destination.elevationFt,
    'ofp.orig_trans_alt_ft': ofp.origin.transAltFt,
    'ofp.dest_trans_level_ft': ofp.destination.transLevelFt,
    'ofp.orig_metar': ofp.origin.metar,
    'ofp.dest_metar': ofp.destination.metar,
    'ofp.altn_metar': ofp.alternates[0]?.metar ?? null,
    'ofp.orig_rwy': ofp.origin.planRwy,
    'ofp.dest_rwy': ofp.destination.planRwy,
    'ofp.altn': ofp.alternates[0]?.icao ?? null,
    'ofp.route': ofp.route,
    'ofp.sid': ofp.sid,
    'ofp.star': ofp.star,
    'ofp.cost_index': ofp.costIndex,
    'ofp.cruise_alt_ft': ofp.initialAltitudeFt,
    'ofp.cruise_fl': Math.round(ofp.initialAltitudeFt / 100),
    'ofp.ac_icao': ofp.aircraft.icao,
    'ofp.ac_name': ofp.aircraft.name,
    'ofp.ac_reg': ofp.aircraft.reg,
    'ofp.pax': w.paxCount,
    'ofp.bags': w.bagCount,
    'ofp.cargo_kg': w.cargoKg,
    'ofp.oew_kg': w.oewKg,
    'ofp.payload_kg': w.payloadKg,
    'ofp.zfw_kg': w.estZfwKg,
    'ofp.max_zfw_kg': w.maxZfwKg,
    'ofp.tow_kg': w.estTowKg,
    'ofp.max_tow_kg': w.maxTowKg,
    'ofp.ldw_kg': w.estLdwKg,
    'ofp.max_ldw_kg': w.maxLdwKg,
    'ofp.fuel_ramp_kg': f.planRampKg,
    'ofp.fuel_takeoff_kg': f.planTakeoffKg,
    'ofp.fuel_burn_kg': f.enrouteBurnKg,
    'ofp.fuel_landing_kg': f.planLandingKg,
    'ofp.fuel_taxi_kg': f.taxiKg,
    'ofp.fuel_cont_kg': f.contingencyKg,
    'ofp.fuel_altn_kg': f.alternateBurnKg,
    'ofp.fuel_reserve_kg': f.reserveKg,
    'ofp.fuel_extra_kg': f.extraKg,
    'ofp.fuel_min_takeoff_kg': f.minTakeoffKg,
    'ofp.sched_out': t.schedOutMs,
    'ofp.sched_off': t.schedOffMs,
    'ofp.sched_on': t.schedOnMs,
    'ofp.sched_in': t.schedInMs,
    'ofp.est_out': t.estOutMs,
    'ofp.est_off': t.estOffMs,
    'ofp.est_on': t.estOnMs,
    'ofp.est_in': t.estInMs,
    'ofp.block_time_min': Math.round(block / 60),
    'ofp.ete_min': Math.round(t.estTimeEnrouteSec / 60),
    'aircraft.icao': ofp.aircraft.icao,
    'aircraft.cat': ofp.aircraft.wakeCategory,
    'aircraft.title': tm?.aircraftTitle ?? null,
    'tm.alt_ft': tm?.altFt ?? null,
    'tm.agl_ft': tm?.aglFt ?? null,
    'tm.ias_kt': tm?.iasKt ?? null,
    'tm.gs_kt': tm?.gsKt ?? null,
    'tm.vs_fpm': tm?.vsFpm ?? null,
    'tm.fuel_kg': tm?.fuelKg ?? null,
    'tm.on_ground': tm?.onGround ?? null,
    'flight.now': now,
    'flight.date': t.schedOutMs,
    'flight.out': oooi.OUT,
    'flight.off': oooi.OFF,
    'flight.on': oooi.ON,
    'flight.in': oooi.IN,
    'flight.dist_to_dest_nm': toDest === null ? null : r1(toDest),
    'flight.dist_to_tod_nm': toTod === null ? null : r1(toTod),
    'flight.dist_from_orig_nm': tm === null ? null : r1(distanceNm(tm, ofp.origin)),
    'flight.minutes_to_tod': toTod === null || toTod < 0 ? null : eta(toTod),
    'flight.minutes_to_dest': eta(toDest),
    'flight.minutes_to_sched_out': minutes(t.schedOutMs - now),
    'flight.delay_min': minutes(input.delayMs ?? 0),
    'flight.minutes_since_off': oooi.OFF === null ? null : minutes(now - oooi.OFF),
    // Planned en-route time after the actual take-off; no wind model here.
    'flight.eta': oooi.OFF === null ? null : oooi.OFF + t.estTimeEnrouteSec * 1000,
    'flight.block_min': span(oooi.OUT, oooi.IN),
    'flight.air_min': span(oooi.OFF, oooi.ON),
    'load.pax': load.pax,
    'load.pax_lmc': load.paxLmc,
    'load.cargo_kg': load.cargoKg,
    'load.cargo_lmc_kg': load.cargoLmcKg,
    'load.lmc_kg': load.lmcKg,
    'load.zfw_kg': load.zfwKg,
    'load.tow_kg': load.towKg,
    'load.ldw_kg': load.ldwKg,
    'load.underload_kg': load.underloadKg,
    'load.lmc': load.lmc,
    'ops.slot_delay_min': ops.slotDelayMin,
    'ops.ctot': ops.ctot,
    'ops.arr_gate': ops.arrGate,
    'ops.belt': ops.belt,
    'ops.transfer_pax': ops.transferPax,
    'ops.turnaround_min': ops.turnaroundMin,
    'ops.next_flight': ops.nextFlight,
    'ops.next_std': ops.nextStd,
    'ops.cabin_crew': ops.cabinCrew,
  };
}
