// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AcarsCore,
  type FlightReport,
  generateSyntheticFlight,
  type Ofp,
  type OutboundMessage,
  parseSimbriefOfp,
  type TelemetrySnapshot,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../src/index.js';

/** T94: the safety department's FDM letter after on-block. */

const dir = join(import.meta.dirname, '..', 'base');
const letter = loadScenarios(
  readdirSync(dir)
    .filter((f) => f === 'fdm_letter.yaml')
    .map((file) => ({ file, source: readFileSync(join(dir, file), 'utf8') })),
);

const ofp: Ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../core/test/fixtures/ofp/rctp-rjbb-a35k-kgs.json'),
      'utf8',
    ),
  ),
);
const ELEV = ofp.destination.elevationFt;
const synthetic = generateSyntheticFlight({ ofp }).snapshots;

/**
 * The synthetic flight made clean: 250 kt below 10 000 ft (it slows down only after it), the same
 * flaps at 1000 ft and at the touchdown (it lands with flaps 4 after flaps 3).
 */
const clean: readonly TelemetrySnapshot[] = synthetic.map((s) => ({
  ...s,
  iasKt: !s.onGround && s.altFt < 10_000 ? Math.min(s.iasKt, 250) : s.iasKt,
  flapsIdx: Math.min(s.flapsIdx, 3),
}));

/** The clean flight with VS -1400 fpm between 900 and 700 ft above the aerodrome. */
const sinking: readonly TelemetrySnapshot[] = clean.map((s, i) => {
  const h = s.altFt - ELEV;
  const approach = i > clean.length / 2 && !s.onGround && s.vsFpm < 0;
  if (!approach || h > 900 || h <= 700) return s;
  // The worst sample at 800 ft.
  return h < 815 && h >= 790 ? { ...s, vsFpm: -1404, altFt: ELEV + 800 } : { ...s, vsFpm: -1380 };
});

interface Run {
  readonly out: OutboundMessage[];
  readonly report: FlightReport;
  readonly onBlock: number | null;
}

function fly(snapshots: readonly TelemetrySnapshot[], fdm: boolean, answer?: string): Run {
  const core = AcarsCore.create({
    ofp,
    scenarios: letter,
    seed: 't94',
    ...(fdm ? { fdm } : {}),
  });
  core.startFlight();
  const out: OutboundMessage[] = [];
  let onBlock: number | null = null;
  let asked: number | null = null;
  const last = snapshots[snapshots.length - 1] as TelemetrySnapshot;
  // The flight, then 10 more minutes parked.
  const all = [
    ...snapshots,
    ...Array.from({ length: 600 }, (_, i) => ({ ...last, t: last.t + (i + 1) * 1000 })),
  ];
  for (const s of all) {
    const inbound =
      answer !== undefined && asked !== null && s.t === asked + 30_000
        ? [{ from: ofp.callsign, type: 'telex' as const, text: answer }]
        : [];
    const r = core.tick({ now: s.t, telemetry: s, ...(inbound.length > 0 ? { inbound } : {}) });
    for (const e of r.events) if (e.type === 'PHASE_CHANGE' && e.to === 'ON_BLOCK') onBlock = e.t;
    for (const m of r.outbound) {
      out.push(m);
      asked ??= m.t;
    }
  }
  return { out, report: core.report(), onBlock };
}

/** The words of a telex; the header's separator line (`----`) left out. */
const words = (m: OutboundMessage | undefined) =>
  m?.message.text.replace(/\n-+\n/, '\n').replace(/\s+/g, ' ') ?? '';

describe('FDM letter (T94)', () => {
  it('no events: no letter, an empty list in the report', () => {
    const r = fly(clean, true);
    expect(r.onBlock).not.toBeNull();
    expect(r.out).toEqual([]);
    expect(r.report.fdm).toEqual([]);
  });

  it('VS -1400 fpm at 800 ft: the letter 3 min after on-block, the event in the report', () => {
    const r = fly(sinking, true);
    expect(r.out).toHaveLength(1);
    const m = r.out[0] as OutboundMessage;
    expect(m.scenarioId).toBe('fdm_letter');
    expect(m.t - (r.onBlock as number)).toBeGreaterThanOrEqual(180_000);
    expect(m.t - (r.onBlock as number)).toBeLessThan(185_000);
    const text = words(m);
    expect(text).toMatch(
      /^SAFETY DEPT FDM EVENTS THIS FLIGHT: 1 SINK RATE 1400 FPM AT 800 FT \d{4}Z /,
    );
    expect(text).toMatch(/INFO ONLY, NO BLAME REPLY ACK OR REPORT$/);
    expect(text).not.toMatch(/\b2 /);
    expect(text).not.toContain('----');
    expect(m.message.text).toMatchSnapshot();
    expect(r.report.fdm).toEqual([
      expect.objectContaining({ kind: 'sink_rate', value: 1400, altFt: 800, info: false }),
    ]);
  });

  it('REPORT: the safety department will contact the crew; ACK: noted', () => {
    const report = fly(sinking, true, 'REPORT');
    expect(report.out.map(words)[1]).toBe(
      'SAFETY DEPT FDM ASR NOTED, SAFETY DEPT WILL CONTACT YOU',
    );
    const ack = fly(sinking, true, 'ACK');
    expect(ack.out.map(words)[1]).toBe('SAFETY DEPT FDM NOTED');
  });

  it('no answer: nothing after the letter', () => {
    expect(fly(sinking, true).out).toHaveLength(1);
  });

  it('several events: numbered in time order', () => {
    const gearUp = sinking.map((s, i) => {
      const h = s.altFt - ELEV;
      return i > sinking.length / 2 && !s.onGround && h > 950 && h < 1500
        ? { ...s, gearDown: false }
        : s;
    });
    const text = words(fly(gearUp, true).out[0]);
    expect(text).toMatch(/1 GEAR UP AT 1000 FT \d{4}Z 2 SINK RATE 1400 FPM AT 800 FT \d{4}Z/);
  });

  it('FDM off (recordings before T94): no letter, no list in the report', () => {
    const r = fly(sinking, false);
    expect(r.out).toEqual([]);
    expect(r.report).not.toHaveProperty('fdm');
  });
});
