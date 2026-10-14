import {
  ATC_MAX_AGE_MS,
  type ExtState,
  type LaunchStatus,
  liveWx,
  type RoutePolyline,
  sortStations,
} from '../ext/data.js';
import { distanceNm, type LatLon } from '../geo/geo.js';
import type { Ofp } from '../ofp/types.js';
import type { FlightPhase, OooiKind } from '../phase/fsm.js';
import type { TelemetrySnapshot } from '../telemetry/types.js';
import { aircraftVariables } from './aircraft.js';
import type { Value } from './expr.js';
import type { IrregularData } from './irregular-data.js';
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
  'flight.minutes_since_off',
  'flight.eta',
  'flight.block_min',
  'flight.air_min',
  'flight.divert',
  'flight.sent',
  // nearest of the origin and the alternates to the aircraft (T14), null without position
  'flight.nearest_altn',
  'flight.nearest_altn_nm',
  // the run's last pilot answer (`wait: reply`), null before one
  'reply.option',
  'reply.text',
  'reply.arg',
  'reply.timeout',
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
  'ops.next_std',
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
export const isContextVariable = (path: string): boolean => KNOWN.has(path) || FLAG.test(path);

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
  /** Diversion airport the pilot declared (`DIVERT`), engine. */
  readonly divert?: string | null;
  /** Ids of the scenarios that sent something in this flight, first send first. */
  readonly sent?: readonly string[];
  /** External data (T13). */
  readonly ext?: ExtState;
  /** Irregular-scenario data and the gate a reassignment would move to (T14). */
  readonly irr?: IrregularData & { readonly newGate: string };
  readonly polyline?: RoutePolyline;
  /** Flight seed (T29: the "on this day" fact of several). */
  readonly seed?: number | string;
}

/** Per-run variables (`reply.*`, `cmd.*`): null in the shared context, set by the engine. */
export const RUN_VARIABLES = [
  'reply.option',
  'reply.text',
  'reply.arg',
  'reply.timeout',
  'cmd.name',
  'cmd.text',
  'cmd.icao',
  'cmd.minutes',
  'cmd.reason',
  'cmd.metar',
  'cmd.taf',
  'cmd.wx_live',
  'cmd.wx_obs',
] as const satisfies readonly ContextVariable[];
export type RunVariable = (typeof RUN_VARIABLES)[number];

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
    'flight.divert': input.divert ?? null,
    'flight.sent': [...(input.sent ?? [])],
    'reply.option': null,
    'reply.text': null,
    'reply.arg': null,
    'reply.timeout': null,
    'cmd.name': null,
    'cmd.text': null,
    'cmd.icao': null,
    'cmd.minutes': null,
    'cmd.reason': null,
    'cmd.metar': null,
    'cmd.taf': null,
    'cmd.wx_live': null,
    'cmd.wx_obs': null,
    ...extVariables(input),
    ...specialVariables(input),
    ...aircraftVariables(ofp.aircraft.icao),
    ...irrVariables(input),
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
  };
}

type IrrVariable = Extract<
  ContextVariable,
  `irr.${string}` | 'flight.nearest_altn' | 'flight.nearest_altn_nm'
>;

/** `irr.*` (T14) and the nearest alternate; margins use the delayed estimates of the context. */
function irrVariables(input: ContextInput): Record<IrrVariable, Value> {
  const { ofp, telemetry: tm } = input;
  let nearest: { icao: string; nm: number } | null = null;
  if (tm !== null) {
    for (const a of [ofp.origin, ...ofp.alternates]) {
      if (a.icao === ofp.destination.icao) continue;
      const nm = distanceNm(tm, a);
      if (nearest === null || nm < nearest.nm) nearest = { icao: a.icao, nm: Math.round(nm) };
    }
  }
  const i = input.irr;
  const t = ofp.times;
  const offset = ofp.destination.utcOffsetH;
  return {
    'flight.nearest_altn': nearest?.icao ?? null,
    'flight.nearest_altn_nm': nearest?.nm ?? null,
    'irr.curfew': i?.curfew ?? null,
    'irr.curfew_local': i === undefined || offset === null ? null : i.curfew + offset * 3_600_000,
    'irr.curfew_margin_min': i === undefined ? null : minutes(i.curfew - (t.estOnMs ?? t.estInMs)),
    'irr.connect_flight': i?.connectFlight ?? null,
    'irr.connect_std': i?.connectStd ?? null,
    'irr.connect_pax': i?.connectPax ?? null,
    'irr.connect_margin_min': i === undefined ? null : minutes(i.connectStd - t.estInMs),
    'irr.connect_left_min': i === undefined ? null : minutes(i.connectStd - input.now),
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
