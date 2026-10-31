// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { NatTrack } from '../ext/data.js';
import type {
  Ofp,
  OfpAircraft,
  OfpAirport,
  OfpAtis,
  OfpCrew,
  OfpEtops,
  OfpEtopsAirport,
  OfpFix,
  OfpFuel,
  OfpLandingPerf,
  OfpMassUnit,
  OfpStage,
  OfpStepClimb,
  OfpTakeoffPerf,
  OfpTimes,
  OfpWeights,
} from './types.js';

/** Thrown when SimBrief JSON does not match the expected `json=v2` shape. */
export class OfpParseError extends Error {
  override readonly name = 'OfpParseError';
  /** Dotted path of the offending field, e.g. `weights.est_zfw` or `navlog[3].pos_lat`. */
  readonly path: string;

  constructor(path: string, problem: string) {
    super(`Invalid SimBrief OFP at "${path || '<root>'}": ${problem}`);
    this.path = path;
  }
}

const LB_TO_KG = 0.45359237;
const NUMBER_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
const ISO_UTC_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const DURATION_RE = /^(\d+):([0-5]\d):([0-5]\d)$/;
const STAGES: ReadonlySet<string> = new Set<OfpStage>(['CLB', 'CRZ', 'DSC']);

type Json = Record<string, unknown>;

function describe(v: unknown): string {
  if (v === undefined) return 'nothing';
  const s = JSON.stringify(v);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

function join(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  return path ? `${path}.${key}` : key;
}

/** Reads the parsed JSON with a path, so every error names the exact field. */
class Reader {
  constructor(
    private readonly obj: Json,
    readonly path: string,
  ) {}

  static root(v: unknown): Reader {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new OfpParseError('', `expected a JSON object, got ${describe(v)}`);
    }
    return new Reader(v as Json, '');
  }

  private raw(key: string): unknown {
    return this.obj[key];
  }

  has(key: string): boolean {
    return this.obj[key] !== undefined;
  }

  /** Optional object; null when missing or not an object. */
  optSection(key: string): Reader | null {
    const v = this.raw(key);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    return new Reader(v as Json, join(this.path, key));
  }

  /**
   * Objects under `key`: an array, or a single object (SimBrief's XML-to-JSON gives one
   * element without the array). Non-objects are skipped.
   */
  objects(key: string): Reader[] {
    const v = this.raw(key);
    const p = join(this.path, key);
    const items = Array.isArray(v) ? v : v === undefined ? [] : [v];
    return items.flatMap((item, i) =>
      typeof item === 'object' && item !== null && !Array.isArray(item)
        ? [new Reader(item as Json, Array.isArray(v) ? join(p, i) : p)]
        : [],
    );
  }

  /** Integer, or null when missing or not an integer (optional sections such as `tlr`). */
  looseInt(key: string): number | null {
    const v = this.raw(key);
    return typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : null;
  }

  /** Strings under `key`: an array, or one string. Empty ones are skipped. */
  strings(key: string): string[] {
    const v = this.raw(key);
    const items = Array.isArray(v) ? v : [v];
    return items.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  }

  section(key: string): Reader {
    const v = this.raw(key);
    const p = join(this.path, key);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new OfpParseError(p, `expected an object, got ${describe(v)}`);
    }
    return new Reader(v as Json, p);
  }

  /** Array of objects. A missing key reads as an empty list only when `optional`. */
  list(key: string, optional = false): Reader[] {
    const v = this.raw(key);
    const p = join(this.path, key);
    if (v === undefined && optional) return [];
    if (!Array.isArray(v)) {
      throw new OfpParseError(p, `expected an array, got ${describe(v)}`);
    }
    return v.map((item, i) => {
      const ip = join(p, i);
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new OfpParseError(ip, `expected an object, got ${describe(item)}`);
      }
      return new Reader(item as Json, ip);
    });
  }

  optStr(key: string): string | null {
    const v = this.raw(key);
    if (v === undefined || v === '') return null;
    if (typeof v !== 'string') {
      throw new OfpParseError(join(this.path, key), `expected a string, got ${describe(v)}`);
    }
    const t = v.trim();
    return t === '' ? null : t;
  }

  str(key: string): string {
    const v = this.optStr(key);
    if (v === null) throw new OfpParseError(join(this.path, key), 'required value is missing');
    return v;
  }

  optNum(key: string): number | null {
    const s = this.optStr(key);
    if (s === null) return null;
    if (!NUMBER_RE.test(s)) {
      throw new OfpParseError(join(this.path, key), `expected a number, got ${describe(s)}`);
    }
    return Number(s);
  }

  num(key: string): number {
    const n = this.optNum(key);
    if (n === null) throw new OfpParseError(join(this.path, key), 'required value is missing');
    return n;
  }

  optInt(key: string): number | null {
    const n = this.optNum(key);
    if (n !== null && !Number.isInteger(n)) {
      throw new OfpParseError(join(this.path, key), `expected an integer, got ${n}`);
    }
    return n;
  }

  int(key: string): number {
    const n = this.optInt(key);
    if (n === null) throw new OfpParseError(join(this.path, key), 'required value is missing');
    return n;
  }

  coord(key: string, limit: 90 | 180): number {
    const n = this.num(key);
    if (n < -limit || n > limit) {
      throw new OfpParseError(join(this.path, key), `coordinate out of range ±${limit}: ${n}`);
    }
    return n;
  }

  /** `2026-10-08T07:45:00Z` → epoch ms. */
  optTimeMs(key: string): number | null {
    const s = this.optStr(key);
    if (s === null) return null;
    const m = ISO_UTC_RE.exec(s);
    if (!m) {
      throw new OfpParseError(
        join(this.path, key),
        `expected UTC time YYYY-MM-DDTHH:MM:SSZ, got ${describe(s)}`,
      );
    }
    const [y, mo, d, h, mi, se] = m.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const ms = Date.UTC(y, mo - 1, d, h, mi, se);
    // Date.UTC silently rolls over (Feb 30 → Mar 2); reject such values.
    if (new Date(ms).toISOString().slice(0, 19) !== s.slice(0, 19)) {
      throw new OfpParseError(join(this.path, key), `invalid calendar time ${describe(s)}`);
    }
    return ms;
  }

  timeMs(key: string): number {
    const t = this.optTimeMs(key);
    if (t === null) throw new OfpParseError(join(this.path, key), 'required value is missing');
    return t;
  }

  /** `02:04:23` → seconds. */
  optDurationSec(key: string): number | null {
    const s = this.optStr(key);
    if (s === null) return null;
    const m = DURATION_RE.exec(s);
    if (!m) {
      throw new OfpParseError(
        join(this.path, key),
        `expected duration HH:MM:SS, got ${describe(s)}`,
      );
    }
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }

  durationSec(key: string): number {
    const d = this.optDurationSec(key);
    if (d === null) throw new OfpParseError(join(this.path, key), 'required value is missing');
    return d;
  }
}

