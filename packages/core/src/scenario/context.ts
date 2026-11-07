// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { isAcdmAirport } from '../ext/acdm-airports.js';
import { airlineCountry, airlineType } from '../ext/airline.js';
import {
  CONNEX_ATTRIBUTION,
  CONNEX_LIST_MAX,
  connexCandidates,
  connexGate,
  pickConnection,
} from '../ext/connex.js';
import {
  ATC_MAX_AGE_MS,
  type ExtState,
  type LaunchStatus,
  liveWx,
  type RoutePolyline,
  sortStations,
} from '../ext/data.js';
import { notamText, notamTime, selectNotams } from '../ext/notam.js';
import { distanceNm, type LatLon } from '../geo/geo.js';
import type { Ofp, OfpFix } from '../ofp/types.js';
import type { FlightPhase, OooiKind } from '../phase/fsm.js';
import type { TelemetrySnapshot } from '../telemetry/types.js';
import { type AircraftFamily, aircraftInfo, aircraftVariables } from './aircraft.js';
import { type DelayPart, delayLine } from './delay-codes.js';
import { airportHere, airportPlace, pickDivert, type RunwayNeed } from './divert.js';
import type { Value } from './expr.js';
import { classifyFlight, type FlightKind } from './flight-kind.js';
import type { IrregularData } from './irregular-data.js';
import { countryRegion, MULTINATIONAL_AIRLINES } from './names.js';
import type { FlightData } from './ops-data.js';
import { SPECIAL_VARIABLES, type SpecialVariable, specialVariables } from './special-vars.js';

