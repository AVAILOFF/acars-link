// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

/**
 * Normalized SimBrief OFP (docs/06-integrations.md).
 *
 * Source: `xml.fetcher.php?...&json=v2`. All masses are kg (converted from lbs when the
 * OFP was planned in lbs), absolute times are epoch milliseconds UTC, durations are
 * seconds, distances are nautical miles. Absent optional values are `null`.
 */

import type { NatTrack } from '../ext/data.js';

export type OfpMassUnit = 'kg' | 'lb';

export interface OfpSource {
  /** SimBrief request id (`params.request_id`). */
  readonly requestId: string;
  readonly airac: string;
  readonly generatedAtMs: number;
  /** Mass unit the OFP was planned in. Values in `Ofp` are always kg. */
  readonly plannedUnit: OfpMassUnit;
}

export interface OfpAtis {
  readonly network: string;
  readonly letter: string;
}

export interface OfpAirport {
  readonly icao: string;
  readonly iata: string | null;
  readonly name: string;
  readonly elevationFt: number;
  readonly lat: number;
  readonly lon: number;
  /** Hours offset from UTC (`timezone`). */
  readonly utcOffsetH: number | null;
  readonly planRwy: string | null;
  readonly transAltFt: number | null;
  readonly transLevelFt: number | null;
  readonly metar: string | null;
  readonly atis: readonly OfpAtis[];
}

/**
 * FPL item 18 (T89): the line as SimBrief gives it (without brackets) and the indicators the core
 * reads. Indicators per ICAO Doc 4444, appendix 2.
 */
export interface OfpItem18 {
  readonly raw: string;
  /** `STS/` reasons for special handling (`HOSP`, `MEDEVAC`, `HUM` …), in their order; empty = none. */
  readonly sts: readonly string[];
  /** `RMK/` plain-language remarks; null = none. */
  readonly rmk: string | null;
}

export type OfpStage = 'CLB' | 'CRZ' | 'DSC';

export interface OfpFix {
  readonly ident: string;
  /** `wpt`, `vor`, `ndb`, `apt`, `ltlg` (TOC/TOD) … as given by SimBrief. */
  readonly type: string;
  readonly stage: OfpStage;
  readonly lat: number;
  readonly lon: number;
  readonly viaAirway: string | null;
  readonly isSidStar: boolean;
  readonly altitudeFt: number;
  /** Leg distance from the previous fix. */
  readonly legDistNm: number;
  /** Cumulative distance from departure. */
  readonly cumDistNm: number;
  /** Magnetic track of the leg to this fix (`track_mag`), degrees. */
  readonly trackMag: number | null;
  /** Minimum off-route altitude of the leg (`mora`), feet. */
  readonly moraFt: number | null;
  /** FIR the fix is in (`fir`), e.g. `RJJJ`. */
  readonly fir: string | null;
  /**
   * Levels SimBrief allows on the leg to this fix (`fir_valid_levels`), feet: direction of
   * flight and airway limits applied (M750 in RJJJ: FL270 and up). Null when absent.
   */
  readonly validLevelsFt: readonly number[] | null;
  /**
   * The planned fuel on board at this fix (`fuel_plan_onboard`), kg (T46). Null when the OFP
   * has none; absent in OFPs parsed before T46.
   */
  readonly planFobKg?: number | null;
}

/** A planned step climb (T26): at `ident`, climb to `levelFt`. */
export interface OfpStepClimb {
  readonly ident: string;
  readonly levelFt: number;
}

export interface OfpAircraft {
  readonly icao: string;
  readonly name: string;
  readonly reg: string | null;
  readonly engines: string | null;
  /** ICAO wake turbulence category from the FPL equipment string (L/M/H/J). */
  readonly wakeCategory: string | null;
  /** FPL item 10a equipment and capabilities (`equip`, e.g. `SDE2E3GHIJ3J4J5LM1ORWXY`); `W` = RVSM. */
  readonly equip: string | null;
  readonly maxPax: number | null;
}

