// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { FeedEntry, SystemCode } from '../../shared/api.js';

/**
 * System lines that ask the pilot to do something (T56 U-15): marked "action needed" in the feed
 * and kept in the status bar until a later line settles them or the flight ends.
 */
type SystemEntry = Extract<FeedEntry, { kind: 'system' }>;

const ACTION_CODES: ReadonlySet<SystemCode> = new Set<SystemCode>([
  'flt_nbr_hint',
  'atc_needs_data',
  'link_needs_data',
  'telemetry_lost',
  'transport_status',
  'next_ofp_failed',
]);

/** Needs the pilot: a network status only while it is a problem. */
export function isAction(e: FeedEntry): e is SystemEntry {
  if (e.kind !== 'system' || !ACTION_CODES.has(e.code)) return false;
  if (e.code !== 'transport_status') return true;
  return e.params['status'] === 'degraded' || e.params['status'] === 'halted';
}

/** A later line that settles an action line: telemetry back, the network OK again. */
function settles(later: FeedEntry, action: SystemEntry): boolean {
  if (later.kind !== 'system') return false;
  if (action.code === 'telemetry_lost') return later.code === 'telemetry_restored';
  if (action.code === 'transport_status') return later.code === 'transport_status';
  // The hints of a flight (FLT NBR, live data needed) hold until it ends.
  return later.code === 'flight_stopped' || later.code === 'flight_started';
}

/**
 * Action lines still open, oldest first. A line is open until something later settles it; a newer
 * network problem replaces the older one. `next_ofp_failed` comes after the stop: it holds until the
 * next flight starts.
 */
export function openActions(feed: readonly FeedEntry[]): SystemEntry[] {
  const open: SystemEntry[] = [];
  for (const e of feed) {
    for (let i = open.length - 1; i >= 0; i--) {
      const a = open[i] as SystemEntry;
      if (
        a.code === 'next_ofp_failed'
          ? e.kind === 'system' && e.code === 'flight_started'
          : settles(e, a)
      ) {
        open.splice(i, 1);
      }
    }
    if (isAction(e)) open.push(e);
  }
  return open;
}