/**
 * Variables visible to scenario conditions and templates (docs/05: `ofp.*`, `tm.*`,
 * `phase`, `flight.*`, `aircraft.*`; `load.*` and `ops.*` from `ops-data.ts`, T07).
 * Names are snake_case and stable: scenarios depend on them. Masses kg, times epoch ms
 * UTC, distances NM, durations minutes. `wx.*` / `ext.*` come from the data adapters
 * (T13, `ext/data.ts`); `ofp.*_metar` stays the METAR SimBrief put into the OFP.
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
  // company NOTAM summary (T95, ext/notam.ts): items in force at the ETA or `NIL SIGNIFICANT`
  // (`ofp.notam_altn` null without an alternate); `ofp.notam_count` items of both
  'ofp.notam_dest',
  'ofp.notam_altn',
  'ofp.notam_count',
  // when SimBrief made the OFP (epoch ms): the NOTAM are as of then
  'ofp.release',
  'ofp.orig_rwy',
  'ofp.dest_rwy',
  'ofp.altn',
  'ofp.route',
  'ofp.sid',
  // The origin has fully implemented A-CDM (T102, ext/acdm-airports.ts)
  'ofp.orig_acdm',
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
  // SimBrief TLR for the planned runway and OFP crew counts (T43): `perfVariables`
  'ofp.to_flaps',
  'ofp.to_thrust',
  'ofp.v1',
  'ofp.vr',
  'ofp.v2',
  'ofp.ldg_flaps',
  'ofp.vref',
  'ofp.crew_cockpit',
  'ofp.crew_cabin',
  // airline type (T43, ext/airline.ts): LCC / HUB / OTHER
  'ofp.airline_type',
  // person names (T43, names.ts): surname region and mix of nationalities
  'names.region',
  'names.mix',
  // mass units of the messages (T105): KG / LB and the label of big figures (TONNES / 1000 LBS)
  'units.mass',
  'units.mass_big',
  // aircraft
  'aircraft.icao',
  'aircraft.cat',
  'aircraft.family',
  'aircraft.maker',
  'aircraft.body',
  'aircraft.alert_sys',
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
  // T102: the airline's TOBT (sched_out + delay without the ATFM slot), epoch ms; minutes to it,
  // rounded up (0 from the TOBT on, negative after it)
  'flight.tobt',
  'flight.minutes_to_tobt',
  // T103: minutes to `ofp.est_out` (ETD, all delays incl. the slot), rounded up like the TOBT's
  'flight.minutes_to_etd',
  // MVT delay element at OUT (T43, delay-codes.ts): `DL81/63/0025/0010`; null on time / before OUT
  'flight.delay_codes',
  'flight.minutes_since_off',
  'flight.eta',
  'flight.eta_live',
  'flight.block_min',
  'flight.air_min',
  'flight.divert',
  // kind of flight (T89, flight-kind.ts): `sched_pax`, `cargo` …
  'flight.kind',
  // empty text when passengers may be in the cabin, null on a cargo or ferry flight with the kind
  // filter on (T90/T91): `~PAX CARE ARRANGED{flight.if_pax}` leaves the line out
  'flight.if_pax',
  // the opposite: empty text on a cargo or ferry flight with the filter on, else null
  'flight.if_no_pax',
  'flight.sent',
  // distance to the diversion airport when its position is known (T51), NM
  'flight.divert_nm',
  // holding announced by a scenario (`set: flight.hold`, T48) and whether the fuel has come down
  // to the diversion minimum (T50); false when not holding
  'flight.holding',
  'flight.hold_fuel_low',
  // nearest airport of the OFP (origin, alternates) to the aircraft (T14), a reserve airport when
  // that one is far (T50, divert.ts), null without position
  'flight.nearest_altn',
  'flight.nearest_altn_nm',
  // nearest of those and the reserve airports (T50): MAYDAY, fire
  'flight.nearest_any',
  'flight.nearest_any_nm',
  // on the ground (before OFF or after ON): the airport of the flight within 5 NM (T88,
  // divert.ts `airportHere`); null in the air or when none is that close
  'flight.here',
  // the run's last pilot answer (`wait: reply`), null before one
  'reply.option',
  'reply.text',
  'reply.arg',
  'reply.timeout',
  // the airport a DIVERT reply named, if the core knows it (T51); the rest of the reply is reply.arg
  'reply.icao',
  // a DIVERT reply named the placeholder ZZZZ: an airport that does not exist (T51)
  'reply.unknown',
  // minutes of flight time since the run entered its `loop` (T50), null outside one
  'loop.min',
  // the pilot command that started the run (`on: command`), null otherwise
  'cmd.name',
  'cmd.text',
  'cmd.icao',
  'cmd.minutes',
  'cmd.reason',
  'cmd.metar',
  'cmd.taf',
  'cmd.wx_live',
  'cmd.wx_obs',
  'cmd.atis',
  'cmd.atis_code',
  // `REQ NOTAM [ICAO]` (T95): the summary of an airport of the OFP or `NIL SIGNIFICANT`; null
  // for any other airport
  'cmd.notam',
  'cmd.gate',
  'cmd.new_gate',
  'cmd.divert_nm',
  'cmd.divert_eta',
  // weather (T13): `*_metar` live METAR, else the OFP one; `*_live` true for a live one;
  // `*_obs` its observation time; `*_taf` live TAF only
  'wx.orig_metar',
  'wx.orig_taf',
  'wx.orig_live',
  'wx.orig_obs',
  'wx.dest_metar',
  'wx.dest_taf',
  'wx.dest_live',
  'wx.dest_obs',
  'wx.altn_metar',
  'wx.altn_taf',
  'wx.altn_live',
  'wx.altn_obs',
  // temperature °C from the METAR above (live or OFP), T14
  'wx.orig_temp_c',
  'wx.dest_temp_c',
  // wind of the destination METAR (T33): `from` degrees true, speed kt, and the compass point
  // smoke drifts to (the reciprocal); null for calm, variable (VRB) or no METAR
  'wx.dest_wind_from',
  'wx.dest_wind_kt',
  'wx.dest_smoke_drift',
  // VATSIM (T13): `*_atc` lines `CALLSIGN FREQ`, null when none online or no data;
  // `*_atc_count` null without data
  'ext.orig_atc',
  'ext.orig_atc_count',
  'ext.dest_atc',
  'ext.dest_atc_count',
  'ext.dest_atis',
  // the next natural event (EONET) ahead on the route, within 150 NM of it
  'ext.event_id',
  'ext.event_title',
  'ext.event_category',
  'ext.event_ahead_nm',
  'ext.event_off_nm',
  // the next space launch (TheSpaceDevs, T28) ahead on the route, pad within 300 NM of it,
  // in the time window of the flight: `go` from now to the ETA, happened since take-off
  'ext.launch_id',
  'ext.launch_rocket',
  'ext.launch_mission',
  'ext.launch_pad',
  'ext.launch_net',
  'ext.launch_window_start',
  'ext.launch_window_end',
  'ext.launch_status',
  'ext.launch_done',
  'ext.launch_ahead_nm',
  'ext.launch_off_nm',
  // onward departures of the airline (T30, AeroDataBox)
  'ext.connex_list',
  'ext.connex_count',
  // special events (T29): `special-vars.ts`
  ...SPECIAL_VARIABLES,
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
  'ops.next_orig',
  'ops.next_dest',
  'ops.next_std',
  'ops.next_src',
  // name of a ferry permit (T91): `SPECIAL FLIGHT PERMIT` for a US registration (N + digit;
  // 14 CFR 21.197), else `PERMIT TO FLY` (EASA Part 21, 21.A.701); approved by the user 2026-11-04
  'ops.ferry_permit',
  // the next leg is a real departure of the airline (AeroDataBox FIDS, T55 level 1), not a route
  // of the statistics with a made-up number (T91)
  'ops.next_real',
  // a flight into the US from outside (T92, eAPIS arrival manifest, 19 CFR 122.22): destination
  // ICAO K, PA (Alaska) or PH (Hawaii), origin not; approved by the user 2026-11-04
  'ops.us_arrival',
  'flight.fuel_stable',
  'flight.fuel_before_kg',
  'flight.fuel_uplift_kg',
  'flight.fuel_diff_kg',
  'flight.fuel_below_plan_kg',
  'flight.fuel_plan_tol_kg',
  'flight.touchdown_fpm',
  'ops.turn_avail_min',
  'ops.ctot_ready',
  'ops.slot_missed',
  'ops.rdy_window',
  'ops.rdy_better',
  'ops.gate_known',
  'ops.gate_place',
  'ops.gate_line',
  'ops.gate_expected',
  'ops.ground_support',
  'ops.quick_turn',
  'ops.cabin_crew',
  // irregular-scenario data (T14, irregular-data.ts); `*_margin_min` against the estimates
  // (the delay included), negative = too late
  'irr.curfew',
  'irr.curfew_local',
  'irr.curfew_margin_min',
  'irr.connect_flight',
  'irr.connect_std',
  'irr.connect_pax',
  'irr.connect_margin_min',
  'irr.connect_left_min',
  'irr.connect_dest',
  'irr.connect_gate',
  'irr.connect_src',
  'irr.tanker_kg',
  'irr.tanker_block_kg',
  'irr.tanker_ldw_kg',
  'irr.flow_delay_min',
  'irr.revised_ctot',
  'irr.latest_out',
  'irr.new_gate',
  'irr.lost_bags',
  'irr.crew_change_min',
  'irr.crew_ready',
] as const;

export type ContextVariable = (typeof CONTEXT_VARIABLES)[number];
export type ScenarioContext = Readonly<Record<ContextVariable, Value>>;

const KNOWN: ReadonlySet<string> = new Set(CONTEXT_VARIABLES);
/** `flags.<name>` (T14): set by scenarios, kept across flights; null when not set. */
const FLAG = /^flags\.[a-z][a-z0-9_]{0,39}$/;
export const isFlagVariable = (path: string): boolean => FLAG.test(path);
/** `run.<name>` (T50): values a `draw` step gave this run; null for a name not drawn. */
const RUN = /^run\.[a-z][a-z0-9_]{0,39}$/;
export const isRunVariable = (path: string): boolean => RUN.test(path);
export const isContextVariable = (path: string): boolean =>
  KNOWN.has(path) || FLAG.test(path) || RUN.test(path);

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
  /** Late-start delay plus pilot `DELAY`s (engine), ms. */
  readonly delayMs?: number;
  /** The airline's part of {@link delayMs}, without the ATFM slot (T102, TOBT); absent = all. */
  readonly tobtDelayMs?: number;
  /** Generator of `{name:…}` (T43): 1 = by the origin's ICAO prefix, 2 = by the airline. */
  readonly namesVersion?: 1 | 2;
  /** Mass unit of the messages (T105); absent = `kg`, as recorded before T105. */
  readonly massUnit?: MassUnitOption;
  /** What the delay is made of (T43). */
  readonly delayParts?: readonly DelayPart[];
  /** Diversion airport the pilot declared (`DIVERT`), engine. */
  readonly divert?: string | null;
  /** Kind of flight in force (T89), engine; absent = recognized from the OFP. */
  readonly flightKind?: FlightKind;
  /** The kind filter is on (T89 option `flightKind`): the texts follow the kind (T90/T91). */
  readonly kindFilter?: boolean;
  /** Runway needs by family instead of the table of `divert.ts` (tests, T50). */
  readonly runwayNeeds?: Readonly<Partial<Record<AircraftFamily, RunwayNeed>>>;
  /** Holding announced by a scenario (T48), engine. */
  readonly hold?: { readonly since: number; readonly min: number } | null;
  /** Ids of the scenarios that sent something in this flight, first send first. */
  readonly sent?: readonly string[];
  /** External data (T13). */
  readonly ext?: ExtState;
  /** Fuel seen before OUT (T43). */
  readonly fuel?: FuelTrack | null;
  /** Descent rate at the touchdown of this flight, ft/min (T46); null = none seen. */
  readonly touchdownFpm?: number | null;
  /** Irregular-scenario data and the gate a reassignment would move to (T14). */
  readonly irr?: IrregularData & {
    readonly newGate: string | null;
    /** A source confirmed the onward flight (T43); none exists yet. */
    readonly connectKnown: boolean;
  };
  readonly polyline?: RoutePolyline;
  /** Flight seed (T29: the "on this day" fact of several). */
  readonly seed?: number | string;
}

