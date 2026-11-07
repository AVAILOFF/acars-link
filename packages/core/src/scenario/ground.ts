// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { GroundServices, GsxState, TelemetrySnapshot } from '../telemetry/types.js';
import type { Value } from './expr.js';

/**
 * Ground services by the real state of GSX Pro (T98). The bridge reads the GSX LVars into
 * `TelemetrySnapshot.ground` (states: GSX Pro for MSFS manual 4.0.9 Pro, p. 106, checked
 * 2026-11-07). GSX counts as active once a service was requested in this flight (assumption Д1 of
 * T98, approved by the user 2026-11-07): its states read and one of them requested, performed or
 * completed. Without that the scenarios keep their time-based logic.
 */

/** What the engine keeps of GSX in this flight (part of its state). */
export interface GroundTrack {
  /** A GSX service was requested in this flight (Д1). */
  readonly active: boolean;
  /** When the boarding / refuelling was first seen completed after GSX became active; null = not. */
  readonly boardingDoneAt: number | null;
  readonly refuelDoneAt: number | null;
}

/** Events of the ground services (T98), for `trigger: { on: event }`. */
export const GROUND_EVENTS = ['GSX_BOARDING_DONE', 'GSX_REFUEL_DONE'] as const;
export type GroundEvent = (typeof GROUND_EVENTS)[number];

export const GROUND_VARIABLES = [
  // GSX active in this flight (Д1); false without GSX
  'ground.active',
  // the last reading of each service: available, unavailable, bypassed, requested, performing,
  // completed; null without GSX
  'ground.boarding',
  'ground.deboarding',
  'ground.refuel',
  'ground.catering',
  'ground.departure',
  // GSX is loading luggage / cargo now
  'ground.cargo',
  // the boarding / refuelling of this flight was completed in GSX
  'ground.boarding_done',
  'ground.refuel_done',
  // the refuelling was requested or is being done (the fuel slip waits for it)
  'ground.refuel_busy',
] as const;
export type GroundVariable = (typeof GROUND_VARIABLES)[number];

const STATE_NAMES: Readonly<Record<GsxState, string | null>> = {
  0: null,
  1: 'available',
  2: 'unavailable',
  3: 'bypassed',
  4: 'requested',
  5: 'performing',
  6: 'completed',
};

const REQUESTED = 4;
const PERFORMING = 5;
const COMPLETED = 6;

const requested = (s: GsxState): boolean => s >= REQUESTED;

function anyRequested(g: GroundServices): boolean {
  return (
    requested(g.boarding) ||
    requested(g.deboarding) ||
    requested(g.refuel) ||
    requested(g.catering) ||
    requested(g.departure) ||
    g.cargo
  );
}

/**
 * Updates the track from one sample and returns the events it gives (once per flight each).
 * `null` track = nothing seen yet.
 */
export function trackGround(
  prev: GroundTrack | null,
  tm: TelemetrySnapshot | null,
  now: number,
): { track: GroundTrack | null; events: GroundEvent[] } {
  const g = tm?.ground;
  if (g === undefined) return { track: prev, events: [] };
  const active = (prev?.active ?? false) || anyRequested(g);
  let boardingDoneAt = prev?.boardingDoneAt ?? null;
  let refuelDoneAt = prev?.refuelDoneAt ?? null;
  const events: GroundEvent[] = [];
  if (active && boardingDoneAt === null && g.boarding === COMPLETED) {
    boardingDoneAt = now;
    events.push('GSX_BOARDING_DONE');
  }
  if (active && refuelDoneAt === null && g.refuel === COMPLETED) {
    refuelDoneAt = now;
    events.push('GSX_REFUEL_DONE');
  }
  return { track: { active, boardingDoneAt, refuelDoneAt }, events };
}

/** `ground.*` for the scenarios. */
export function groundVariables(
  track: GroundTrack | null,
  tm: TelemetrySnapshot | null,
): Record<GroundVariable, Value> {
  const g = tm?.ground;
  const name = (s: GsxState | undefined) => (s === undefined ? null : STATE_NAMES[s]);
  return {
    'ground.active': track?.active ?? false,
    'ground.boarding': name(g?.boarding),
    'ground.deboarding': name(g?.deboarding),
    'ground.refuel': name(g?.refuel),
    'ground.catering': name(g?.catering),
    'ground.departure': name(g?.departure),
    'ground.cargo': g?.cargo ?? false,
    'ground.boarding_done': track?.boardingDoneAt != null,
    'ground.refuel_done': track?.refuelDoneAt != null,
    'ground.refuel_busy':
      track?.active === true && (g?.refuel === REQUESTED || g?.refuel === PERFORMING),
  };
}
