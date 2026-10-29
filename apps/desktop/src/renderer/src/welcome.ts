// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { AppState, CredentialsView, Settings } from '../../shared/api.js';

/**
 * The welcome, the interface tour and the readiness list (T70, U-01, U-02): what is still to do
 * before the first flight and where the tour points. Derived from the state only; no React here.
 */

export type ReadyKey = 'simbrief' | 'network' | 'bridge' | 'sim' | 'ofp';
/** `wait`: on its way (the bridge connects, the sim is in its menu); `todo`: needs the user. */
export type ReadyState = 'ok' | 'wait' | 'todo';

/** A settings field to open for an item: the input id on the settings page. */
export interface ReadyFix {
  readonly field: string;
  /** The field is under "Advanced settings". */
  readonly advanced: boolean;
}

export interface ReadyItem {
  readonly key: ReadyKey;
  readonly state: ReadyState;
  /** Offline mode stands in for the Hoppie code: the item is done, the text says so. */
  readonly offline: boolean;
  readonly fix: ReadyFix | null;
}

const SIMBRIEF_FIX: ReadyFix = { field: 'sb-user', advanced: false };
const HOPPIE_FIX: ReadyFix = { field: 'hoppie-code', advanced: false };
const SIM_FIX: ReadyFix = { field: 'sim-choice', advanced: true };

export function readiness(
  app: Pick<AppState, 'bridge' | 'flight'>,
  creds: Pick<CredentialsView, 'simbriefUsername' | 'hoppieCodeSet'>,
  settings: Pick<Settings, 'transport'>,
): readonly ReadyItem[] {
  const offline = settings.transport === 'offline';
  const b = app.bridge;
  const bridge: ReadyState = b.link === 'open' ? 'ok' : b.link === 'connecting' ? 'wait' : 'todo';
  const sim: ReadyState =
    b.link !== 'open' || b.sim === null || b.sim === 'disconnected'
      ? 'todo'
      : b.sim === 'connected' && b.running
        ? 'ok'
        : 'wait';
  const item = (key: ReadyKey, done: ReadyState, fix: ReadyFix | null): ReadyItem => ({
    key,
    state: done,
    offline: key === 'network' && offline,
    fix: done === 'ok' ? null : fix,
  });
  return [
    item('simbrief', creds.simbriefUsername === '' ? 'todo' : 'ok', SIMBRIEF_FIX),
    item('network', offline || creds.hoppieCodeSet ? 'ok' : 'todo', HOPPIE_FIX),
    item('bridge', bridge, SIM_FIX),
    item('sim', sim, SIM_FIX),
    item('ofp', app.flight === null ? 'todo' : 'ok', null),
  ];
}

/** Steps of the welcome dialog. */
export const WELCOME_STEPS = ['hello', 'accounts', 'sim', 'first'] as const;
export type WelcomeStep = (typeof WELCOME_STEPS)[number];

/**
 * Stops of the interface tour, in order: the `data-tour` mark of the element. All of them are on
 * the "Messages" tab, so the tour opens it first.
 */
export const TOUR_STOPS = ['rail', 'top', 'feed', 'flight', 'fms', 'status'] as const;
export type TourStop = (typeof TOUR_STOPS)[number];

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Gap between the highlighted element and the tour card, and to the window edge. */
export const TOUR_GAP = 12;

/**
 * Where the tour card goes: right of the element, else left, below, above; inside the window.
 * When none fits (a huge element), over the element's centre.
 */
export function placeCard(
  target: Box,
  card: Pick<Box, 'w' | 'h'>,
  view: Pick<Box, 'w' | 'h'>,
): { x: number; y: number } {
  const g = TOUR_GAP;
  const clampX = (x: number) => Math.max(g, Math.min(x, view.w - card.w - g));
  const clampY = (y: number) => Math.max(g, Math.min(y, view.h - card.h - g));
  const midY = clampY(target.y + target.h / 2 - card.h / 2);
  const midX = clampX(target.x + target.w / 2 - card.w / 2);
  if (target.x + target.w + g + card.w + g <= view.w)
    return { x: target.x + target.w + g, y: midY };
  if (target.x - g - card.w >= g) return { x: target.x - g - card.w, y: midY };
  if (target.y + target.h + g + card.h + g <= view.h)
    return { x: midX, y: target.y + target.h + g };
  if (target.y - g - card.h >= g) return { x: midX, y: target.y - g - card.h };
  return { x: midX, y: midY };
}
