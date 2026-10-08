/**
 * One telemetry sample from the sim bridge (~1 Hz), docs/03-architecture.md "TelemetrySnapshot (v1)".
 * Example: reference/telemetry.sample.json.
 *
 * SimVar names and units are listed in docs/03 and are still `[ПРОВЕРИТЬ]` against the
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
  /** TRANSPONDER STATE:1 raw enum value (meaning `[ПРОВЕРИТЬ]` in the SDK docs). */
  readonly xpdrState: number;
  /** 1 = real time, 4 = ×4 … */
  readonly simRate: number;
  readonly paused: boolean;
  /** Aircraft TITLE string, used to pick a DisplayProfile. */
  readonly aircraftTitle: string;
}
