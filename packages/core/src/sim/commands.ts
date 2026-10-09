/**
 * Commands to the simulator (T21): the second kind of core output next to telexes.
 *
 * - `ping` (no arguments) goes to the sim bridge (bridge/msfs/README.md, protocol v2), which
 *   runs only whitelisted names ({@link SIM_COMMANDS}) and acknowledges each one. The argument
 *   rules here mirror the bridge's `CommandCatalog`; both sides check.
 * - `vdgs` (T22) is text for the GSX docking display (`sim/vdgs.ts`). The app writes it to
 *   GSX's message folder itself; it never goes to the bridge.
 */

import type { VdgsMessage } from './vdgs.js';

/** Commands the sim bridge runs (its whitelist). */
export const SIM_COMMANDS = ['ping'] as const;
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

/** Text for the GSX VDGS of the arrival airport (T22). */
export interface VdgsCommand extends CommandBase {
  readonly command: 'vdgs';
  readonly vdgs: VdgsMessage;
}

export type SimCommand = BridgeCommand | VdgsCommand;

/** Limits shared with the bridge (`CommandCatalog`). */
export const SIM_COMMAND_LIMITS = { maxArgs: 16, maxStringArg: 512 } as const;

const ARG_NAME_RE = /^[a-z][A-Za-z0-9_]{0,31}$/;

const VALIDATORS: Readonly<Record<SimCommandName, (args: SimCommandArgs) => string | null>> = {
  ping: (args) => (Object.keys(args).length === 0 ? null : 'ping takes no arguments'),
};

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
