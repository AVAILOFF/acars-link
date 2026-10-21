import type { AircraftFamily } from '../scenario/aircraft.js';

/**
 * AeroDataBox `aircraft.model` (free text, "Aircraft name and model") → the T40 family (T55, R2).
 *
 * The table is every string of a live FIDS answer (EDDF departures, 615 flights, 2026-10-21; see
 * `packages/data-sources/test/fixtures/README.md`), compared case-insensitively with the spaces
 * squeezed (the answer had both `(Sharklets)` and `(sharklets)`). A string not in the table has no
 * family: the flight does not match the aircraft type (R2). `null` entries are strings that were
 * seen but name no T40 family: the A220 is not one, `Regional-Jet` names no type.
 */
const MODELS: Readonly<Record<string, AircraftFamily | null>> = {
  'ATR 72': 'ATR',
  'AIRBUS A220-100': null,
  'AIRBUS A220-300': null,
  'AIRBUS A319': 'A320',
  'AIRBUS A320': 'A320',
  'AIRBUS A320 (SHARKLETS)': 'A320',
  'AIRBUS A320 NEO': 'A320',
  'AIRBUS A321': 'A320',
  'AIRBUS A321 (SHARKLETS)': 'A320',
  'AIRBUS A321 NEO': 'A320',
  'AIRBUS A330': 'A330',
  'AIRBUS A350-900': 'A350',
  'AIRBUS A380': 'A380',
  'BOEING 737 MAX 8': 'B737',
  'BOEING 737-800': 'B737',
  'BOEING 747': 'B747',
  'BOEING 747-8': 'B747',
  'BOEING 777': 'B777',
  'BOEING 777-200': 'B777',
  'BOEING 777-300': 'B777',
  'BOEING 787-10': 'B787',
  'BOEING 787-8': 'B787',
  'BOEING 787-9': 'B787',
  'EMBRAER 190': 'E-JET',
  'EMBRAER 195': 'E-JET',
  'REGIONAL-JET': null,
};

/** The T40 family of an AeroDataBox model string; null when unknown or not a T40 family. */
export function modelFamily(model: string | null | undefined): AircraftFamily | null {
  if (typeof model !== 'string') return null;
  return MODELS[model.trim().replace(/\s+/g, ' ').toUpperCase()] ?? null;
}
