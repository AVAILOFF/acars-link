import { distanceNm, type LatLon } from '../geo/geo.js';
import type { Ofp, OfpAirport, OfpFix, OfpStepClimb } from '../ofp/types.js';
import { createRng } from '../random/rng.js';
import { checkLevel, levelText } from './levels.js';
import { type RoutePosition, starEntryIndex } from './route.js';

/**
 * Clearances the XATC station sends on its own (T26, docs/07; the Direct To rule replaced by
 * the user's decision of 2026-10-10, T38):
 * - at most one random Direct To per FIR, at the first contact with the FIR's station in cruise
 *   (more than 50 NM before TOD): 50 % (seeded), 1–5 min after the contact, to the FIR exit
 *   point of the OFP route (the farthest route fix of the FIR within 250 NM and TOD − 50 NM,
 *   not SID/STAR), saving ≥ 5 NM; never a fix already given, never one behind a given fix,
 *   nothing new until the given fix is passed;
 * - step climbs of the OFP: `CLIMB TO` 2 min before the step fix, unless the pilot already
 *   asked for that level or it is not a cruising level there (T25 table);
 * - the descent clearance 20 NM before TOD (as the original did): the highest of the OFP
 *   altitude at the STAR entry and the remaining route's MORA + 1000 ft, rounded up to
 *   1000 ft; a flight level at or above the destination's transition level, else feet.
 * The phrases are the FANS-A uplinks of T25 (`PROCEED DIRECT TO`, `CLIMB TO`, `DESCEND TO`).
 */

/** Farthest fix a Direct To may name, ahead of the aircraft. */
export const DIRECT_AHEAD_MAX_NM = 250;
export const DIRECT_MIN_SAVING_NM = 5;
/** No random Direct To closer than this to TOD. */
export const DIRECT_TOD_MARGIN_NM = 50;
/** Share of the FIRs that get a random Direct To. */
export const DIRECT_CHANCE = 0.5;
/** Delay after the first contact, s. */
export const DIRECT_DELAY_S = [60, 300] as const;
export const STEP_LEAD_MIN = 2;
/** A step fix passed by more than this without a clearance is dropped. */
export const STEP_LATE_NM = 20;
export const DESCENT_BEFORE_TOD_NM = 20;
const MORA_MARGIN_FT = 1000;
/**
 * When the OFP has neither a transition level nor altitude (decision 2026-10-09, option б):
 * 18 000 ft in the US and Canada (destination ICAO K…, PA…, PH…, C…), elsewhere always a
 * flight level.
 */
const NORTH_AMERICA_TRANSITION_FT = 18_000;

export function defaultTransitionFt(icao: string): number {
  return /^(K|PA|PH|C)/.test(icao) ? NORTH_AMERICA_TRANSITION_FT : 0;
}

/** The airport's transition: level, else altitude, else the default above (ft). */
export function transitionFt(apt: OfpAirport): number {
  return apt.transLevelFt ?? apt.transAltFt ?? defaultTransitionFt(apt.icao);
}

function cumOf(ofp: Ofp, ident: string): number | null {
  return ofp.navlog.find((f) => f.ident === ident && f.type === 'ltlg')?.cumDistNm ?? null;
}

/** Route distances of TOC and TOD; null without them in the navlog. */
export function cruiseSpan(ofp: Ofp): { readonly toc: number; readonly tod: number } | null {
  const toc = cumOf(ofp, 'TOC');
  const tod = cumOf(ofp, 'TOD');
  return toc === null || tod === null || tod <= toc ? null : { toc, tod };
}

/** Whether the FIR gets a random Direct To, and after how many ms (seed and FIR only). */
export function directDecision(
  seed: string | number,
  fir: string,
): { readonly issue: boolean; readonly delayMs: number } {
  const rng = createRng(`${seed}/#direct/${fir}`);
  const issue = rng.chance(DIRECT_CHANCE);
  return { issue, delayMs: rng.int(DIRECT_DELAY_S[0], DIRECT_DELAY_S[1]) * 1000 };
}

/**
 * The FIR exit fix for a Direct To from `pos`, or null. Only fixes after `afterIdx` (the last
 * one given); null when the exit is the next route fix (nothing to cut) or saves too little.
 */
export function directExit(
  ofp: Ofp,
  pos: LatLon,
  route: RoutePosition,
  fir: string,
  firAt: (p: LatLon) => string | null,
  afterIdx: number,
): { readonly fix: OfpFix; readonly idx: number } | null {
  const span = cruiseSpan(ofp);
  if (span === null) return null;
  let nextIdx = -1;
  let best: { fix: OfpFix; idx: number } | null = null;
  for (let i = route.next; i < ofp.navlog.length; i++) {
    const f = ofp.navlog[i] as OfpFix;
    if (f.type === 'ltlg' || f.isSidStar) continue;
    if (nextIdx < 0) nextIdx = i;
    const there = firAt(f) ?? f.fir;
    if (there !== fir) break;
    const ahead = f.cumDistNm - route.alongNm;
    if (ahead > DIRECT_AHEAD_MAX_NM || f.cumDistNm > span.tod - DIRECT_TOD_MARGIN_NM) break;
    if (i > afterIdx) best = { fix: f, idx: i };
  }
  if (best === null || best.idx === nextIdx) return null;
  const saving = best.fix.cumDistNm - route.alongNm - distanceNm(pos, best.fix);
  return saving < DIRECT_MIN_SAVING_NM ? null : best;
}

export type StepStatus = 'wait' | 'due' | 'skip';

/**
 * Whether a step climb is due: within 2 min (at `gsKt`) of its fix, or just past it. `skip`
 * when the fix is not in the navlog, passed long ago, or the level is not a cruising level
 * on the leg after the fix (T25 table).
 */
export function stepStatus(
  ofp: Ofp,
  step: OfpStepClimb,
  route: RoutePosition,
  gsKt: number,
  fir: string | null,
): StepStatus {
  const idx = ofp.navlog.findIndex((f) => f.ident === step.ident);
  if (idx < 0) return 'skip';
  const fix = ofp.navlog[idx] as OfpFix;
  const toFix = fix.cumDistNm - route.alongNm;
  if (toFix < -STEP_LATE_NM) return 'skip';
  const leg = ofp.navlog[idx + 1] ?? fix;
  if (leg.trackMag !== null) {
    const ok = checkLevel(step.levelFt, fir ?? leg.fir, leg.trackMag, leg.validLevelsFt);
    if (!ok.ok) return 'skip';
  }
  const lead = (Math.max(gsKt, 200) * STEP_LEAD_MIN) / 60;
  return toFix <= lead ? 'due' : 'wait';
}

export interface DescentLevel {
  readonly levelFt: number;
  /** Text value, `FL120` or `6000FT`. */
  readonly text: string;
}

/** Initial descent level from the aircraft's position on the route (approved algorithm). */
export function descentLevel(ofp: Ofp, route: RoutePosition): DescentLevel | null {
  const entry = starEntryIndex(ofp.navlog);
  const atEntry = entry === null ? 0 : (ofp.navlog[entry] as OfpFix).altitudeFt;
  let mora = 0;
  for (let i = route.next; i < ofp.navlog.length; i++) {
    mora = Math.max(mora, (ofp.navlog[i] as OfpFix).moraFt ?? 0);
  }
  const raw = Math.max(atEntry, mora > 0 ? mora + MORA_MARGIN_FT : 0);
  if (raw <= 0) return null;
  const levelFt = Math.ceil(raw / 1000) * 1000;
  return { levelFt, text: levelText(levelFt, levelFt >= transitionFt(ofp.destination)) };
}