function parseUnit(params: Reader): OfpMassUnit {
  const u = params.str('units').toLowerCase();
  if (u === 'kgs' || u === 'kg') return 'kg';
  if (u === 'lbs' || u === 'lb') return 'lb';
  throw new OfpParseError(join(params.path, 'units'), `expected "kgs" or "lbs", got "${u}"`);
}

function parseAirport(r: Reader): OfpAirport {
  const atis: OfpAtis[] = r.list('atis', true).flatMap((a) => {
    const letter = a.optStr('letter');
    return letter === null ? [] : [{ network: a.optStr('network') ?? '', letter }];
  });
  return {
    icao: r.str('icao_code').toUpperCase(),
    iata: r.optStr('iata_code'),
    name: r.optStr('name') ?? '',
    elevationFt: r.num('elevation'),
    lat: r.coord('pos_lat', 90),
    lon: r.coord('pos_long', 180),
    utcOffsetH: r.optNum('timezone'),
    planRwy: r.optStr('plan_rwy'),
    transAltFt: r.optInt('trans_alt'),
    transLevelFt: r.optInt('trans_level'),
    metar: r.optStr('metar'),
    atis,
  };
}

/**
 * A point of a track route as SimBrief writes it (`58N020W`, `5530N02000W`, `SUNOT`) → as in the
 * track message (`58/20`, `5530/20`, `SUNOT`). NAT points are north and west on whole degrees of
 * longitude; anything else is null.
 */
function natPoint(token: string): string | null {
  if (/^[A-Z]{2,5}$/.test(token)) return token;
  const m = /^(\d{2})(\d{2})?N(\d{3})(?:00)?W$/.exec(token);
  if (m === null) return null;
  return `${m[1]}${m[2] ?? ''}/${String(Number(m[3])).padStart(2, '0')}`;
}

