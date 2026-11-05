// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

/**
 * Commands to the simulator (T21): the second kind of core output next to telexes.
 *
 * - `ping` (no arguments) goes to the sim bridge (bridge/msfs/README.md, protocol v2), which
 *   runs only whitelisted names ({@link SIM_COMMANDS}) and acknowledges each one. The argument
 *   rules here mirror the bridge's `CommandCatalog`; both sides check.
 * - `smoke_start` (`lat`, `lon`) / `smoke_stop` (T34): a smoke column at a point; the bridge
 *   spawns it when the aircraft is near (see `bridge/msfs/README.md`).
 * - `rescue_start` / `rescue_stop` (T54): fire trucks and an ambulance at the landing runway; the
 *   bridge's `RescueController` spawns, moves and removes them.
 * - `vdgs` (T22) is text for the GSX docking display (`sim/vdgs.ts`). The app writes it to
 *   GSX's message folder itself; it never goes to the bridge.
 */

import type { RescueLevel } from '../scenario/types.js';
import type { VdgsMessage } from './vdgs.js';

/** Commands the sim bridge runs (its whitelist). */
export const SIM_COMMANDS = [
  'ping',
  'smoke_start',
  'smoke_stop',
  'rescue_start',
  'rescue_stop',
] as const;
export type SimCommandName = (typeof SIM_COMMANDS)[number];

export type SimCommandArg = string | number | boolean;
export type SimCommandArgs = Readonly<Record<string, SimCommandArg>>;

interface CommandBase {
  /** Scenario that produced it. */
  readonly scenarioId: string;
  /** Clock time it was produced, epoch ms. */
  readonly t: number;
}

/** A command for the sim bridge. */
export interface BridgeCommand extends CommandBase {
  readonly command: SimCommandName;
  readonly args: SimCommandArgs;
}

/** Text for the GSX VDGS (T22); null = take the scenario's text down (T102, `vdgs: stop`). */
export interface VdgsCommand extends CommandBase {
  readonly command: 'vdgs';
  readonly vdgs: VdgsMessage | null;
}

/**
 * Smoke column at or near a runway of the departure or destination airport (T34, scenario step
 * `smoke`). The app looks up the runway's middle (OurAirports), moves it by `offset` and sends the
 * bridge `smoke_start` / `smoke_stop`; the core only names the airport, the runway and the
 * offset, so a recording replays without the lookup.
 */
export interface SmokeCommand extends CommandBase {
  readonly command: 'smoke';
  readonly action: 'start' | 'stop';
  readonly airport: string;
  /** Planned runway (`24R`), null when the OFP has none. */
  readonly runway: string | null;
  /**
   * From the runway's middle, NM: along it in the direction of `runway` (negative = back) and
   * off its axis (positive = right of that direction); absent = at the middle.
   */
  readonly offset?: { readonly alongNm: number; readonly sideNm: number } | null;
}

/**
 * Rescue services at the landing airport (T54, scenario step `rescue`). The core names the airport
 * (`flight.divert`, else the destination), the planned runway when it lands at the destination and
 * the level; the app looks up the runway (OurAirports), picks the vehicles and sends the bridge
 * `rescue_start` / `rescue_stop`, so a recording replays without the lookup.
 */
export interface RescueCommand extends CommandBase {
  readonly command: 'rescue';
  readonly action: 'start' | 'stop';
  /** Null for `stop`. */
  readonly level: RescueLevel | null;
  readonly airport: string;
  /** Planned runway of the destination (`24R`); null at a diversion airport or without one. */
  readonly runway: string | null;
  /**
   * Wind direction of the airport's METAR, degrees true (live, else the OFP's); null when calm,
   * variable or unknown. Without a planned runway the app lands on the end of the longest runway
   * that faces it (user decision 2026-10-17).
   */
  readonly windFromDeg: number | null;
}

export type SimCommand = BridgeCommand | VdgsCommand | SmokeCommand | RescueCommand;

/** Most vehicles of one `rescue_start` (shared with the bridge's `RescueController`). */
export const RESCUE_MAX_VEHICLES = 8;

/** Limits shared with the bridge (`CommandCatalog`). */
export const SIM_COMMAND_LIMITS = { maxArgs: 16, maxStringArg: 512 } as const;

const ARG_NAME_RE = /^[a-z][A-Za-z0-9_]{0,31}$/;

