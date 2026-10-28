// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { LatLon } from '../geo/geo.js';
import { type BesselianElements, SOLAR_ECLIPSES } from './eclipses.js';

/**
 * Special events (T29, docs/07): the data the adapters pass in (`ExtDataUpdate`) and the pure
 * astronomy the core computes itself (sun elevation, local circumstances of a solar eclipse
 * from the NASA Besselian elements). Texts are upper-case ASCII, safe for a telex.
 */

/** NOAA space weather scale levels 0–5 (R radio blackouts, S radiation storms, G geomagnetic). */
export interface NoaaScales {
  readonly r: number;
  readonly s: number;
  readonly g: number;
}

/** NOAA SWPC `noaa-scales.json`: the current scales (key `0`) and the G forecast (keys `1`, `2`). */
export interface SpaceWeather {
  /** Time of the current values, epoch ms UTC. */
  readonly issued: number;
  readonly current: NoaaScales;
  /** Predicted G of today and tomorrow (only G has a scale in the forecast). */
  readonly gForecast: readonly { readonly date: string; readonly g: number }[];
}

/** One cell of the OVATION aurora forecast (1°×1°), probability of visible aurora, %. */
export interface AuroraCell {
  readonly lat: number;
  readonly lon: number;
  readonly prob: number;
}

/** OVATION forecast cells along the route (the adapter keeps only those). */
export interface AuroraForecast {
  /** `Forecast Time`, epoch ms UTC. */
  readonly forecastTime: number;
  readonly cells: readonly AuroraCell[];
}

/** An international SIGMET for volcanic ash (aviationweather.gov `isigmet`, `hazard: VA`). */
export interface AshSigmet {
  /** `<FIR> <series>`, `MHTG A3F`. */
  readonly id: string;
  readonly fir: string;
  /** Volcano as in the SIGMET qualifier, `FUEGO`, `MT SEMERU`. */
  readonly volcano: string;
  /** Feet; null when not given. */
  readonly baseFt: number | null;
  readonly topFt: number | null;
  readonly validFrom: number;
  readonly validTo: number;
  /** Polygons (rings) of the ash cloud. */
  readonly areas: readonly (readonly LatLon[])[];
}

/** An earthquake from the USGS feed. */
export interface Earthquake {
  readonly id: string;
  readonly mag: number;
  /** `17 KM S OF NANDAIME, NICARAGUA`. */
  readonly place: string;
  /** Origin time, epoch ms UTC. */
  readonly time: number;
  readonly lat: number;
  readonly lon: number;
  readonly depthKm: number;
}

/** A nationwide public holiday (Nager.Date, `global: true`). */
export interface PublicHoliday {
  /** `2026-10-03`. */
  readonly date: string;
  /** English name, `GERMAN UNITY DAY`. */
  readonly name: string;
  readonly localName: string;
}

/** Public holidays of the destination country (ISO 3166-1 alpha-2). */
export interface Holidays {
  readonly country: string;
  readonly list: readonly PublicHoliday[];
}

/** The latest Formula 1 Grand Prix result (Jolpica). */
export interface F1Race {
  readonly season: string;
  readonly round: string;
  /** `BAHRAIN GRAND PRIX`. */
  readonly name: string;
  /** Race start, epoch ms UTC. */
  readonly start: number;
  /** Start + the winner's race time, epoch ms UTC. */
  readonly finish: number;
  /** First three: position, driver code (`VER`), team (`RED BULL`). */
  readonly podium: readonly {
    readonly pos: number;
    readonly code: string;
    readonly team: string;
  }[];
}

/** NHL `gameState`: FUT, PRE, LIVE, CRIT are not final; FINAL and OFF are. */
export const NHL_STATES = ['FUT', 'PRE', 'LIVE', 'CRIT', 'FINAL', 'OFF'] as const;
export type NhlState = (typeof NHL_STATES)[number];

/** An NHL game of the regular season (type 2) or the playoffs (3). */
export interface NhlGame {
  readonly id: number;
  /** Start, epoch ms UTC. */
  readonly start: number;
  readonly state: NhlState;
  readonly away: string;
  readonly home: string;
  readonly awayScore: number | null;
  readonly homeScore: number | null;
  /** `REG`, `OT`, `SO`; null before the end. */
  readonly lastPeriod: string | null;
}

export const isNhlFinal = (s: NhlState): boolean => s === 'FINAL' || s === 'OFF';

const RAD = Math.PI / 180;

/**
 * Elevation of the sun's centre above the geometric horizon, degrees (USNO approximate solar
 * coordinates, good to ~0.01° for 1800–2200; no refraction).
 */