/** Fuel on board before OUT, see `ScenarioEngine.trackFuel` (T43). */
export interface FuelTrack {
  readonly first: number;
  readonly anchor: number;
  /** When `anchor` was reached, epoch ms. */
  readonly since: number;
  /** The level changed after the first reading, i.e. a refuelling was seen. */
  readonly changed: boolean;
}

/** Per-run variables (`reply.*`, `cmd.*`): null in the shared context, set by the engine. */
export const RUN_VARIABLES = [
  'reply.option',
  'reply.text',
  'reply.arg',
  'reply.timeout',
  'reply.icao',
  'reply.unknown',
  'loop.min',
  'cmd.name',
  'cmd.text',
  'cmd.icao',
  'cmd.minutes',
  'cmd.reason',
  'cmd.metar',
  'cmd.taf',
  'cmd.wx_live',
  'cmd.wx_obs',
  'cmd.atis',
  'cmd.atis_code',
  'cmd.notam',
  'cmd.gate',
  'cmd.new_gate',
  'cmd.divert_nm',
  'cmd.divert_eta',
] as const satisfies readonly ContextVariable[];
export type RunVariable = (typeof RUN_VARIABLES)[number];

/** Diversion fuel minimum is this much more than `alternate_burn + reserve` (T50, game number). */
const HOLD_FUEL_MARGIN = 1.1;

/**
 * The aircraft in a holding has come down to the diversion minimum (T50): the fuel on board is at
 * most `alternate_burn + reserve` of the OFP plus 10 %. Without a fuel reading — the plan's
 * margin for the holding, `extra + contingency` at the average en-route burn, used up. False when
 * not holding; null when the OFP lacks the figures.
 */
