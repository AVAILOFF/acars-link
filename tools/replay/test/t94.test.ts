// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AcarsCore,
  generateSyntheticFlight,
  type Ofp,
  type OutboundMessage,
  parseSimbriefOfp,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import {
  compareOutbound,
  encodeRecording,
  parseJsonl,
  type Recording,
  recordedCoreOptions,
  recordingFromSnapshots,
  replay,
} from '../src/index.js';
import { defaultEnabled, pickScenarios, type ScenarioFile } from '../src/scenarios.js';

/** T94: the FDM events and letter come back the same from a recording; old recordings unchanged. */

const ofp: Ofp = parseSimbriefOfp(
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
const scenarios = pickScenarios({ base, extra: [], recorded: enabled }).scenarios;

// The synthetic flight has FDM events of its own: flaps 3 at 1000 ft and 4 at the touchdown, more
// than 255 kt for a while below 10 000 ft in the descent.
const snapshots = generateSyntheticFlight({ ofp }).snapshots;
const old = recordingFromSnapshots(snapshots, { ofp, scenarios: enabled });
const withFdm: Recording = { ...old, header: { ...old.header, fdm: true } };

const asRecorded = (out: readonly OutboundMessage[]) =>
  out.map((m) => ({
    type: 'out' as const,
    t: m.t,
    scenarioId: m.scenarioId,
    from: m.from,
    to: m.to,
    text: m.message.text,
  }));

describe('FDM in recordings (T94)', () => {
  it('the replay gives the letter and the events of the live run', () => {
    // "Live": the core as the app runs it, from the header's options.
    const core = AcarsCore.create(recordedCoreOptions(withFdm.header, scenarios));
    const live: OutboundMessage[] = [];
    for (const e of withFdm.events) {
      if (e.type === 'start') core.startFlight();
      if (e.type === 'tick')
        live.push(...core.tick({ now: e.now, telemetry: e.telemetry }).outbound);
    }
    // Through the JSONL text, as from a file.
    const parsed = parseJsonl(encodeRecording(withFdm));
    if (parsed.kind !== 'recording') throw new Error('not a recording');
    expect(parsed.recording.header.fdm).toBe(true);
    const r = replay(parsed.recording, { scenarios });
    expect(compareOutbound(asRecorded(live), r.outbound)).toEqual([]);
    const letter = r.outbound.find((m) => m.scenarioId === 'fdm_letter');
    expect(letter?.message.text).toContain('EVENTS THIS FLIGHT:');
    expect(r.report.fdm).toEqual(core.report().fdm);
    expect(r.report.fdm?.map((e) => e.kind)).toEqual(['speed', 'flaps']);
  });

  it('a recording made before T94 (no `fdm` in the header) replays as before', () => {
    const before = replay(old, { scenarios });
    const after = replay(withFdm, { scenarios });
    expect(before.outbound.some((m) => m.scenarioId === 'fdm_letter')).toBe(false);
    expect(before.report).not.toHaveProperty('fdm');
    // The letter is the only difference.
    const others = after.outbound.filter((m) => m.scenarioId !== 'fdm_letter');
    expect(compareOutbound(asRecorded(before.outbound), others)).toEqual([]);
    const { fdm: _, messages, ...rest } = after.report;
    expect({ ...rest, messages: { ...messages, airline: messages.airline - 1 } }).toEqual(
      before.report,
    );
  });
});