export function sunElevationDeg(p: LatLon, t: number): number {
  const d = t / 86_400_000 + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const l = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(l), Math.cos(l));
  const dec = Math.asin(Math.sin(e) * Math.sin(l));
  const gmst = (18.697374558 + 24.06570982441908 * d) * 15 * RAD;
  const h = gmst + p.lon * RAD - ra;
  const lat = p.lat * RAD;
  return (
    Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(h)) / RAD
  );
}

/** Local eclipse at a place and time: magnitude (fraction of the sun's diameter covered). */
export interface LocalEclipse {
  readonly magnitude: number;
  /** Inside the umbra (`TOTAL`) or antumbra (`ANNULAR`), else `PARTIAL`. */
  readonly kind: 'TOTAL' | 'ANNULAR' | 'PARTIAL';
  /** Sun altitude from the fundamental plane, degrees (no refraction). */
  readonly sunAltDeg: number;
}

const poly = (c: readonly number[], t: number) => c.reduce((s, k, i) => s + k * t ** i, 0);

/** Epoch ms UTC of the elements' reference time t0 (TD → UT with the table's ΔT). */
export function eclipseT0(e: BesselianElements): number {
  let t = T0.get(e);
  if (t === undefined) {
    t = Date.parse(`${e.date}T00:00:00Z`) + e.t0 * 3_600_000 - e.dt * 1000;
    T0.set(e, t);
  }
  return t;
}
const T0 = new WeakMap<BesselianElements, number>();

/**
 * Local circumstances from the Besselian elements (Explanatory Supplement to the Astronomical
 * Almanac, ch. 8; NASA eclipse site, "Local circumstances"), observer at sea level. Null when
 * the place is outside the penumbra at `t` or `t` is outside the elements' range.
 */
export function localEclipse(e: BesselianElements, p: LatLon, t: number): LocalEclipse | null {
  const tau = (t - eclipseT0(e)) / 3_600_000;
  if (tau < e.tMin || tau > e.tMax) return null;
  const x = poly(e.x, tau);
  const y = poly(e.y, tau);
  const d = poly(e.d, tau) * RAD;
  const mu = poly(e.mu, tau);
  const l1 = poly(e.l1, tau);
  const l2 = poly(e.l2, tau);
  const phi = p.lat * RAD;
  const u = Math.atan(0.99664719 * Math.tan(phi));
  const rs = 0.99664719 * Math.sin(u);
  const rc = Math.cos(u);
  // Hour angle: east longitude positive; 0.00417807·ΔT turns the TD-based μ into UT.
  const h = (mu + p.lon - 0.00417807 * e.dt) * RAD;
  const xi = rc * Math.sin(h);
  const eta = rs * Math.cos(d) - rc * Math.sin(d) * Math.cos(h);
  const zeta = rs * Math.sin(d) + rc * Math.cos(d) * Math.cos(h);
  const m = Math.hypot(x - xi, y - eta);
  const L1 = l1 - zeta * e.tanF1;
  const L2 = l2 - zeta * e.tanF2;
  if (m >= L1) return null;
  const kind = m < Math.abs(L2) ? (L2 < 0 ? 'TOTAL' : 'ANNULAR') : 'PARTIAL';
  // Partial: the fraction of the sun's diameter covered; inside the (ant)umbra NASA gives the
  // ratio of the apparent diameters of the moon and the sun.
  const magnitude = kind === 'PARTIAL' ? (L1 - m) / (L1 + L2) : (L1 - L2) / (L1 + L2);
  return { magnitude, kind, sunAltDeg: Math.asin(Math.max(-1, Math.min(1, zeta))) / RAD };
}

/** Time range of each table entry, epoch ms UTC (the scenario context asks every tick). */
const RANGES = SOLAR_ECLIPSES.map((e) => {
  const t0 = eclipseT0(e);
  return { e, from: t0 + e.tMin * 3_600_000, to: t0 + e.tMax * 3_600_000 };
});

/** Eclipses whose elements cover some time in `[from, to]`. */
export function eclipsesBetween(from: number, to: number): readonly BesselianElements[] {
  const out: BesselianElements[] = [];
  for (const r of RANGES) if (r.to >= from && r.from <= to) out.push(r.e);
  return out;
}

/** Ray casting in the lat/lon plane (small polygons, no antimeridian crossing). */
export function insidePolygon(p: LatLon, ring: readonly LatLon[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as LatLon;
    const b = ring[j] as LatLon;
    if (a.lat > p.lat !== b.lat > p.lat) {
      const x = ((b.lon - a.lon) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lon;
      if (p.lon < x) inside = !inside;
    }
  }
  return inside;
}