export function holdFuelLow(
  ofp: Ofp,
  tm: TelemetrySnapshot | null,
  hold: { readonly since: number } | null,
  now: number,
): boolean | null {
  if (hold === null) return false;
  const f = ofp.fuel;
  if (tm !== null && tm.fuelKg > 0) {
    if (f.alternateBurnKg === null || f.reserveKg === null) return null;
    return tm.fuelKg <= (f.alternateBurnKg + f.reserveKg) * HOLD_FUEL_MARGIN;
  }
  const hours = ofp.times.estTimeEnrouteSec / 3600;
  if (hours <= 0 || f.enrouteBurnKg <= 0) return null;
  const spare = (f.extraKg ?? 0) + (f.contingencyKg ?? 0);
  return (now - hold.since) / 3_600_000 >= spare / (f.enrouteBurnKg / hours);
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const minutes = (ms: number) => Math.round(ms / 60_000);

/** US airports for `ops.us_arrival` (T92): ICAO K (contiguous US), PA (Alaska), PH (Hawaii). */
const US_AIRPORT = /^(K|PA|PH)/;

export function buildContext(input: ContextInput): ScenarioContext {
  const { ofp, route, now, telemetry: tm, oooi } = input;
  const { load, ops } = input.data;
  const span = (a: number | null, b: number | null) =>
    a === null || b === null ? null : minutes(b - a);
  const w = ofp.weights;
  const f = ofp.fuel;
  const t = ofp.times;
  const kind = input.flightKind ?? classifyFlight(ofp).kind;
  const noPax = input.kindFilter === true && (kind === 'cargo' || kind === 'ferry');
  const toDest = tm === null ? null : route.remainingNm(tm);
  const toTod = tm === null ? null : route.toTodNm(tm);
  // Ground speed below 60 kt (taxi, gate) is no basis for an ETA.
  const gs = tm !== null && tm.gsKt >= 60 ? tm.gsKt : null;
  const eta = (nm: number | null) =>
    nm === null || gs === null ? null : Math.round((nm / gs) * 60);
  const block = t.schedBlockSec ?? (t.schedInMs - t.schedOutMs) / 1000;
  const tobt = t.schedOutMs + (input.tobtDelayMs ?? input.delayMs ?? 0);

  return mergeParts(
    {
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
      'ofp.orig_acdm': isAcdmAirport(ofp.origin.icao),
      'ofp.star': ofp.star,
      'ofp.cost_index': ofp.costIndex,
      'ofp.cruise_alt_ft': ofp.initialAltitudeFt,
      'ofp.cruise_fl': Math.round(ofp.initialAltitudeFt / 100),
      'ofp.ac_icao': ofp.aircraft.icao,
      'ofp.ac_name': ofp.aircraft.name,
      'ofp.ac_reg': ofp.aircraft.reg,
      'ofp.pax': w.paxCount,
      'ofp.bags': w.bagCount,
    },
    {
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
    },
    {
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
      'flight.tobt': tobt,
      'flight.minutes_to_tobt': Math.ceil((tobt - now) / 60_000),
      'flight.minutes_to_etd': Math.ceil((t.estOutMs - now) / 60_000),
      'flight.delay_codes':
        oooi.OUT === null
          ? null
          : delayLine(
              input.delayParts ?? [],
              Math.floor((oooi.OUT - ofp.times.schedOutMs) / 60_000),
            ),
      'flight.minutes_since_off': oooi.OFF === null ? null : minutes(now - oooi.OFF),
      // Planned en-route time after the actual take-off; no wind model here.
      'flight.eta': oooi.OFF === null ? null : oooi.OFF + t.estTimeEnrouteSec * 1000,
      'flight.block_min': span(oooi.OUT, oooi.IN),
      'flight.air_min': span(oooi.OFF, oooi.ON),
      'flight.divert': input.divert ?? null,
      'flight.kind': kind,
      'flight.if_pax': noPax ? null : '',
      'flight.if_no_pax': noPax ? '' : null,
      'flight.holding': input.hold != null,
      'flight.hold_fuel_low': holdFuelLow(ofp, tm, input.hold ?? null, now),
      'flight.sent': [...(input.sent ?? [])],
      'reply.option': null,
      'reply.text': null,
    },
    {
      'reply.arg': null,
      'reply.timeout': null,
      'reply.icao': null,
      'reply.unknown': null,
      'loop.min': null,
      'cmd.name': null,
      'cmd.text': null,
      'cmd.icao': null,
      'cmd.minutes': null,
      'cmd.reason': null,
      'cmd.metar': null,
      'cmd.taf': null,
      'cmd.wx_live': null,
      'cmd.wx_obs': null,
      'cmd.atis': null,
      'cmd.atis_code': null,
      'cmd.notam': null,
      'cmd.gate': null,
      'cmd.new_gate': null,
      'cmd.divert_nm': null,
      'cmd.divert_eta': null,
      ...notamVariables(input),
      ...extVariables(input),
      ...specialVariables(input),
      ...aircraftVariables(ofp.aircraft.icao),
      ...irrVariables(input),
      ...t4344Variables(input, toDest, gs),
      ...gateVariables(input),
      ...fuelVariables(input),
      ...t46Variables(input),
      ...perfVariables(ofp),
      ...nameVariables(input),
      ...unitVariables(input),
      'ofp.airline_type': airlineType(ofp.airlineIcao),
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
    },
    {
      'ops.arr_gate': ops.arrGate,
      'ops.belt': ops.belt,
      // Transfer passengers on a scheduled flight only (T91: none on a charter, T90: cargo).
      'ops.transfer_pax':
        input.kindFilter === true && kind !== 'sched_pax' ? null : ops.transferPax,
      'ops.turnaround_min': ops.turnaroundMin,
      'ops.next_flight': ops.nextFlight,
      'ops.next_orig': ops.nextOrig,
      'ops.next_dest': ops.nextDest,
      'ops.next_std': ops.nextStd,
      // C4 (T55): attribution line of a message with the AeroDataBox next leg; empty otherwise.
      'ops.next_src': ops.nextLive === null ? '' : CONNEX_ATTRIBUTION,
      'ops.next_real': ops.nextLive === 'fids',
      'ops.us_arrival': US_AIRPORT.test(ofp.destination.icao) && !US_AIRPORT.test(ofp.origin.icao),
      'ops.ferry_permit': /^N[0-9]/.test(ofp.aircraft.reg ?? '')
        ? 'SPECIAL FLIGHT PERMIT'
        : 'PERMIT TO FLY',
      'ops.cabin_crew': ops.cabinCrew,
    },
  );
}

const EVENT_CATEGORY: Readonly<Record<string, string>> = {
  severeStorms: 'SEVERE STORM',
  wildfires: 'WILDFIRE',
  volcanoes: 'VOLCANO',
  earthquakes: 'EARTHQUAKE',
  manmade: 'MANMADE EVENT',
  dustHaze: 'DUST AND HAZE',
  floods: 'FLOOD',
};

/** `ext.launch_status` texts. */
const LAUNCH_STATUS_TEXT: Readonly<Record<LaunchStatus, string>> = {
  go: 'GO FOR LAUNCH',
  in_flight: 'IN FLIGHT',
  success: 'SUCCESSFUL',
  deployed: 'SUCCESSFUL',
  failure: 'FAILURE',
  partial_failure: 'PARTIAL FAILURE',
};

type ExtVariable = Exclude<
  Extract<ContextVariable, `wx.${string}` | `ext.${string}`>,
  SpecialVariable
>;

/** `wx.*` and `ext.*` from the external data (T13); null where there is none. */
function extVariables(input: ContextInput): Record<ExtVariable, Value> {
  const { ofp, now, ext, telemetry: tm } = input;
  const wx = (icao: string | null, ofpMetar: string | null) => {
    const live = ext === undefined ? null : liveWx(ext, icao, now);
    return {
      metar: live?.metar ?? ofpMetar,
      taf: live?.taf ?? null,
      live: live?.metar != null,
      obs: live?.metar != null ? live.obsTime : null,
    };
  };
  const o = wx(ofp.origin.icao, ofp.origin.metar);
  const d = wx(ofp.destination.icao, ofp.destination.metar);
  const altn = ofp.alternates[0];
  const a = wx(altn?.icao ?? null, altn?.metar ?? null);

  const atcFresh =
    ext !== undefined && ext.atc !== null && ext.atcT !== null && now - ext.atcT <= ATC_MAX_AGE_MS;
  const atc = (icao: string) => {
    if (!atcFresh) return { lines: null, count: null, atis: null };
    const list = sortStations(ext.atc?.[icao] ?? []);
    const lines = list.map((s) => `${s.callsign} ${s.frequency}`).join('\n');
    const atis = list.find((s) => s.facility === 'ATIS')?.atisCode ?? null;
    return { lines: lines === '' ? null : lines, count: list.length, atis };
  };
  const oAtc = atc(ofp.origin.icao);
  const dAtc = atc(ofp.destination.icao);

  // The first event ahead of the aircraft (before take-off: from the origin).
  let ev: { id: string; title: string; category: string; ahead: number; off: number } | null = null;
  if (ext !== undefined && ext.events.length > 0 && input.polyline !== undefined) {
    const flown = tm === null ? 0 : input.polyline.locate(tm).alongNm;
    const next = ext.events.find((e) => e.alongNm >= flown);
    if (next !== undefined) {
      ev = {
        id: next.id,
        title: next.title,
        category: EVENT_CATEGORY[next.category] ?? next.category.toUpperCase(),
        ahead: next.alongNm - flown,
        off: next.offNm,
      };
    }
  }

  // The first launch ahead in the time window of the flight (T28, docs/07): a `go` launch
  // whose window has not closed and whose T-0 is before the ETA; a launch that has happened
  // since take-off (since now before it). Before take-off the whole route is ahead.
  let ln: (NonNullable<ExtState['launches']>[number] & { ahead: number }) | null = null;
  if (ext?.launches !== undefined && ext.launches.length > 0 && input.polyline !== undefined) {
    const flown = tm === null ? 0 : input.polyline.locate(tm).alongNm;
    const toDest = tm === null ? null : input.route.remainingNm(tm);
    const gs = tm !== null && tm.gsKt >= 60 ? tm.gsKt : null;
    const eta =
      toDest !== null && gs !== null
        ? now + (toDest / gs) * 3_600_000
        : (input.oooi.OFF ?? now) + ofp.times.estTimeEnrouteSec * 1000;
    const since = input.oooi.OFF ?? now;
    const next = ext.launches.find((l) => {
      if (l.alongNm < flown) return false;
      if (l.status === 'go') return (l.windowEnd ?? l.net) >= now && l.net <= eta;
      return l.net >= since && l.net <= now;
    });
    if (next !== undefined) ln = { ...next, ahead: next.alongNm - flown };
  }

  return {
    'wx.orig_metar': o.metar,
    'wx.orig_taf': o.taf,
    'wx.orig_live': o.live,
    'wx.orig_obs': o.obs,
    'wx.dest_metar': d.metar,
    'wx.dest_taf': d.taf,
    'wx.dest_live': d.live,
    'wx.dest_obs': d.obs,
    'wx.altn_metar': a.metar,
    'wx.altn_taf': a.taf,
    'wx.altn_live': a.live,
    'wx.altn_obs': a.obs,
    'wx.orig_temp_c': metarTempC(o.metar),
    'wx.dest_temp_c': metarTempC(d.metar),
    'wx.dest_wind_from': metarWind(d.metar)?.from ?? null,
    'wx.dest_wind_kt': metarWind(d.metar)?.kt ?? null,
    'wx.dest_smoke_drift': smokeDrift(d.metar),
    'ext.orig_atc': oAtc.lines,
    'ext.orig_atc_count': oAtc.count,
    'ext.dest_atc': dAtc.lines,
    'ext.dest_atc_count': dAtc.count,
    'ext.dest_atis': dAtc.atis,
    'ext.event_id': ev?.id ?? null,
    'ext.event_title': ev?.title ?? null,
    'ext.event_category': ev?.category ?? null,
    'ext.event_ahead_nm': ev?.ahead ?? null,
    'ext.event_off_nm': ev?.off ?? null,
    'ext.launch_id': ln?.id ?? null,
    'ext.launch_rocket': ln?.rocket ?? null,
    'ext.launch_mission': ln?.mission ?? null,
    'ext.launch_pad': ln?.pad ?? null,
    'ext.launch_net': ln?.net ?? null,
    'ext.launch_window_start': ln?.windowStart ?? null,
    'ext.launch_window_end': ln?.windowEnd ?? null,
    'ext.launch_status': ln === null ? null : LAUNCH_STATUS_TEXT[ln.status],
    'ext.launch_done': ln === null ? null : ln.status !== 'go',
    'ext.launch_ahead_nm': ln?.ahead ?? null,
    'ext.launch_off_nm': ln?.offNm ?? null,
    ...connexVariables(input),
  };
}

/** `ofp.notam_*` (T95): the company NOTAM summary of the destination and the first alternate. */
function notamVariables(
  input: ContextInput,
): Record<'ofp.notam_dest' | 'ofp.notam_altn' | 'ofp.notam_count' | 'ofp.release', Value> {
  const { ofp } = input;
  const at = notamTime(ofp, ofp.destination.icao, input.oooi.OFF, input.delayMs ?? 0);
  const altn = ofp.alternates[0]?.icao;
  const dest = selectNotams(ofp.notams, ofp.destination.icao, at);
  const alt = altn === undefined ? [] : selectNotams(ofp.notams, altn, at);
  return {
    'ofp.notam_dest': notamText(dest),
    'ofp.notam_altn': altn === undefined ? null : notamText(alt),
    'ofp.notam_count': dest.length + alt.length,
    'ofp.release': ofp.source.generatedAtMs,
  };
}

/** `ext.connex_*` (T30): the first departures of the airline from the destination, one per line. */
function connexVariables(
  input: ContextInput,
): Record<'ext.connex_list' | 'ext.connex_count', Value> {
  const list = connexCandidates(input.ext?.connex, input.ofp).slice(0, CONNEX_LIST_MAX);
  if (list.length === 0) return { 'ext.connex_list': null, 'ext.connex_count': 0 };
  const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16).replace(':', '');
  const lines = list.map((f) =>
    [f.number.padEnd(7), f.dest, `${hhmm(f.std as number)}Z`, connexGate(f) ?? '']
      .join(' ')
      .trimEnd(),
  );
  return { 'ext.connex_list': lines.join('\n'), 'ext.connex_count': list.length };
}

