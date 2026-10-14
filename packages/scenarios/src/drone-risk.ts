/**
 * Chance multiplier of `irregular/drone_activity` by the destination country (T38, docs/07).
 * Game numbers: only the ORDER of the levels comes from data (checked 2026-10-09: Russian
 * airport stoppages, German/Danish/Lithuanian/Belgian/Norwegian closures in 2025–26, Gulf
 * airspace closures in 2026, FAA sighting reports). The real per-flight frequency is far lower.
 * A snapshot of 2026-10, revised by hand.
 */

/** Date the table was checked against the sources (see docs/07, T38). */
export const DRONE_RISK_CHECKED = '2026-10-09';

/** Key of "any other country" in a multiplier table. */
export const DRONE_RISK_OTHER = '*';

/** ISO 3166-1 alpha-2 country (or `*`) → multiplier. */
export type DroneRiskTable = Readonly<Record<string, number>>;

const level = (mult: number, countries: readonly string[]): [string, number][] =>
  countries.map((c) => [c, mult]);

export const DRONE_RISK_DEFAULT: DroneRiskTable = Object.freeze(
  Object.fromEntries([
    ...level(5, ['RU']), // A — almost daily
    ...level(2, ['DE', 'DK', 'LT', 'BE', 'NO', 'AE', 'QA', 'KW', 'BH']), // B — repeated closures 2025–26
    ...level(1, ['US', 'GB', 'NL', 'PL', 'SE', 'FI', 'LV', 'EE']), // C — sightings, closures rare
    [DRONE_RISK_OTHER, 0.3], // D — the rest of the world
  ]),
);

export const DRONE_RISK_MAX = 100;

export const isDroneRiskKey = (k: string): boolean =>
  k === DRONE_RISK_OTHER || /^[A-Z]{2}$/.test(k);

export const isDroneRiskValue = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= DRONE_RISK_MAX;

/** Multiplier for a country; an unknown country (null) or one not listed gets `*` (1 if absent). */
export function droneMultiplier(table: DroneRiskTable, country: string | null): number {
  if (country !== null) {
    const m = table[country];
    if (m !== undefined) return m;
  }
  return table[DRONE_RISK_OTHER] ?? 1;
}

/** Final chance: base × multiplier, at most 1. */
export function droneProbability(
  base: number,
  table: DroneRiskTable,
  country: string | null,
): number {
  return Math.min(1, Math.round(base * droneMultiplier(table, country) * 1e6) / 1e6);
}
