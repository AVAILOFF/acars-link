// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { Ofp, OfpTimes } from './types.js';

const DAY_MS = 86_400_000;

/**
 * The OFP's date follows the flight's clock (decision of 2026-10-22, docs/05 "Дата OFP"): a plan
 * made for another day (SimBrief keeps the date it was planned for) has every absolute time moved
 * by whole days so that STD is the nearest one to `now`, at most 12 h away. The time of day stays
 * as planned. `days` is the shift (0 = the OFP is already within 12 h of `now`).
 */
export function alignOfpDay(ofp: Ofp, now: number): { readonly ofp: Ofp; readonly days: number } {
  const days = Math.round((now - ofp.times.schedOutMs) / DAY_MS);
  if (days === 0) return { ofp, days: 0 };
  const d = days * DAY_MS;
  const shift = (ms: number | null) => (ms === null ? null : ms + d);
  const t = ofp.times;
  const times: OfpTimes = {
    ...t,
    schedOutMs: t.schedOutMs + d,
    schedOffMs: shift(t.schedOffMs),
    schedOnMs: shift(t.schedOnMs),
    schedInMs: t.schedInMs + d,
    estOutMs: t.estOutMs + d,
    estOffMs: shift(t.estOffMs),
    estOnMs: shift(t.estOnMs),
    estInMs: t.estInMs + d,
  };
  return { ofp: { ...ofp, times }, days };
}