type IrrVariable = Extract<
  ContextVariable,
  | `irr.${string}`
  | 'flight.nearest_altn'
  | 'flight.nearest_altn_nm'
  | 'flight.nearest_any'
  | 'flight.nearest_any_nm'
  | 'flight.divert_nm'
  | 'flight.here'
>;

/** `irr.*` (T14) and the nearest alternate; margins use the delayed estimates of the context. */
function irrVariables(input: ContextInput): Record<IrrVariable, Value> {
  const { ofp, telemetry: tm } = input;
  const family = aircraftInfo(ofp.aircraft.icao)?.family ?? null;
  const pick = (mode: 'ofp' | 'any') =>
    tm === null
      ? null
      : pickDivert({
          pos: tm,
          ofp,
          reserve: input.ext?.divertApts,
          family,
          mode,
          ...(input.runwayNeeds === undefined ? {} : { needs: input.runwayNeeds }),
        });
  const divert = input.divert ?? null;
  const dest =
    divert === null ? null : airportPlace(ofp, input.ext?.divertApts, divert, input.ext?.places);
  const divertNm = tm === null || dest === null ? null : Math.round(distanceNm(tm, dest));
  const nearest = pick('ofp');
  const nearestAny = pick('any');
  const ground = input.oooi.OFF === null || input.oooi.ON !== null;
  const here =
    tm === null || !ground
      ? null
      : airportHere(ofp, tm, divert, input.ext?.divertApts, input.ext?.places);
  const i = input.irr;
  const t = ofp.times;
  const offset = ofp.destination.utcOffsetH;
  const curfew = i?.curfew ?? null;
  // A real departure of the airline (T30, AeroDataBox) wins over the synthetic one.
  const real = i === undefined ? null : pickConnection(input.ext?.connex, ofp, input.seed ?? 0);
  const std = real?.std ?? i?.connectStd ?? null;
  return {
    'flight.nearest_altn': nearest?.icao ?? null,
    'flight.nearest_altn_nm': nearest?.nm ?? null,
    'flight.nearest_any': nearestAny?.icao ?? null,
    'flight.nearest_any_nm': nearestAny?.nm ?? null,
    'flight.divert_nm': divertNm,
    'flight.here': here?.icao ?? null,
    'irr.curfew': curfew,
    'irr.curfew_local': curfew === null || offset === null ? null : curfew + offset * 3_600_000,
    'irr.curfew_margin_min': curfew === null ? null : minutes(curfew - (t.estOnMs ?? t.estInMs)),
    // A confirmed flight (test hook) by its number; an airline route only (OpenFlights) as
    // `ONWARD FLT`; else none: no invented flights (T43).
    'irr.connect_flight':
      real !== null
        ? real.number
        : i?.connectKnown === true
          ? i.connectFlight
          : i?.onwardRoute === true
            ? 'ONWARD FLT'
            : null,
    'irr.connect_std': std,
    'irr.connect_pax': i?.connectPax ?? null,
    'irr.connect_margin_min': std === null ? null : minutes(std - t.estInMs),
    'irr.connect_left_min': std === null ? null : minutes(std - input.now),
    'irr.connect_dest': real?.dest ?? null,
    'irr.connect_gate': real === null ? null : connexGate(real),
    // C4: attribution line of a message with AeroDataBox data; empty (dropped) otherwise.
    'irr.connect_src': real === null ? '' : CONNEX_ATTRIBUTION,
    'irr.tanker_kg': i?.tankerKg ?? null,
    'irr.tanker_block_kg': i === undefined ? null : ofp.fuel.planRampKg + i.tankerKg,
    'irr.tanker_ldw_kg':
      i === undefined || ofp.weights.estLdwKg === null ? null : ofp.weights.estLdwKg + i.tankerKg,
    'irr.flow_delay_min': i?.flowDelayMin ?? null,
    'irr.revised_ctot': i === undefined ? null : input.data.ops.ctot + i.flowDelayMin * 60_000,
    'irr.latest_out': i === undefined ? null : t.estOutMs + i.fdpBufferMin * 60_000,
    'irr.new_gate': i?.newGate ?? null,
    'irr.lost_bags': i?.lostBags ?? null,
    'irr.crew_change_min': i?.crewChangeMin ?? null,
    'irr.crew_ready':
      i === undefined ? null : t.estOutMs + (i.fdpBufferMin + i.crewChangeMin) * 60_000,
  };
}

