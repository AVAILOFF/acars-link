// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { SquawkTables } from '@acars/core';

/** Set by `electron.vite.config.ts` (`ACARS_BUILD=public`); absent under Vitest and in dev. */
declare const __ACARS_PUBLIC__: boolean | undefined;

/**
 * Build variant (T72, docs/07): the public build has no EUROCONTROL CAL / ICAO APAC squawk tables
 * and no natTrak adapter (not licensed for redistribution); the personal build has everything.
 */
export const PUBLIC_BUILD: boolean = typeof __ACARS_PUBLIC__ !== 'undefined' && __ACARS_PUBLIC__;

/** Squawk tables the core uses in this build; recorded in the flight header with `xatc`. */
export const SQUAWK_TABLES: SquawkTables = PUBLIC_BUILD ? 'public' : 'full';
