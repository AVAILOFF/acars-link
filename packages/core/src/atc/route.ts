import { bearingDeg, distanceNm, EARTH_RADIUS_NM, type LatLon } from '../geo/geo.js';
import type { Ofp, OfpFix } from '../ofp/types.js';

/** Where the aircraft is on the planned route (T25/T26). */
export interface RoutePosition {
  /** Navlog index of the fix the current leg leads to. */
  readonly next: number;
  /** Route distance from the origin to the aircraft's projection, NM. */
  readonly alongNm: number;
  /** Distance from the route, NM. */
  readonly offNm: number;
}

/**
 * The navlog leg nearest to `pos` (great-circle cross-track; past a leg's end the distance to
 * its end point). Legs: origin → navlog[0] → navlog[1] … A tie goes to the earlier leg.
 */
export function routePosition(ofp: Ofp, pos: LatLon): RoutePosition {
  let best: RoutePosition | null = null;
  let start: LatLon = ofp.origin;
  let startAlong = 0;
  ofp.navlog.forEach((fix, i) => {
    const len = fix.cumDistNm - startAlong;
    const d13 = distanceNm(start, pos);
    let along: number;
    let off: number;
    if (len <= 0 || d13 === 0) {
      along = 0;
      off = d13;
    } else {
      const θ = ((bearingDeg(start, pos) - bearingDeg(start, fix)) * Math.PI) / 180;
      const δ13 = d13 / EARTH_RADIUS_NM;
      const xt = Math.asin(Math.sin(δ13) * Math.sin(θ));
      const at = Math.acos(Math.min(1, Math.cos(δ13) / Math.cos(xt))) * EARTH_RADIUS_NM;
      const ahead = Math.cos(θ) >= 0;
      along = ahead ? at : -at;
      if (along < 0) off = d13;
      else if (along > len) off = distanceNm(fix, pos);
      else off = Math.abs(xt) * EARTH_RADIUS_NM;
      along = Math.min(Math.max(along, 0), len);
    }
    if (best === null || off < best.offNm) {
      best = { next: i, alongNm: startAlong + along, offNm: off };
    }
    start = fix;
    startAlong = fix.cumDistNm;
  });
  return best ?? { next: 0, alongNm: 0, offNm: distanceNm(ofp.origin, pos) };
}

/**
 * Navlog index of the STAR's first fix, or null without a STAR. SimBrief flags the fixes
 * after it (`is_sid_star`, via the STAR); the entry fix itself comes via the airway
 * (`… NIXOV` via Y53, then `BIKLO` via NIXOVB), so it is the fix before the first flagged
 * one after the en-route part.
 */
export function starEntryIndex(navlog: readonly OfpFix[]): number | null {
  let enroute = false;
  for (let i = 0; i < navlog.length; i++) {
    const f = navlog[i] as OfpFix;
    if (!f.isSidStar && f.type !== 'ltlg') enroute = true;
    else if (f.isSidStar && enroute) {
      let j = i - 1;
      while (j > 0 && (navlog[j] as OfpFix).type === 'ltlg') j--;
      return j;
    }
  }
  return null;
}