/** Temperature of a METAR's `TT/DD` group (`M05/M08` → -5), null without one. */
export function metarTempC(metar: string | null): number | null {
  if (metar === null) return null;
  const body = metar.split(/\sRMK\s/)[0] as string;
  const m = /(?:^|\s)(M?\d{2})\/(?:M?\d{2})?(?=\s|$)/.exec(body);
  if (m === null) return null;
  const v = m[1] as string;
  return v.startsWith('M') ? -Number(v.slice(1)) : Number(v);
}

/**
 * Wind group of a METAR (`27015KT`, `27015G25KT`, `27015MPS`, `27030KMH`) as direction the wind
 * blows from (degrees true) and mean speed in knots. Null for calm (`00000KT`), variable
 * (`VRB`), no group or no METAR.
 */
export function metarWind(metar: string | null): { from: number; kt: number } | null {
  if (metar === null) return null;
  const body = metar.split(/\sRMK\s/)[0] as string;
  const m = /(?:^|\s)(\d{3})(\d{2,3})(?:G\d{2,3})?(KT|MPS|KMH)(?=\s|$)/.exec(body);
  if (m === null) return null;
  const speed = Number(m[2]);
  const kt = m[3] === 'KT' ? speed : m[3] === 'MPS' ? speed * 1.943844 : speed / 1.852;
  if (speed === 0) return null;
  return { from: Number(m[1]), kt: Math.round(kt) };
}