export interface OfpWeights {
  readonly oewKg: number | null;
  readonly paxCount: number;
  readonly bagCount: number | null;
  readonly paxWeightKg: number | null;
  readonly bagWeightKg: number | null;
  /** Baggage and freight together (`cargo`): SimBrief counts the bags in it. */
  readonly cargoKg: number;
  /**
   * Freight only, without baggage (`freight_added`, T89). Absent in recordings made before T89:
   * readers treat `undefined` as null.
   */
  readonly freightKg?: number | null;
  readonly payloadKg: number;
  readonly estZfwKg: number;
  readonly maxZfwKg: number;
  readonly estTowKg: number;
  readonly maxTowKg: number;
  readonly estLdwKg: number | null;
  readonly maxLdwKg: number | null;
  readonly estRampKg: number | null;
}

export interface OfpFuel {
  readonly taxiKg: number | null;
  readonly enrouteBurnKg: number;
  readonly contingencyKg: number | null;
  readonly alternateBurnKg: number | null;
  readonly reserveKg: number | null;
  readonly extraKg: number | null;
  readonly minTakeoffKg: number | null;
  readonly planTakeoffKg: number;
  readonly planRampKg: number;
  readonly planLandingKg: number | null;
}

export interface OfpTimes {
  readonly schedOutMs: number;
  readonly schedOffMs: number | null;
  readonly schedOnMs: number | null;
  readonly schedInMs: number;
  readonly estOutMs: number;
  readonly estOffMs: number | null;
  readonly estOnMs: number | null;
  readonly estInMs: number;
  readonly estTimeEnrouteSec: number;
  readonly schedBlockSec: number | null;
  readonly estBlockSec: number | null;
  readonly taxiOutSec: number | null;
  readonly taxiInSec: number | null;
}

/**
 * SimBrief takeoff/landing performance (`tlr`, T43), for the planned runway only. Present when
 * the OFP was planned with TLR; values as SimBrief gives them (speeds kt, temperature °C).
 */
export interface OfpTakeoffPerf {
  readonly runway: string;
  /** `flap_setting`, e.g. `1`. */
  readonly flaps: string;
  /** `thrust_setting`, e.g. `FLEX`, `TOGA`. */
  readonly thrust: string;
  /** `flex_temperature`, °C; null when not given. */
  readonly flexTempC: number | null;
  readonly v1Kt: number;
  readonly vrKt: number;
  readonly v2Kt: number;
}

export interface OfpLandingPerf {
  readonly runway: string;
  readonly flaps: string;
  /** `speeds_vref` of the distance for `surface_condition` (dry / wet). */
  readonly vrefKt: number;
}

/** Crew from the OFP (`crew`, T43): head counts only, names are not used. */
export interface OfpCrew {
  /** Captain and first officer given. */
  readonly cockpit: number;
  /** Purser and flight attendants. */
  readonly cabin: number;
}