/** One entry of `tracks.nat` (T72); null when it does not read as a NAT track. */
function natTrack(t: Reader): NatTrack | null {
  try {
    const ident = t.optStr('id');
    if (ident === null || !/^[A-Z]{1,2}$/.test(ident)) return null;
    const route = (t.optStr('route') ?? '').split(/\s+/).map(natPoint);
    if (route.length < 2 || route.includes(null)) return null;
    const levels = (t.optStr('levels') ?? '').split(/\s+/).map(Number);
    if (levels.some((l) => !Number.isInteger(l) || l < 10 || l > 600)) return null;
    const validFrom = t.optTimeMs('start');
    const validTo = t.optTimeMs('end');
    if (validFrom === null || validTo === null || validTo <= validFrom) return null;
    return {
      ident,
      route: route as string[],
      validFrom,
      validTo,
      levelsFt: levels.map((l) => l * 100),
    };
  } catch (e) {
    // The tracks are an extra of the OFP: one that does not read must not refuse the plan.
    if (e instanceof OfpParseError) return null;
    throw e;
  }
}

/**
 * `tracks.nat` of the OFP (T72): the NAT tracks the dispatcher planned with (checked on a real
 * KATL–EDDF OFP of 2026-10-31, json=v2: `id`, `group`, `addr`, `tmi`, `route`, `levels`,
 * `start`/`end` UTC, `fixes`). `tracks` is `[]` (or has no `nat`) when the route does not use them.
 */
function parseNatTracks(root: Reader): readonly NatTrack[] {
  const tracks = root.optSection('tracks');
  if (tracks === null) return [];
  return tracks.objects('nat').flatMap((t) => {
    const k = natTrack(t);
    return k === null ? [] : [k];
  });
}

/** `etops` of the OFP (T50): an object when planned ETOPS, `[]` (or missing) otherwise. */
function parseEtops(root: Reader): OfpEtops | null {
  const e = root.optSection('etops');
  if (e === null) return null;
  const point = (key: string): OfpEtopsAirport | null => {
    const p = e.optSection(key);
    if (p === null || p.optStr('icao_code') === null) return null;
    return {
      icao: p.str('icao_code').toUpperCase(),
      name: p.optStr('name') ?? '',
      lat: p.coord('pos_lat_apt', 90),
      lon: p.coord('pos_long_apt', 180),
    };
  };
  return {
    ruleMin: e.looseInt('rule'),
    entry: point('entry'),
    exit: point('exit'),
    suitable: e.objects('suitable_airport').map((a) => ({
      icao: a.str('icao_code').toUpperCase(),
      name: a.optStr('name') ?? '',
      lat: a.coord('pos_lat', 90),
      lon: a.coord('pos_long', 180),
    })),
  };
}

/** `fuel_plan_onboard` of a fix (the plan's fuel on board there, OFP units), kg; null if absent. */
function planFob(f: Reader, kg: (n: number) => number): number | null {
  const n = f.optNum('fuel_plan_onboard');
  return n === null ? null : Math.round(kg(n));
}

function parseNavlog(root: Reader, kg: (n: number) => number): OfpFix[] {
  const fixes = root.list('navlog');
  if (fixes.length === 0) throw new OfpParseError('navlog', 'navlog is empty');
  let cum = 0;
  return fixes.map((f) => {
    const stage = f.str('stage');
    if (!STAGES.has(stage)) {
      throw new OfpParseError(
        join(f.path, 'stage'),
        `expected CLB, CRZ or DSC, got ${describe(stage)}`,
      );
    }
    const legDistNm = f.num('distance');
    cum += legDistNm;
    return {
      ident: f.str('ident'),
      type: f.str('type'),
      stage: stage as OfpStage,
      lat: f.coord('pos_lat', 90),
      lon: f.coord('pos_long', 180),
      viaAirway: f.optStr('via_airway'),
      isSidStar: f.optStr('is_sid_star') === '1',
      altitudeFt: f.num('altitude_feet'),
      legDistNm,
      cumDistNm: cum,
      trackMag: f.optNum('track_mag'),
      moraFt: f.optNum('mora'),
      fir: f.optStr('fir'),
      validLevelsFt: levels(f, 'fir_valid_levels'),
      planFobKg: planFob(f, kg),
    };
  });
}

/**
 * `stepclimb_string` pairs `IDENT/FFFF` (flight level in hundreds of feet, 4 digits). The
 * first pair is the origin with the initial level; tokens of another shape are skipped.
 */
function stepClimbs(s: string | null): OfpStepClimb[] {
  if (s === null) return [];
  const steps: OfpStepClimb[] = [];
  for (const token of s.toUpperCase().split(/\s+/)) {
    const m = /^([A-Z0-9]{2,7})\/(\d{4})$/.exec(token);
    if (m !== null) steps.push({ ident: m[1] as string, levelFt: Number(m[2]) * 100 });
  }
  return steps.slice(1);
}

