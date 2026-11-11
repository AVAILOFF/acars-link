// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

/**
 * One telemetry sample from the sim bridge (~1 Hz), docs/03-architecture.md "TelemetrySnapshot (v1)".
 * Example: reference/telemetry.sample.json.
 *
 * SimVar names and units are listed in docs/03 and are still `[VERIFY]` against the
 * MSFS SDK; they matter for the bridge (T08), not for this type.
 */
export const TELEMETRY_VERSION = 1;

export interface TelemetrySnapshot {
  /** Schema version, {@link TELEMETRY_VERSION}. */
  readonly v: 1;
  /** Sample time, epoch ms UTC (bridge wall clock). */
  readonly t: number;

  readonly lat: number;
  readonly lon: number;
  /** Altitude MSL, ft. */
  readonly altFt: number;
  /** Altitude above ground, ft. */
  readonly aglFt: number;
  readonly iasKt: number;
  readonly gsKt: number;
  readonly vsFpm: number;
  /** True heading, degrees 0..360. */
  readonly hdgTrue: number;

  readonly onGround: boolean;
  readonly parkingBrake: boolean;
  readonly beacon: boolean;
  /** Per engine, index 0 = engine 1. */
  readonly engRunning: readonly boolean[];
  /** Per engine N2, percent. */
  readonly engN2: readonly number[];
  /** Total fuel, kg (bridge requests kilograms). */
  readonly fuelKg: number;
  readonly gearDown: boolean;
  readonly flapsIdx: number;
  /** Per exit, percent open (0..100). Many add-ons do not report it. */
  readonly doorsOpen: readonly number[];
  /** TRANSPONDER STATE:1 raw enum value (meaning `[VERIFY]` in the SDK docs). */
  readonly xpdrState: number;
  /** 1 = real time, 4 = ×4 … */
  readonly simRate: number;
  readonly paused: boolean;
  /** Aircraft TITLE string, used to pick a DisplayProfile. */
  readonly aircraftTitle: string;
  /**
   * Descent rate at the last touchdown, ft/min, positive = down (T46; SimVar PLANE TOUCHDOWN
   * NORMAL VELOCITY, ft/s × 60). The sim keeps it until the next touchdown, so it is only
   * meaningful right after landing. Absent in older recordings and sources without the SimVar.
   */
  readonly touchdownFpm?: number;
  /**
   * The sim clock, epoch ms UTC (SimVar ABSOLUTE TIME, zulu). Absent in older recordings and
   * sources without a date. The app may use it as the flight's clock (setting "time from the sim").
   */
  readonly simUtcMs?: number;
  /**
   * GSX Pro ground services (T98), from its LVars (MSFS bridge). Absent without GSX (GSX not
   * running, X-Plane) and in older recordings.
   */
  readonly ground?: GroundServices;
}

/**
 * A GSX service state, `L:FSDT_GSX_*_STATE` (GSX Pro for MSFS manual 4.0.9 Pro, p. 106, checked
 * 2026-11-07): 1 can be called, 2 not available, 3 bypassed, 4 requested, 5 being performed,
 * 6 completed; 0 = not reported.
 */
export type GsxState = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface GroundServices {
  readonly boarding: GsxState;
  readonly deboarding: GsxState;
  readonly refuel: GsxState;
  readonly catering: GsxState;
  /** Pushback (GSX "departure"). */
  readonly departure: GsxState;
  /** GSX is loading luggage / cargo (`L:FSDT_GSX_BOARDING_CARGO`). */
  readonly cargo: boolean;
}

const GSX_SERVICES = ['boarding', 'deboarding', 'refuel', 'catering', 'departure'] as const;

function isGround(x: unknown): x is GroundServices {
  if (typeof x !== 'object' || x === null) return false;
  const g = x as Record<string, unknown>;
  return (
    GSX_SERVICES.every(
      (k) => Number.isInteger(g[k]) && (g[k] as number) >= 0 && (g[k] as number) <= 6,
    ) && typeof g['cargo'] === 'boolean'
  );
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isBool = (x: unknown): x is boolean => typeof x === 'boolean';
const isArr = <T>(x: unknown, item: (y: unknown) => y is T): boolean =>
  Array.isArray(x) && x.every(item);

const NUM_FIELDS = [
  't',
  'lat',
  'lon',
  'altFt',
  'aglFt',
  'iasKt',
  'gsKt',
  'vsFpm',
  'hdgTrue',
  'fuelKg',
  'flapsIdx',
  'xpdrState',
  'simRate',
] as const;
const BOOL_FIELDS = ['onGround', 'parkingBrake', 'beacon', 'gearDown', 'paused'] as const;

/** Shape check of untrusted input (bridge frames, recordings) against {@link TelemetrySnapshot} v1. */
export function isTelemetrySnapshot(x: unknown): x is TelemetrySnapshot {
  if (typeof x !== 'object' || x === null) return false;
  const s = x as Record<string, unknown>;
  return (
    s['v'] === TELEMETRY_VERSION &&
    NUM_FIELDS.every((k) => isNum(s[k])) &&
    BOOL_FIELDS.every((k) => isBool(s[k])) &&
    isArr(s['engRunning'], isBool) &&
    isArr(s['engN2'], isNum) &&
    isArr(s['doorsOpen'], isNum) &&
    typeof s['aircraftTitle'] === 'string' &&
    (s['touchdownFpm'] === undefined || isNum(s['touchdownFpm'])) &&
    (s['simUtcMs'] === undefined || isNum(s['simUtcMs'])) &&
    (s['ground'] === undefined || isGround(s['ground']))
  );
}