const COMPASS_8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/** Eight-point compass name of a true bearing, degrees. */
export function compass8(deg: number): string {
  return COMPASS_8[Math.round((((deg % 360) + 360) % 360) / 45) % 8] as string;
}

/** Compass point the wind carries smoke to: the reciprocal of the METAR wind direction. */
export function smokeDrift(metar: string | null): string | null {
  const w = metarWind(metar);
  if (w === null) return null;
  const to = (w.from + 180) % 360;
  return compass8(to);
}

/** T43/T44 variables (kept apart from the big literal in {@link buildContext}). */
function t4344Variables(
  input: ContextInput,
  toDest: number | null,
  gs: number | null,
): Record<
  | 'flight.eta_live'
  | 'ops.turn_avail_min'
  | 'ops.quick_turn'
  | 'ops.ctot_ready'
  | 'ops.slot_missed'
  | 'ops.rdy_window'
  | 'ops.rdy_better',
  Value
> {
  const { now, oooi, ofp } = input;
  const ops = input.data.ops;
  return {
    // By ground speed and the distance left when both are known, else the planned one.
    'flight.eta_live':
      oooi.OFF === null
        ? null
        : toDest !== null && gs !== null && oooi.ON === null
          ? now + Math.round((toDest / gs) * 3_600_000)
          : oooi.OFF + ofp.times.estTimeEnrouteSec * 1000,
    // Time from the actual IN to the next STD; a turn shorter than the usual one is "quick".
    'ops.turn_avail_min': oooi.IN === null ? null : Math.round((ops.nextStd - oooi.IN) / 60_000),
    'ops.quick_turn':
      oooi.IN !== null &&
      ops.nextStd > oooi.IN &&
      ops.nextStd - oooi.IN < ops.turnaroundMin * 60_000,
    // RDY (T44): a ready flight may ask for an earlier slot from EOBT−15 min to CTOT−taxi (REA
    // rule of the Network Manager, e.g. AIP Ireland ENR 1.9 2.5.4); the gain is an assumption.
    'ops.ctot_ready': ops.ctot - ops.rdyGainMin * 60_000,
    // Slot tolerance window −5/+10 min around the CTOT (EUROCONTROL NM; AIP Ireland ENR 1.9,
    // checked 2026-10-14): airborne later than CTOT + 10 min = the slot was missed.
    'ops.slot_missed': oooi.OFF !== null && oooi.OFF > ops.ctot + 10 * 60_000,
    'ops.rdy_window':
      oooi.OUT === null &&
      now >= ofp.times.estOutMs - 15 * 60_000 &&
      now <= ops.ctot - (ofp.times.taxiOutSec ?? 600) * 1000,
    'ops.rdy_better':
      ops.ctot - ops.rdyGainMin * 60_000 - now >= (ofp.times.taxiOutSec ?? 600) * 1000,
  };
}

/**
 * The arrival gate for message texts (T43). The gate is real (OSM stands) or there is none: then
 * every text says it will be advised. A parking position (`stand`) is a STAND, never a GATE,
 * and has no jet bridge: bus and stairs.
 */
function gateVariables(
  input: ContextInput,
): Record<
  | 'ops.gate_known'
  | 'ops.gate_place'
  | 'ops.gate_line'
  | 'ops.gate_expected'
  | 'ops.ground_support',
  Value
> {
  const { arrGate, gateKind } = input.data.ops;
  if (arrGate === null) {
    return {
      'ops.gate_known': false,
      'ops.gate_place': 'GATE TBA',
      'ops.gate_line': 'GATE WILL BE ADVISED',
      'ops.gate_expected': 'GATE WILL BE ADVISED',
      'ops.ground_support': 'GROUND SUPPORT TBA',
    };
  }
  const place = `${gateKind === 'stand' ? 'STAND' : 'GATE'} ${arrGate}`;
  return {
    'ops.gate_known': true,
    'ops.gate_place': place,
    'ops.gate_line': `${place} CONFIRMED`,
    'ops.gate_expected': `EXPECTED ${place}`,
    'ops.ground_support':
      gateKind === 'stand' ? 'REMOTE STAND, BUS AND STAIRS' : 'GPU AND PCA AVBL',
  };
}

/**
 * Fuel slip data (T43): the level is stable when a refuelling was seen and the fuel did not
 * change by more than 100 kg for a minute after it; UPLIFT is the fuel now minus the first reading (before any refuelling), DIFF the
 * level against the planned ramp fuel.
 */
function fuelVariables(
  input: ContextInput,
): Record<
  'flight.fuel_stable' | 'flight.fuel_before_kg' | 'flight.fuel_uplift_kg' | 'flight.fuel_diff_kg',
  Value
> {
  const f = input.fuel ?? null;
  const planned = input.ofp.fuel.planRampKg;
  // The slip names the current reading as FOB: UPLIFT and DIFF use the same number.
  const fob = input.telemetry?.fuelKg ?? f?.anchor ?? null;
  return {
    'flight.fuel_stable': f?.changed === true && input.now - f.since >= 60_000,
    'flight.fuel_before_kg': f?.first ?? null,
    'flight.fuel_uplift_kg': f === null || fob === null ? null : fob - f.first,
    'flight.fuel_diff_kg': fob === null ? null : fob - planned,
  };
}

