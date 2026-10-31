// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

/**
 * Public build (T72): stands in for `packages/core/src/atc/squawk/eur-cal.ts` (EUROCONTROL CAL,
 * not licensed for redistribution). Empty, so the EUR table never matches; the core option
 * `squawkTables: 'public'` skips it as well. See `electron.vite.config.ts`, THIRD-PARTY-NOTICES.md.
 */

export const EUR_CAL_VERSION = 'not included in the public build';

export const EUR_CAL_PAS: Readonly<Record<string, readonly string[]>> = {};

export const EUR_CAL_ROWS: readonly (readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
])[] = [];
