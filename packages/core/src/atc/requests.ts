import type { LatLon } from '../geo/geo.js';
import type { Ofp, OfpFix } from '../ofp/types.js';
import type { CpdlcResponse } from './cpdlc.js';
import { checkLevel, levelText, RVSM_HIGH_FT, RVSM_LOW_FT } from './levels.js';
import { aircraftLimits } from './performance.js';
import { type RoutePosition, starEntryIndex } from './route.js';

/**
 * Pilot requests to the ROPS station (T25, docs/07). Downlinks as FBW A32NX sends them
 * (FANS-A, values without `@` on the network): DM6 `REQUEST FL350`, DM9 `REQUEST CLIMB TO
 * FL350`, DM10 `REQUEST DESCEND TO 11000FT`, DM18 `REQUEST M.78` / `REQUEST 280KT`, DM22
 * `REQUEST DIRECT TO MOLKA`; a reason element (`DUE TO WEATHER`) may follow. Answers are
 * FANS-A uplinks: UM20 `CLIMB TO`, UM23 `DESCEND TO`, UM19 `MAINTAIN <level>`, UM106
 * `MAINTAIN <speed>`, UM74 `PROCEED DIRECT TO` (all WU) or UM0 `UNABLE` (N) with an UM169
 * free-text reason (`DUE TO AIRSPACE RESTRICTION` / `DUE TO TRAFFIC`: ATN B1 UM167/UM166
 * texts, FANS-A has no such elements).
 */

export type AtcRequest =
  | {
      readonly kind: 'level';
      readonly levelFt: number;
      /** Asked as a flight level (`FL350`), not feet. */
      readonly asFl: boolean;
    }
  | { readonly kind: 'speed'; readonly mach: number | null; readonly kt: number | null }
  | { readonly kind: 'direct'; readonly fix: string };

const REASON = '(?: DUE TO [A-Z ]+)?';
const LEVEL_RE = new RegExp(
  `^REQUEST (?:(?:CLIMB|DESCEND) TO )?(?:FL ?(\\d{2,3})|(\\d{3,5}) ?FT)${REASON}$`,
);
const SPEED_RE = new RegExp(
  `^REQUEST (?:M ?(\\.\\d{1,2})|(\\.\\d{1,2})|(\\d{2,3}) ?(?:KT)?)${REASON}$`,
);
const DIRECT_RE = new RegExp(`^REQUEST DIRECT TO ([A-Z0-9]{2,7})${REASON}$`);

/** A request the station handles, or null (text normalized by `cpdlcText`). */
export function parseRequest(text: string): AtcRequest | null {
  const level = LEVEL_RE.exec(text);
  if (level !== null) {
    if (level[1] !== undefined)
      return { kind: 'level', levelFt: Number(level[1]) * 100, asFl: true };
    return { kind: 'level', levelFt: Number(level[2]), asFl: false };
  }
  const speed = SPEED_RE.exec(text);
  if (speed !== null) {
    const mach = speed[1] ?? speed[2];
    if (mach !== undefined) {
      const digits = mach.slice(1).padEnd(2, '0');
      return { kind: 'speed', mach: Number(digits) / 100, kt: null };
    }
    return { kind: 'speed', mach: null, kt: Number(speed[3]) };
  }
  const direct = DIRECT_RE.exec(text);
  if (direct !== null) return { kind: 'direct', fix: direct[1] as string };
  return null;
}

export interface RequestContext {
  readonly ofp: Ofp;
  /** Aircraft altitude, ft (null without telemetry). */
  readonly altFt: number | null;
  /** Position on the route (null without telemetry). */
  readonly route: RoutePosition | null;
  /** FIR the aircraft is in (station's, VATSpy), else the leg's SimBrief FIR. */
  readonly fir: string | null;
  /** FIR of a point (VATSpy), null when unknown. */
  readonly firAt: (p: LatLon) => string | null;
}

export interface RequestDecision {
  readonly approved: boolean;
  /** Uplink text (CPDLC profile, `@` around values). */
  readonly text: string;
  readonly ra: CpdlcResponse;
  /** Why it was refused (tests, events); null when approved. */
  readonly why: RefusalReason | null;
}

export type RefusalReason =
  | 'no_position'
  | 'ceiling'
  | 'rvsm'
  | 'direction'
  | 'airway'
  | 'mora'
  | 'speed_limit'
  | 'vmo'
  | 'mmo'
  | 'not_ahead'
  | 'beyond_star'
  | 'other_fir'
  | 'traffic';