/** Item 10a of `equip` (`H-SDE2E3…Y/LB1D1` → `SDE2E3…Y`). */
function equipment(s: string | null): string | null {
  if (s === null) return null;
  const m = /^(?:[A-Z]-)?([^/]*)/.exec(s.toUpperCase());
  return m?.[1] ? m[1] : null;
}

/** Comma-separated feet (`1000,3000,5000`); null when empty. */
function levels(r: Reader, key: string): number[] | null {
  const s = r.optStr(key);
  if (s === null) return null;
  const out = s.split(',').map((x) => x.trim());
  if (!out.every((x) => /^\d+$/.test(x))) {
    throw new OfpParseError(join(r.path, key), `expected levels in feet, got ${describe(s)}`);
  }
  return out.map(Number);
}

function parseAircraft(r: Reader): OfpAircraft {
  return {
    icao: r.str('icao_code').toUpperCase(),
    name: r.optStr('name') ?? '',
    reg: r.optStr('reg'),
    engines: r.optStr('engines'),
    wakeCategory: r.optStr('equip_category'),
    equip: equipment(r.optStr('equip')),
    maxPax: r.optInt('max_passengers'),
  };
}

function parseWeights(r: Reader, kg: (n: number) => number): OfpWeights {
  const req = (k: string) => kg(r.num(k));
  const opt = (k: string) => {
    const n = r.optNum(k);
    return n === null ? null : kg(n);
  };
  return {
    oewKg: opt('oew'),
    paxCount: r.int('pax_count'),
    bagCount: r.optInt('bag_count'),
    paxWeightKg: opt('pax_weight'),
    bagWeightKg: opt('bag_weight'),
    cargoKg: req('cargo'),
    payloadKg: req('payload'),
    estZfwKg: req('est_zfw'),
    maxZfwKg: req('max_zfw'),
    estTowKg: req('est_tow'),
    maxTowKg: req('max_tow'),
    estLdwKg: opt('est_ldw'),
    maxLdwKg: opt('max_ldw'),
    estRampKg: opt('est_ramp'),
  };
}

function parseFuel(r: Reader, kg: (n: number) => number): OfpFuel {
  const req = (k: string) => kg(r.num(k));
  const opt = (k: string) => {
    const n = r.optNum(k);
    return n === null ? null : kg(n);
  };
  return {
    taxiKg: opt('taxi'),
    enrouteBurnKg: req('enroute_burn'),
    contingencyKg: opt('contingency'),
    alternateBurnKg: opt('alternate_burn'),
    reserveKg: opt('reserve'),
    extraKg: opt('extra'),
    minTakeoffKg: opt('min_takeoff'),
    planTakeoffKg: req('plan_takeoff'),
    planRampKg: req('plan_ramp'),
    planLandingKg: opt('plan_landing'),
  };
}

/** The TLR entry for the planned runway (`conditions.planned_runway`); null if absent. */
function tlrRunway(r: Reader | null): { cond: Reader; rwy: Reader; id: string } | null {
  const cond = r?.optSection('conditions') ?? null;
  const id = cond?.optStr('planned_runway')?.toUpperCase() ?? null;
  if (r === null || cond === null || id === null) return null;
  const rwy = r.objects('runway').find((x) => x.optStr('identifier')?.toUpperCase() === id);
  return rwy === undefined ? null : { cond, rwy, id };
}

/** Takeoff numbers of the planned runway; null when TLR or any speed is missing. */
function parseTakeoffPerf(tlr: Reader | null): OfpTakeoffPerf | null {
  const p = tlrRunway(tlr?.optSection('takeoff') ?? null);
  if (p === null) return null;
  const { rwy } = p;
  const flaps = rwy.optStr('flap_setting');
  const thrust = rwy.optStr('thrust_setting');
  const v1 = rwy.looseInt('speeds_v1');
  const vr = rwy.looseInt('speeds_vr');
  const v2 = rwy.looseInt('speeds_v2');
  if (flaps === null || thrust === null || v1 === null || vr === null || v2 === null) return null;
  return {
    runway: p.id,
    flaps: flaps.toUpperCase(),
    thrust: thrust.toUpperCase(),
    flexTempC: rwy.looseInt('flex_temperature'),
    v1Kt: v1,
    vrKt: vr,
    v2Kt: v2,
  };
}

