// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { Ofp } from '../ofp/types.js';

/**
 * Route statistics of the destination (T55, level 2): AeroDataBox
 * `airports/icao/{ICAO}/stats/routes/daily`, fetched by the app with the user's key and passed in
 * as `ExtDataUpdate.routes`. Only what R5 allows is kept: the airports, the airlines (ICAO) and
 * the daily average. No aircraft type in the source (R4).
 */

/** One route from the airport. */
export interface RouteStat {
  /** Airport the route goes to, ICAO (an identifier, kept after the purge). */
  readonly dest: string;
  /** Average flights a day; null once purged from an old recording (C9). */
  readonly daily: number | null;
  /** ICAO codes of the airlines on the route (operators without one are dropped). */
  readonly operators: readonly string[];
}

/** Routes from the airport `icao`. */
export interface RouteStatsData {
  readonly icao: string;
  readonly list: readonly RouteStat[];
}

/**
 * Routes of the OFP airline from the destination, by destination code: with a daily average (not
 * purged), not back to the origin, not to the destination itself.
 */
export function routeCandidates(data: RouteStatsData | null | undefined, ofp: Ofp): RouteStat[] {
  const airline = ofp.airlineIcao;
  if (data === null || data === undefined || airline === null) return [];
  if (data.icao !== ofp.destination.icao) return [];
  return data.list
    .filter(
      (r) =>
        r.daily !== null &&
        r.daily > 0 &&
        r.operators.includes(airline) &&
        r.dest !== ofp.origin.icao &&
        r.dest !== ofp.destination.icao,
    )
    .sort((a, b) => (a.dest < b.dest ? -1 : a.dest > b.dest ? 1 : 0));
}
