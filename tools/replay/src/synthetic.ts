// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import {
  DEFAULT_STATION,
  type DisplayProfile,
  generateSyntheticFlight,
  type Ofp,
  type SyntheticFlightOptions,
  selectProfile,
  type TelemetrySnapshot,
} from '@acars/core';
import { eventsFromSnapshots, type Recording, recordingHeader } from './format.js';

/**
 * Recordings without a sim: a synthetic flight from the OFP (docs/04 "Тестирование"), or a
 * bridge snapshot dump plus an OFP.
 */

export interface RecordingMeta {
  readonly ofp: Ofp;
  readonly scenarios: readonly string[];
  readonly seed?: string | number | null;
  readonly station?: string;
  readonly profile?: DisplayProfile;
}

export function recordingFromSnapshots(
  snapshots: readonly TelemetrySnapshot[],
  meta: RecordingMeta,
  source = 'snapshots',
): Recording {
  return {
    header: recordingHeader({
      recordedAt: snapshots[0]?.t ?? meta.ofp.times.schedOutMs,
      source,
      ofp: meta.ofp,
      seed: meta.seed ?? null,
      station: meta.station ?? DEFAULT_STATION,
      profile: meta.profile ?? selectProfile({ icao: meta.ofp.aircraft.icao }),
      scenarios: meta.scenarios,
      sessionFired: [],
      namesVersion: 2,
      nextLegVersion: 3,
      lateStartVersion: 3,
    }),
    events: eventsFromSnapshots(snapshots),
  };
}

export function syntheticRecording(
  meta: RecordingMeta,
  flight: Omit<SyntheticFlightOptions, 'ofp'> = {},
): Recording {
  const { snapshots } = generateSyntheticFlight({ ...flight, ofp: meta.ofp });
  return recordingFromSnapshots(snapshots, meta, 'synthetic');
}
