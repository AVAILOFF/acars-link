import { distanceNm, type LatLon } from '../geo/geo.js';
import type { Ofp, OfpFix, OfpStepClimb } from '../ofp/types.js';
import { createRng, type Rng } from '../random/rng.js';
import { checkLevel, levelText } from './levels.js';
import { type RoutePosition, starEntryIndex } from './route.js';

/**
 * Clearances the ROPS station sends on its own (T26, docs/07; approved 2026-10-09):
 * - up to 3 random Direct To per flight (seeded): in cruise, not closer than 50 NM to TOD,
 *   to a fix of the current FIR 50–250 NM ahead, not on a SID/STAR, saving ≥ 2 NM;
 * - step climbs of the OFP: `CLIMB TO` 2 min before the step fix, unless the pilot already
 *   asked for that level or it is not a cruising level there (T25 table);
 * - the descent clearance 20 NM before TOD (as the original did): the highest of the OFP
 *   altitude at the STAR entry and the remaining route's MORA + 1000 ft, rounded up to
 *   1000 ft; a flight level at or above the destination's transition level, else feet.
 * The phrases are the FANS-A uplinks of T25 (`PROCEED DIRECT TO`, `CLIMB TO`, `DESCEND TO`).
 */

export const AUTO_DIRECTS_MAX = 3;
export const DIRECT_AHEAD_NM = [50, 250] as const;
export const DIRECT_MIN_SAVING_NM = 2;
/** No random Direct To closer than this to TOD. */
export const DIRECT_TOD_MARGIN_NM = 50;
export const STEP_LEAD_MIN = 2;
/** A step fix passed by more than this without a clearance is dropped. */
export const STEP_LATE_NM = 20;
export const DESCENT_BEFORE_TOD_NM = 20;
const MORA_MARGIN_FT = 1000;
/** Used when the OFP has neither a transition level nor altitude (`[ПРОВЕРИТЬ]` per airport). */
const DEFAULT_TRANSITION_FT = 18_000;

function cumOf(ofp: Ofp, ident: string): number | null {
  return ofp.navlog.find((f) => f.ident === ident && f.type === 'ltlg')?.cumDistNm ?? null;
}

/** Route distances of TOC and TOD; null without them in the navlog. */
export function cruiseSpan(ofp: Ofp): { readonly toc: number; readonly tod: number } | null {
  const toc = cumOf(ofp, 'TOC');
  const tod = cumOf(ofp, 'TOD');
  return toc === null || tod === null || tod <= toc ? null : { toc, tod };
}

/**
 * Where along the route random Direct To are tried (NM from the origin, ascending): 0–3
 * points, uniform in [TOC, TOD − 50 NM]. Depends on the seed and the OFP only.
 */
export function directTriggers(ofp: Ofp, seed: string | number): number[] {
  const span = cruiseSpan(ofp);
  if (span === null) return [];
  const lo = Math.ceil(span.toc);
  const hi = Math.floor(span.tod - DIRECT_TOD_MARGIN_NM);
  if (hi <= lo) return [];
  const rng = createRng(`${seed}/#directs`);
  const n = rng.int(0, AUTO_DIRECTS_MAX);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(rng.int(lo, hi));
  return out.sort((a, b) => a - b);
}

/** A fix for a random Direct To from `pos`, or null when none fits. */
export function directCandidate(
  ofp: Ofp,
  pos: LatLon,
  route: RoutePosition,
  fir: string | null,
  firAt: (p: LatLon) => string | null,
  rng: Rng,
): OfpFix | null {
  const list: OfpFix[] = [];
  for (let i = route.next; i < ofp.navlog.length; i++) {
    const f = ofp.navlog[i] as OfpFix;
    if (f.type === 'ltlg' || f.isSidStar) continue;
    const ahead = f.cumDistNm - route.alongNm;
    if (ahead < DIRECT_AHEAD_NM[0] || ahead > DIRECT_AHEAD_NM[1]) continue;
    if (ahead - distanceNm(pos, f) < DIRECT_MIN_SAVING_NM) continue;
    const there = firAt(f) ?? f.fir;
    if (fir !== null && there !== null && there !== fir) continue;
    list.push(f);
  }
  return list.length === 0 ? null : rng.pick(list);
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
  const d = ofp.destination;
  const tl = d.transLevelFt ?? d.transAltFt ?? DEFAULT_TRANSITION_FT;
  return { levelFt, text: levelText(levelFt, levelFt >= tl) };
}
