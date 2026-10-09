/**
 * Normalized SimBrief OFP (docs/06-integrations.md).
 *
 * Source: `xml.fetcher.php?...&json=v2`. All masses are kg (converted from lbs when the
 * OFP was planned in lbs), absolute times are epoch milliseconds UTC, durations are
 * seconds, distances are nautical miles. Absent optional values are `null`.
 */

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
  readonly cargoKg: number;
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

export interface Ofp {
  readonly source: OfpSource;
  /** ATC callsign, e.g. `SJX822` (`atc.callsign`). Hoppie recipient. */
  readonly callsign: string;
  /** ICAO airline designator, e.g. `SJX`. Null for private / non-airline flights. */
  readonly airlineIcao: string | null;
  readonly flightNumber: string | null;
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
}