const VALIDATORS: Readonly<Record<SimCommandName, (args: SimCommandArgs) => string | null>> = {
  ping: (args) => (Object.keys(args).length === 0 ? null : 'ping takes no arguments'),
  smoke_start: (args) => {
    const keys = Object.keys(args);
    if (keys.length !== 2 || !('lat' in args) || !('lon' in args)) return 'needs lat and lon only';
    const { lat, lon } = args;
    if (typeof lat !== 'number' || !(lat >= -90 && lat <= 90)) return 'lat must be -90..90';
    if (typeof lon !== 'number' || !(lon >= -180 && lon <= 180)) return 'lon must be -180..180';
    return null;
  },
  smoke_stop: (args) => (Object.keys(args).length === 0 ? null : 'smoke_stop takes no arguments'),
  rescue_start: checkRescueStart,
  rescue_stop: (args) => (Object.keys(args).length === 0 ? null : 'rescue_stop takes no arguments'),
};

const RESCUE_ARGS = [
  'level',
  'thrLat',
  'thrLon',
  'hdg',
  'lengthM',
  'side',
  'fire',
  'fireFlip',
  'medic',
];

/**
 * `rescue_start` (T54): `level` (`full` | `standby` | `medical`), the landing threshold `thrLat`,
 * `thrLon`, the runway's true course `hdg` and `lengthM`, the `side` of the runway the trucks wait on
 * (`left` | `right` of the landing direction), the SimObject titles `fire`, `medic` and `fireFlip` — `0` | `1`
 * per fire truck, joined by `|` like `fire` (`1`: the model is drawn nose to tail with its heading, turn it 180°):
 * one per vehicle, joined by `|` (empty = none). Fire trucks only with `full` / `standby`.
 */
function checkRescueStart(args: SimCommandArgs): string | null {
  const keys = Object.keys(args);
  if (keys.length !== RESCUE_ARGS.length || !RESCUE_ARGS.every((k) => k in args)) {
    return `needs ${RESCUE_ARGS.join(', ')} only`;
  }
  const { level, thrLat, thrLon, hdg, lengthM, fire, medic } = args;
  if (level !== 'full' && level !== 'standby' && level !== 'medical') {
    return 'level must be full, standby or medical';
  }
  if (typeof thrLat !== 'number' || !(thrLat >= -90 && thrLat <= 90))
    return 'thrLat must be -90..90';
  if (typeof thrLon !== 'number' || !(thrLon >= -180 && thrLon <= 180)) {
    return 'thrLon must be -180..180';
  }
  if (typeof hdg !== 'number' || !(hdg >= 0 && hdg < 360)) return 'hdg must be 0..360';
  if (typeof lengthM !== 'number' || !(lengthM > 0 && lengthM <= 10_000)) {
    return 'lengthM must be 0..10000';
  }
  for (const [name, v] of [
    ['fire', fire],
    ['medic', medic],
  ] as const) {
    if (typeof v !== 'string') return `${name} must be a string`;
    const titles = v === '' ? [] : v.split('|');
    if (titles.length > RESCUE_MAX_VEHICLES)
      return `${name}: at most ${RESCUE_MAX_VEHICLES} titles`;
    if (titles.some((t) => t.trim() === '' || t !== t.trim())) return `${name}: empty title`;
  }
  if (args['side'] !== 'left' && args['side'] !== 'right') return 'side must be left or right';
  if (level === 'medical' && fire !== '') return 'medical takes no fire trucks';
  const flips = args['fireFlip'];
  if (typeof flips !== 'string') return 'fireFlip must be a string';
  const nFire = fire === '' ? 0 : String(fire).split('|').length;
  const f = flips === '' ? [] : flips.split('|');
  if (f.length !== nFire || f.some((x) => x !== '0' && x !== '1')) {
    return 'fireFlip: 0 or 1 per fire truck, joined by |';
  }
  return null;
}

export function isSimCommandName(name: unknown): name is SimCommandName {
  return typeof name === 'string' && (SIM_COMMANDS as readonly string[]).includes(name);
}

/** Null when the bridge would accept `name` with `args`, else why not. */
export function checkSimCommand(name: unknown, args: unknown): string | null {
  if (!isSimCommandName(name)) return `unknown command ${String(name)}`;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return 'args must be an object';
  }
  const entries = Object.entries(args);
  if (entries.length > SIM_COMMAND_LIMITS.maxArgs) return 'too many args';
  for (const [k, v] of entries) {
    if (!ARG_NAME_RE.test(k)) return `bad arg name ${k}`;
    const ok =
      typeof v === 'boolean' ||
      (typeof v === 'number' && Number.isFinite(v)) ||
      (typeof v === 'string' && v.length <= SIM_COMMAND_LIMITS.maxStringArg);
    if (!ok) return `arg ${k} must be a string, number or boolean`;
  }
  return VALIDATORS[name](args as SimCommandArgs);
}
