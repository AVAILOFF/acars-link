// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { NatTrack } from '@acars/core';

/**
 * Public build (T72): stands in for `packages/data-sources/src/nattrak.ts` (natTrak, VATSIM; no
 * published terms of use). No request is made; NAT tracks come from the SimBrief OFP only.
 */

export const NATTRAK_TRACKS_URL = '';

export async function fetchNatTracks(): Promise<NatTrack[]> {
  return [];
}

export function parseNatTracks(): NatTrack[] {
  return [];
}