const AIRSPACE = 'UNABLE@_@DUE TO AIRSPACE RESTRICTION';
/** ICAO speed limit below FL100 (approved everywhere, 14 CFR 91.117). */
export const SPEED_LIMIT_KT = 250;
export const SPEED_LIMIT_BELOW_FT = 10_000;

function refuse(why: RefusalReason, text = 'UNABLE'): RequestDecision {
  return { approved: false, text, ra: 'N', why };
}

function clear(text: string): RequestDecision {
  return { approved: true, text, ra: 'WU', why: null };
}

/** The leg the aircraft is on (to `route.next`). */
function leg(ctx: RequestContext): OfpFix | null {
  return ctx.route === null ? null : (ctx.ofp.navlog[ctx.route.next] ?? null);
}

/** Decides a request by the rules (traffic refusals are the station's, from the seed). */
export function decide(req: AtcRequest, ctx: RequestContext): RequestDecision {
  if (req.kind === 'level') return decideLevel(req, ctx);
  if (req.kind === 'speed') return decideSpeed(req, ctx);
  return decideDirect(req, ctx);
}

function decideLevel(
  req: Extract<AtcRequest, { kind: 'level' }>,
  ctx: RequestContext,
): RequestDecision {
  const l = leg(ctx);
  if (ctx.altFt === null || l === null) return refuse('no_position');
  const level = req.levelFt;
  const limits = aircraftLimits(ctx.ofp.aircraft.icao);
  if (limits !== null && level > limits.ceilingFt) return refuse('ceiling');
  const equip = ctx.ofp.aircraft.equip;
  if (equip !== null && !equip.includes('W') && level >= RVSM_LOW_FT && level <= RVSM_HIGH_FT) {
    return refuse('rvsm', AIRSPACE);
  }
  const track = l.trackMag;
  if (track !== null) {
    const check = checkLevel(level, ctx.fir ?? l.fir, track, l.validLevelsFt);
    if (!check.ok) return refuse(check.why, AIRSPACE);
  }
  if (l.moraFt !== null && level < l.moraFt) return refuse('mora');
  const value = `@${levelText(level, req.asFl)}@`;
  if (Math.abs(level - ctx.altFt) < 200) return clear(`MAINTAIN ${value}`);
  return clear(`${level > ctx.altFt ? 'CLIMB' : 'DESCEND'} TO ${value}`);
}

function decideSpeed(
  req: Extract<AtcRequest, { kind: 'speed' }>,
  ctx: RequestContext,
): RequestDecision {
  if (ctx.altFt === null) return refuse('no_position');
  const limits = aircraftLimits(ctx.ofp.aircraft.icao);
  if (req.kt !== null) {
    if (ctx.altFt < SPEED_LIMIT_BELOW_FT && req.kt > SPEED_LIMIT_KT) return refuse('speed_limit');
    if (limits?.vmoKt != null && req.kt > limits.vmoKt) return refuse('vmo');
    return clear(`MAINTAIN @${req.kt}KT@`);
  }
  const mach = req.mach as number;
  if (limits?.mmo != null && mach > limits.mmo) return refuse('mmo');
  return clear(`MAINTAIN @M.${String(Math.round(mach * 100)).padStart(2, '0')}@`);
}

function decideDirect(
  req: Extract<AtcRequest, { kind: 'direct' }>,
  ctx: RequestContext,
): RequestDecision {
  const l = leg(ctx);
  if (ctx.route === null || l === null) return refuse('no_position');
  const navlog = ctx.ofp.navlog;
  let idx = -1;
  for (let i = ctx.route.next; i < navlog.length; i++) {
    const f = navlog[i] as OfpFix;
    if (f.type !== 'ltlg' && f.ident === req.fix) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return refuse('not_ahead');
  const star = starEntryIndex(navlog);
  if (star !== null && idx > star) return refuse('beyond_star');
  const fix = navlog[idx] as OfpFix;
  const here = ctx.fir ?? l.fir;
  const there = ctx.firAt(fix) ?? fix.fir;
  if (here !== null && there !== null && here !== there) return refuse('other_fir');
  return clear(`PROCEED DIRECT TO @${fix.ident}@`);
}
