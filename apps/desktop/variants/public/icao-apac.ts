// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

/**
 * Public build (T72): stands in for `packages/core/src/atc/squawk/icao-apac.ts` (ICAO APAC eANP,
 * "All rights reserved"). Empty, so the APAC table never matches; the core option
 * `squawkTables: 'public'` skips it as well. See `electron.vite.config.ts`, THIRD-PARTY-NOTICES.md.
 */

export const ICAO_APAC_VERSION = 'not included in the public build';

export interface ApacFir {
  readonly firs: readonly string[];
  readonly blocks: readonly (readonly [string, string, 'I' | 'D', string | null])[];
}

export const ICAO_APAC_FIRS: Readonly<Record<string, ApacFir>> = {};
