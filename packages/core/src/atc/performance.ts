// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

/**
 * Maximum operating altitude and VMO/MMO by ICAO type (T25), from EASA type-certificate
 * data sheets (checked 2026-10-09, docs/07 T25):
 * - EASA.A.064 A318/A319/A320/A321, issue 62 (26 June 2026): 39 100 ft, 39 800 ft with
 *   modification 30748 (approved: the common fleet value), VMO 350 kt, MMO 0.82;
 * - EASA.A.004 A330, issue 69 (19/12/2025): -200/-300/-800/-900 41 450 ft;
 * - EASA.A.151 A350, issue 33 (01.07.2026): -900 43 100 ft, -1000 41 450 ft;
 * - EASA.IM.A.120 B737, issue 29 (16 Dec 2025): NG and MAX 41 000 ft (Classic: "see AFM");
 * - EASA.IM.A.003 B777, issue 20.0 (13 May 2026): all variants 43 100 ft;
 * - EASA.IM.A.115 B787, issue 30 (17 December 2025): -8/-9 43 100 ft, -10 41 100 ft,
 *   VMO/MMO 350 KEAS / 0.90;
 * - EASA.IM.A.196 B747, issue 19 (17 December 2024): -400 45 100 ft, -8 43 100 ft,
 *   VMO/MMO 365 / 0.90.
 * EASA.A.110 A380 (issue 17) gives no numbers ("refer to AFM"), so the A380 is not listed.
 * A type that is not here is not checked (approved 2026-10-09). Weight-limited altitude is
 * not modelled.
 */
export interface AircraftLimits {
  readonly ceilingFt: number;
  readonly vmoKt: number | null;
  readonly mmo: number | null;
}

const A320_FAMILY: AircraftLimits = { ceilingFt: 39_800, vmoKt: 350, mmo: 0.82 };
const A330: AircraftLimits = { ceilingFt: 41_450, vmoKt: null, mmo: null };
const B737: AircraftLimits = { ceilingFt: 41_000, vmoKt: null, mmo: null };
const B777: AircraftLimits = { ceilingFt: 43_100, vmoKt: null, mmo: null };
const B787: AircraftLimits = { ceilingFt: 43_100, vmoKt: 350, mmo: 0.9 };

const LIMITS: Readonly<Record<string, AircraftLimits>> = {
  A318: A320_FAMILY,
  A319: A320_FAMILY,
  A320: A320_FAMILY,
  A321: A320_FAMILY,
  A19N: A320_FAMILY,
  A20N: A320_FAMILY,
  A21N: A320_FAMILY,
  A332: A330,
  A333: A330,
  A338: A330,
  A339: A330,
  A359: { ceilingFt: 43_100, vmoKt: null, mmo: null },
  A35K: { ceilingFt: 41_450, vmoKt: null, mmo: null },
  B736: B737,
  B737: B737,
  B738: B737,
  B739: B737,
  B37M: B737,
  B38M: B737,
  B39M: B737,
  B772: B777,
  B77L: B777,
  B773: B777,
  B77W: B777,
  B788: B787,
  B789: B787,
  B78X: { ceilingFt: 41_100, vmoKt: 350, mmo: 0.9 },
  B744: { ceilingFt: 45_100, vmoKt: null, mmo: null },
  B748: { ceilingFt: 43_100, vmoKt: 365, mmo: 0.9 },
};

/** Limits of an ICAO type designator, or null when the TCDS gives none we hold. */
export function aircraftLimits(icaoType: string): AircraftLimits | null {
  return LIMITS[icaoType.toUpperCase()] ?? null;
}