/** Fuel against the plan at the same point may differ by this share or this mass, whichever is more. */
const FUEL_PLAN_TOL_SHARE = 0.05;
const FUEL_PLAN_TOL_KG = 500;

/**
 * T46: `flight.touchdown_fpm` (the engine reads it at landing); `flight.fuel_below_plan_kg` =
 * the OFP's planned fuel on board at the aircraft's place on the route (`planFobKg` of the
 * navlog fixes, interpolated by the distance flown) minus the fuel on board, kg, positive =
 * below the plan, in flight only; `flight.fuel_plan_tol_kg` = the tolerance at that place
 * (5 % of the plan or 500 kg, the larger). Null without a plan or telemetry.
 */
function t46Variables(
  input: ContextInput,
): Record<'flight.fuel_below_plan_kg' | 'flight.fuel_plan_tol_kg' | 'flight.touchdown_fpm', Value> {
  const none = {
    'flight.fuel_below_plan_kg': null,
    'flight.fuel_plan_tol_kg': null,
    'flight.touchdown_fpm': input.touchdownFpm ?? null,
  };
  const tm = input.telemetry;
  if (tm === null || tm.onGround || input.oooi.OFF === null || input.oooi.ON !== null) return none;
  const fixes = input.ofp.navlog.filter((f) => typeof f.planFobKg === 'number');
  if (fixes.length < 2) return none;
  const along = input.route.totalNm - input.route.remainingNm(tm);
  const first = fixes[0] as OfpFix;
  const last = fixes[fixes.length - 1] as OfpFix;
  // Only between the first and last fix with a plan: no extrapolation.
  if (along < first.cumDistNm || along > last.cumDistNm) return none;
  let plan = last.planFobKg as number;
  for (let i = 1; i < fixes.length; i++) {
    const a = fixes[i - 1] as OfpFix;
    const b = fixes[i] as OfpFix;
    if (along > b.cumDistNm) continue;
    const span = b.cumDistNm - a.cumDistNm;
    const k = span <= 0 ? 1 : (along - a.cumDistNm) / span;
    plan = (a.planFobKg as number) + ((b.planFobKg as number) - (a.planFobKg as number)) * k;
    break;
  }
  return {
    'flight.fuel_below_plan_kg': Math.round(plan - tm.fuelKg),
    'flight.fuel_plan_tol_kg': Math.round(Math.max(plan * FUEL_PLAN_TOL_SHARE, FUEL_PLAN_TOL_KG)),
    'flight.touchdown_fpm': input.touchdownFpm ?? null,
  };
}

/**
 * TLR and crew from the OFP (T43). TLR only when computed for the runway the OFP plans (the
 * message names that runway); recordings made before T43 have no such fields.
 */
function perfVariables(
  ofp: Ofp,
): Record<
  Extract<
    ContextVariable,
    `ofp.${'to' | 'ldg'}_${string}` | `ofp.v${string}` | `ofp.crew_${string}`
  >,
  Value
> {
  const to = ofp.takeoffPerf ?? null;
  const ldg = ofp.landingPerf ?? null;
  const tp = to !== null && to.runway === ofp.origin.planRwy ? to : null;
  const lp = ldg !== null && ldg.runway === ofp.destination.planRwy ? ldg : null;
  const crew = ofp.crew ?? null;
  return {
    'ofp.to_flaps': tp?.flaps ?? null,
    'ofp.to_thrust':
      tp === null ? null : tp.flexTempC === null ? tp.thrust : `${tp.thrust} ${tp.flexTempC}`,
    'ofp.v1': tp?.v1Kt ?? null,
    'ofp.vr': tp?.vrKt ?? null,
    'ofp.v2': tp?.v2Kt ?? null,
    'ofp.ldg_flaps': lp?.flaps ?? null,
    'ofp.vref': lp?.vrefKt ?? null,
    'ofp.crew_cockpit': crew?.cockpit ?? null,
    'ofp.crew_cabin': crew?.cabin ?? null,
  };
}

/**
 * Mass unit of the messages (T105): `ofp` = the unit the OFP was planned in (`Ofp.source.plannedUnit`).
 * Masses stay in kg in the context; the template formatters `w1`, `w`, `wt` convert.
 */
export type MassUnitOption = 'ofp' | 'kg' | 'lb';

/** `units.*` (T105): `KG`/`LB` and the label of `|w1` figures. */
function unitVariables(input: ContextInput): Record<'units.mass' | 'units.mass_big', Value> {
  const o = input.massUnit ?? 'kg';
  const lb = (o === 'ofp' ? input.ofp.source.plannedUnit : o) === 'lb';
  return { 'units.mass': lb ? 'LB' : 'KG', 'units.mass_big': lb ? '1000 LBS' : 'TONNES' };
}

/** `names.*` (T43): version 2 — the airline's country, else the origin's (VATSpy), else null. */
function nameVariables(input: ContextInput): Record<'names.region' | 'names.mix', Value> {
  if ((input.namesVersion ?? 2) === 1) return { 'names.region': null, 'names.mix': 'none' };
  const { ofp, ext } = input;
  const airline = ofp.airlineIcao;
  const region =
    countryRegion(airlineCountry(airline)) ??
    countryRegion(ext?.airports?.[ofp.origin.icao]?.country ?? null);
  return {
    'names.region': region,
    'names.mix': airline !== null && MULTINATIONAL_AIRLINES.has(airline) ? 'all' : 'some',
  };
}

/**
 * The context is assembled from several smaller literals into one dictionary object: a single
 * literal of ~300 mixed-type properties is built several times slower per tick (V8 map churn;
 * T43: 12 000 ticks went from 0.1 s to 5 s).
 */
function mergeParts(...parts: readonly object[]): ScenarioContext {
  return Object.assign(Object.create(null) as object, ...parts) as ScenarioContext;
}
