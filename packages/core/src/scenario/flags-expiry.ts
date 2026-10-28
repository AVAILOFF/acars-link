// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { Value } from './expr.js';

/**
 * Lifetime of the airline memory (T41): the flags a scenario leaves for a later flight come
 * in families that share a `<prefix>_date` (the scheduled OUT of the flight that left them,
 * epoch ms). A family older than its lifetime is dropped when a flight starts. Lifetimes
 * are game assumptions approved by the user (2026-10-14): an open MEL item is deferred for
 * up to 10 days (category C), a banned passenger and a discretion report stay 30 days, rush
 * bags 3. Flags of no family (and families without a date) are kept.
 */

const DAY = 86_400_000;

export const FLAG_FAMILIES: readonly {
  readonly prefix: string;
  readonly days: number;
  readonly names: readonly string[];
}[] = [
  { prefix: 'mel', days: 10, names: ['mel_item', 'mel_reg', 'mel_date'] },
  {
    prefix: 'unruly',
    days: 30,
    names: ['unruly_seat', 'unruly_flight', 'unruly_date'],
  },
  { prefix: 'crew_discretion', days: 30, names: ['crew_discretion', 'crew_discretion_date'] },
  { prefix: 'rush', days: 3, names: ['rush_bags', 'rush_from', 'rush_to', 'rush_date'] },
  // After a diversion (T44): the next flight from the diversion airport, within 3 days.
  // An inspection after a confirmed hard landing (T46): done before the next flight; 3 days (game assumption).
  { prefix: 'hardland', days: 3, names: ['hardland_reg', 'hardland_date'] },
  { prefix: 'recovery', days: 3, names: ['recovery_airport', 'recovery_flight', 'recovery_date'] },
];

/** `flags` without the expired families; `nowMs` = scheduled OUT of the new flight. */
export function pruneExpiredFlags(
  flags: Readonly<Record<string, Value>>,
  nowMs: number,
): Record<string, Value> {
  const out = { ...flags };
  for (const f of FLAG_FAMILIES) {
    const date = out[`${f.prefix}_date`];
    if (typeof date !== 'number' || nowMs - date <= f.days * DAY) continue;
    for (const n of f.names) delete out[n];
  }
  return out;
}
