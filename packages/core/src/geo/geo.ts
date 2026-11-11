// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

/** Spherical-earth helpers. Distances in nautical miles, angles in degrees. */

/** Mean earth radius in NM. */
export const EARTH_RADIUS_NM = 3440.065;

export interface LatLon {
  readonly lat: number;
  readonly lon: number;
}

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** Great-circle distance (haversine). */
export function distanceNm(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial true bearing from a to b, 0..360. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const φ1 = a.lat * RAD;
  const φ2 = b.lat * RAD;
  const dλ = (b.lon - a.lon) * RAD;
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return normalizeDeg(Math.atan2(y, x) * DEG);
}

/** Point reached from `from` after `distNm` along the great circle with initial `bearing`. */
export function destinationPoint(from: LatLon, bearing: number, distNm: number): LatLon {
  const δ = distNm / EARTH_RADIUS_NM;
  const θ = bearing * RAD;
  const φ1 = from.lat * RAD;
  const λ1 = from.lon * RAD;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 =
    λ1 +
    Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: φ2 * DEG, lon: normalizeLon(λ2 * DEG) };
}

/** Point at fraction f (0..1) of the great circle from a to b. */
export function interpolate(a: LatLon, b: LatLon, f: number): LatLon {
  const d = distanceNm(a, b);
  if (d === 0) return { lat: a.lat, lon: a.lon };
  return destinationPoint(a, bearingDeg(a, b), d * f);
}

export function normalizeDeg(deg: number): number {
  const r = deg % 360;
  return r < 0 ? r + 360 : r;
}

function normalizeLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}