/** Landing flaps and VREF for the planned runway and the planned surface (dry / wet). */
function parseLandingPerf(tlr: Reader | null): OfpLandingPerf | null {
  const landing = tlr?.optSection('landing') ?? null;
  const p = tlrRunway(landing);
  if (landing === null || p === null) return null;
  const wet = p.cond.optStr('surface_condition')?.toLowerCase() === 'wet';
  const dist = landing.optSection(wet ? 'distance_wet' : 'distance_dry');
  const flaps = p.cond.optStr('flap_setting') ?? dist?.optStr('flap_setting') ?? null;
  const vref = dist?.looseInt('speeds_vref') ?? null;
  if (flaps === null || vref === null) return null;
  return { runway: p.id, flaps: flaps.toUpperCase(), vrefKt: vref };
}

function parseCrew(r: Reader | null): OfpCrew | null {
  if (r === null) return null;
  const cockpit = ['cpt', 'fo'].filter((k) => r.strings(k).length > 0).length;
  const cabin = r.strings('pu').length + r.strings('fa').length;
  return cockpit + cabin === 0 ? null : { cockpit, cabin };
}

function parseTimes(r: Reader): OfpTimes {
  const times: OfpTimes = {
    schedOutMs: r.timeMs('sched_out'),
    schedOffMs: r.optTimeMs('sched_off'),
    schedOnMs: r.optTimeMs('sched_on'),
    schedInMs: r.timeMs('sched_in'),
    estOutMs: r.timeMs('est_out'),
    estOffMs: r.optTimeMs('est_off'),
    estOnMs: r.optTimeMs('est_on'),
    estInMs: r.timeMs('est_in'),
    estTimeEnrouteSec: r.durationSec('est_time_enroute'),
    schedBlockSec: r.optDurationSec('sched_block'),
    estBlockSec: r.optDurationSec('est_block'),
    taxiOutSec: r.optDurationSec('taxi_out'),
    taxiInSec: r.optDurationSec('taxi_in'),
  };
  if (times.schedInMs <= times.schedOutMs) {
    throw new OfpParseError(join(r.path, 'sched_in'), 'sched_in is not after sched_out');
  }
  if (times.estInMs <= times.estOutMs) {
    throw new OfpParseError(join(r.path, 'est_in'), 'est_in is not after est_out');
  }
  return times;
}

/**
 * Normalizes a SimBrief OFP fetched with `json=v2` (already `JSON.parse`d).
 * Throws {@link OfpParseError} naming the offending field when the shape is wrong.
 */
export function parseSimbriefOfp(json: unknown): Ofp {
  const root = Reader.root(json);

  if (root.has('fetch')) {
    const status = root.section('fetch').optStr('status');
    if (status !== null && status !== 'Success') {
      throw new OfpParseError('fetch.status', `SimBrief returned "${status}"`);
    }
  }

  const params = root.section('params');
  const plannedUnit = parseUnit(params);
  const kg =
    plannedUnit === 'kg' ? (n: number) => Math.round(n) : (n: number) => Math.round(n * LB_TO_KG);

  const general = root.section('general');
  const atc = root.section('atc');
  const natTracks = parseNatTracks(root);

  return {
    source: {
      requestId: params.str('request_id'),
      airac: params.optStr('airac') ?? '',
      generatedAtMs: params.timeMs('time_generated'),
      plannedUnit,
    },
    callsign: atc.str('callsign').toUpperCase(),
    airlineIcao: general.optStr('icao_airline'),
    flightNumber: general.optStr('flight_number'),
    costIndex: general.optInt('costindex'),
    initialAltitudeFt: general.int('initial_altitude'),
    stepClimbs: stepClimbs(general.optStr('stepclimb_string')),
    route: general.optStr('route') ?? '',
    sid: general.optStr('sid_ident'),
    star: general.optStr('star_ident'),
    routeDistanceNm: general.optNum('route_distance'),
    origin: parseAirport(root.section('origin')),
    destination: parseAirport(root.section('destination')),
    alternates: root.list('alternate', true).map(parseAirport),
    aircraft: parseAircraft(root.section('aircraft')),
    weights: parseWeights(root.section('weights'), kg),
    fuel: parseFuel(root.section('fuel'), kg),
    times: parseTimes(root.section('times')),
    navlog: parseNavlog(root, kg),
    takeoffPerf: parseTakeoffPerf(root.optSection('tlr')),
    landingPerf: parseLandingPerf(root.optSection('tlr')),
    crew: parseCrew(root.optSection('crew')),
    etops: parseEtops(root),
    ...(natTracks.length === 0 ? {} : { natTracks }),
  };
}

/** Same as {@link parseSimbriefOfp}, starting from the raw response text. */
export function parseSimbriefOfpText(text: string): Ofp {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new OfpParseError('', `response is not valid JSON (${reason})`);
  }
  return parseSimbriefOfp(json);
}
