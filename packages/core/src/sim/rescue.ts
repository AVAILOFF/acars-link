import { type AircraftFamily, aircraftInfo } from '../scenario/aircraft.js';
import { RESCUE_MAX_VEHICLES } from './commands.js';

/**
 * Which and how many rescue vehicles meet the aircraft (T54). All rules here are game rules of the
 * user (docs/07 T54, decisions of 2026-10-17), not ICAO norms or data about real airport services:
 *
 * - fire trucks by the aircraft's group of rescue categories: 1–5 → 1, 6–7 → 4, 8–10 → 8; no
 *   fire chief's car;
 * - fire truck models by the landing airport: large (OurAirports `large_airport`) or not, North
 *   America (ICAO `K`, `C`) or not;
 * - ambulance models by the ICAO region;
 * - fewer models than vehicles → the models take turns.
 *
 * The SimObject titles are the ones a human spawned in MSFS 2024 on 2026-10-17 (docs/07 T54,
 * "Объекты"); every group can be edited in the app's settings.
 */

/** Group of airport rescue and fire-fighting categories an aircraft belongs to. */
export type RescueCategory = '1-5' | '6-7' | '8-10';

/**
 * Category group by aircraft family (T40). Narrow-body jets are 6–7, wide-bodies 8–10, the regional
 * families 1–5, except the types of {@link RESCUE_TYPE_CATEGORY}. A type outside the T40 table gets
 * the smallest group (user decisions of 2026-10-17).
 */
export const RESCUE_CATEGORY: Readonly<Record<AircraftFamily, RescueCategory>> = {
  A320: '6-7',
  B737: '6-7',
  A330: '8-10',
  A350: '8-10',
  A380: '8-10',
  B747: '8-10',
  B777: '8-10',
  B787: '8-10',
  'E-JET': '1-5',
  CRJ: '1-5',
  ATR: '1-5',
  DH8: '1-5',
};

/** Regional types in category 6 (user decision of 2026-10-17): E190, E195, DH8D. */
export const RESCUE_TYPE_CATEGORY: Readonly<Record<string, RescueCategory>> = {
  E190: '6-7',
  E195: '6-7',
  DH8D: '6-7',
};

/** Fire trucks per category group (the user's rule of 2026-10-17). */
export const FIRE_TRUCKS: Readonly<Record<RescueCategory, number>> = {
  '1-5': 1,
  '6-7': 4,
  '8-10': 8,
};

export function rescueCategory(icaoType: string | null | undefined): RescueCategory {
  const byType = RESCUE_TYPE_CATEGORY[icaoType?.trim().toUpperCase() ?? ''];
  if (byType !== undefined) return byType;
  const info = aircraftInfo(icaoType);
  return info === null ? '1-5' : RESCUE_CATEGORY[info.family];
}

/** How many fire trucks meet an aircraft of this ICAO type. */
export function fireTruckCount(icaoType: string | null | undefined): number {
  return FIRE_TRUCKS[rescueCategory(icaoType)];
}

/** Editable groups of SimObject titles (settings). */
export interface RescueTitles {
  /** Large airport (`large_airport`), North America. */
  readonly fireLargeNa: readonly string[];
  /** Large airport, elsewhere. */
  readonly fireLarge: readonly string[];
  /** Other airport, North America. */
  readonly fireNa: readonly string[];
  /** Other airport, elsewhere. */
  readonly fire: readonly string[];
  /** Ambulance: Japan (`RJ`, `RO`). */
  readonly medicJapan: readonly string[];
  /** Ambulance: the rest of Asia (`R`, `V`, `W`, `Z`). */
  readonly medicAsia: readonly string[];
  /** Ambulance: North America (`K`, `C`). */
  readonly medicNa: readonly string[];
  /** Ambulance: Europe (`E`, `L`) and the rest. */
  readonly medic: readonly string[];
}

export const RESCUE_TITLE_GROUPS = [
  'fireLargeNa',
  'fireLarge',
  'fireNa',
  'fire',
  'medicJapan',
  'medicAsia',
  'medicNa',
  'medic',
] as const satisfies readonly (keyof RescueTitles)[];

/**
 * Defaults (docs/07 T54, decisions of 2026-10-17). The GSX Panther is not one: it is an add-on.
 * `Microsoft_Truck_Fire_Medium_Red` was taken out of `fireLarge` after the human check: it drives visually in
 * reverse (the sim moves it along its heading, the model is drawn the other way); it can be added back in the settings.
 */
export const DEFAULT_RESCUE_TITLES: RescueTitles = {
  fireLargeNa: ['Truck Fire Airport Medium'],
  fireLarge: ['ASO_Firetruck02', 'Truck Fire Airport Medium'],
  fireNa: ['Truck Fire Long 02', 'Microsoft_Truck_Fire_Long'],
  fire: ['Truck Fire Short'],
  medicJapan: ['Van Asia High Roof Medic Japan'],
  medicAsia: ['Van Asia High Roof Medic', 'Van Asia Low Roof Medic'],
  medicNa: ['Truck Utility NorthAm Medic'],
  medic: ['Truck Utility Europe Medic Box', 'Truck Utility Europe Medic Flush'],
};

export type RescueRegion = 'NA' | 'JAPAN' | 'ASIA' | 'OTHER';

/** Region of an airport by the first letters of its ICAO code. */
export function rescueRegion(icao: string): RescueRegion {
  const c = icao.trim().toUpperCase();
  if (c.startsWith('K') || c.startsWith('C')) return 'NA';
  if (c.startsWith('RJ') || c.startsWith('RO')) return 'JAPAN';
  if (/^[RVWZ]/.test(c)) return 'ASIA';
  return 'OTHER';
}

/** Fire truck models for a landing airport. */
export function fireGroup(t: RescueTitles, icao: string, large: boolean): readonly string[] {
  const na = rescueRegion(icao) === 'NA';
  if (large) return na ? t.fireLargeNa : t.fireLarge;
  return na ? t.fireNa : t.fire;
}

/** Ambulance models for a landing airport. */
export function medicGroup(t: RescueTitles, icao: string): readonly string[] {
  switch (rescueRegion(icao)) {
    case 'NA':
      return t.medicNa;
    case 'JAPAN':
      return t.medicJapan;
    case 'ASIA':
      return t.medicAsia;
    default:
      return t.medic;
  }
}

/** `count` titles from `group`, taking turns from the first; none for an empty group. */
export function vehicleTitles(group: readonly string[], count: number): string[] {
  const g = group.map((s) => s.trim()).filter((s) => s !== '');
  if (g.length === 0) return [];
  const n = Math.max(0, Math.min(count, RESCUE_MAX_VEHICLES));
  return Array.from({ length: n }, (_, i) => g[i % g.length] as string);
}