export interface Ofp {
  readonly source: OfpSource;
  /** ATC callsign, e.g. `SJX822` (`atc.callsign`). Hoppie recipient. */
  readonly callsign: string;
  /** ICAO airline designator, e.g. `SJX`. Null for private / non-airline flights. */
  readonly airlineIcao: string | null;
  readonly flightNumber: string | null;
  /**
   * FPL item 8b, type of flight (`atc.flight_type`, T89): `S` scheduled, `N` non-scheduled, `G`
   * general aviation, `M` military, `X` other (ICAO Doc 4444, app. 2). Absent in recordings made
   * before T89: readers treat `undefined` as null.
   */
  readonly flightType?: string | null;
  /** FPL item 8a, flight rules (`atc.flight_rules`: `I`, `V`, `Y`, `Z`, T89); absent before T89. */
  readonly flightRules?: string | null;
  /** FPL item 18, other information (`atc.section18`, T89); null when empty, absent before T89. */
  readonly item18?: OfpItem18 | null;
  readonly costIndex: number | null;
  readonly initialAltitudeFt: number;
  /**
   * Step climbs after the initial level, from `general.stepclimb_string`
   * (`RCTP/0390 MADOG/0410`: fix / flight level; the first pair is the origin and the
   * initial level). Format of several steps `[ПРОВЕРИТЬ]` on a real OFP with step climbs.
   */
  readonly stepClimbs: readonly OfpStepClimb[];
  readonly route: string;
  readonly sid: string | null;
  readonly star: string | null;
  readonly routeDistanceNm: number | null;
  readonly origin: OfpAirport;
  readonly destination: OfpAirport;
  /** Planned alternates in OFP order; may be empty. */
  readonly alternates: readonly OfpAirport[];
  readonly aircraft: OfpAircraft;
  readonly weights: OfpWeights;
  readonly fuel: OfpFuel;
  readonly times: OfpTimes;
  readonly navlog: readonly OfpFix[];
  /**
   * Null without TLR / crew in the OFP. Recordings made before T43 have no such fields:
   * readers treat `undefined` as null.
   */
  readonly takeoffPerf: OfpTakeoffPerf | null;
  readonly landingPerf: OfpLandingPerf | null;
  readonly crew: OfpCrew | null;
  /**
   * ETOPS planning (T50); null when the flight is not planned ETOPS (SimBrief gives `etops: []`).
   * Recordings made before T50 have no such field: readers treat `undefined` as null.
   */
  readonly etops: OfpEtops | null;
  /**
   * The NAT tracks of the OFP (T72): `tracks.nat` of SimBrief, the tracks the dispatcher planned
   * with. Absent when the OFP has none (`tracks: []`) and in recordings made before T72.
   */
  readonly natTracks?: readonly NatTrack[];
  /**
   * NOTAM of the origin, destination and alternates as SimBrief put them into the OFP (T95), in
   * OFP order. Absent when the OFP has none and in recordings made before T95: readers treat
   * `undefined` as an empty list.
   */
  readonly notams?: readonly OfpNotam[];
}

/**
 * One entry of `origin/destination/alternate.notam[]` of the SimBrief OFP (T95). Fields checked
 * on the OFPs of `reference/ofp/raw` (2026-11-07): `notam_qcode` is a string or `[]`,
 * `date_expire` a time or `false` (PERM), `notam_schedule` a string or `{}`.
 */
export interface OfpNotam {
  /** `notam_id`, e.g. `B2655/26`. */
  readonly id: string;
  /** `location_icao`. */
  readonly icao: string;
  /** `notam_qcode`, five letters `Q…`; null when SimBrief gives none. */
  readonly qcode: string | null;
  readonly startMs: number;
  /** Null = permanent (`date_expire: false`, `C) PERM`). */
  readonly endMs: number | null;
  /** `date_expire_is_estimated` (`C) … EST`). */
  readonly endEstimated: boolean;
  /** `notam_schedule` (item D, hours of activity), not parsed; null when empty. */
  readonly schedule: string | null;
  /** Item E: `notam_text` without the schedule line SimBrief puts first, lines joined by spaces. */
  readonly text: string;
}

/** An ETOPS airport of the OFP: entry, exit or en-route suitable airport. */
export interface OfpEtopsAirport {
  readonly icao: string;
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
}

/**
 * `etops` of the SimBrief OFP, structure checked on a real OFP (RJTT–KLAX A35K, rule 370,
 * 2026-10-15): `rule` (minutes), `entry` / `exit` (`icao_code`, `pos_lat_apt`, `pos_long_apt`, …),
 * `suitable_airport[]` (`icao_code`, `name`, `pos_lat`, `pos_long`, …), `equal_time_point[]`,
 * `critical_point`. Only what diversion needs is kept.
 */
export interface OfpEtops {
  /** Maximum diversion time, minutes (`rule`). */
  readonly ruleMin: number | null;
  readonly entry: OfpEtopsAirport | null;
  readonly exit: OfpEtopsAirport | null;
  /** En-route suitable airports in OFP order. */
  readonly suitable: readonly OfpEtopsAirport[];
}
