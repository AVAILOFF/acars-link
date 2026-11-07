// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type GroundServices, generateSyntheticFlight, parseSimbriefOfp } from '@acars/core';
import { describe, expect, it } from 'vitest';
import {
  compareOutbound,
  encodeRecording,
  formatReport,
  parseJsonl,
  recordingFromSnapshots,
  replay,
} from '../src/index.js';
import { defaultEnabled, pickScenarios, type ScenarioFile } from '../src/scenarios.js';

/** T98: the GSX states are part of the recorded telemetry, so a replay reproduces them. */

const ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../../packages/core/test/fixtures/ofp/rctp-rjbb-a35k-kgs.json'),
      'utf8',
    ),
  ),
);
const BASE_DIR = join(import.meta.dirname, '../../../packages/scenarios/base');
const base: ScenarioFile[] = readdirSync(BASE_DIR)
  .filter((f) => f.endsWith('.yaml'))
  .sort()
  .map((f) => ({ file: f, source: readFileSync(join(BASE_DIR, f), 'utf8') }));
const enabled = defaultEnabled(base);
const all = pickScenarios({ base, extra: [], recorded: enabled }).scenarios;
const MIN = 60_000;
const STD = ofp.times.schedOutMs;

describe('a recording with GSX (T98)', () => {
  const done = STD - 3 * MIN;
  const ground = (t: number): GroundServices => ({
    boarding: t < STD - 30 * MIN ? 1 : t < done ? 5 : 6,
    deboarding: 1,
    refuel: 1,
    catering: 1,
    departure: 1,
    cargo: false,
  });
  const snaps = generateSyntheticFlight({ ofp }).snapshots.map((s) => ({
    ...s,
    ground: ground(s.t),
  }));
  const rec = recordingFromSnapshots(snaps, { ofp, scenarios: enabled, seed: 't98' });

  it('the ground field survives the file; the replay sends BOARDING COMPLETED and the loadsheet after it', () => {
    const parsed = parseJsonl(encodeRecording(rec));
    expect(parsed.kind).toBe('recording');
    if (parsed.kind !== 'recording') return;
    const r = replay(parsed.recording, { scenarios: all });
    const t = (id: string) => r.outbound.find((m) => m.scenarioId === id)?.t ?? 0;
    expect(t('boarding_completed')).toBeGreaterThanOrEqual(done);
    expect(t('final_loadsheet')).toBeGreaterThanOrEqual(t('boarding_completed') + MIN);
    expect(formatReport(r, { brief: true })).toContain('GSX        boarding completed');
    // Deterministic: the same recording, the same messages.
    const again = replay(rec, { scenarios: all });
    expect(
      compareOutbound(
        again.outbound.map((m) => ({
          type: 'out',
          t: m.t,
          scenarioId: m.scenarioId,
          from: m.from,
          to: m.to,
          text: m.message.text,
        })),
        r.outbound,
      ),
    ).toEqual([]);
  });
});
