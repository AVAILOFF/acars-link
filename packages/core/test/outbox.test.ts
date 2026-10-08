import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AcarsCore,
  compileScenario,
  generateSyntheticFlight,
  type OutboundMessage,
  type PilotMessage,
  parseSimbriefOfp,
  type ScenarioDef,
} from '../src/index.js';

/** The gap between outgoing telexes (`minGapMs`): aircraft poll about once a minute. */

const ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'ofp', 'rctp-rjbb-a35k-kgs.json'), 'utf8'),
  ),
);
const flight = generateSyntheticFlight({ ofp });
const MIN = 60_000;

const burst = (n: number): ScenarioDef[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `doc${i}`,
    version: 1,
    category: 'docs',
    title: `doc${i}`,
    enabled_by_default: true,
    trigger: { on: 'phase_enter', phase: 'BOARDING' },
    priority: n - i,
    steps: [{ send: { body: `DOC ${i}` } }],
  }));
const gate: ScenarioDef = {
  id: 'gate',
  version: 1,
  category: 'ops',
  title: 'gate',
  enabled_by_default: true,
  trigger: { on: 'command', command: 'REQ_GATE' },
  steps: [{ send: { body: 'GATE {ops.arr_gate}' } }],
};

function fly(
  defs: readonly ScenarioDef[],
  minGapMs: number,
  o: { until?: number; say?: Map<number, PilotMessage[]>; resumeAt?: number } = {},
) {
  const options = { ofp, scenarios: defs.map(compileScenario), seed: 'gap', minGapMs };
  let core = AcarsCore.create(options);
  core.startFlight();
  const out: OutboundMessage[] = [];
  const queued: number[] = [];
  flight.snapshots.slice(0, o.until ?? 600).forEach((s, i) => {
    if (i === o.resumeAt) {
      core = AcarsCore.fromState(JSON.parse(JSON.stringify(core.getState())), options);
    }
    const inbound = o.say?.get(i);
    out.push(
      ...core.tick({ now: s.t, telemetry: s, ...(inbound === undefined ? {} : { inbound }) })
        .outbound,
    );
    queued.push(core.queued);
  });
  return { out, queued };
}

describe('gap between telexes', () => {
  it('without a gap everything leaves at once (as before)', () => {
    const r = fly(burst(4), 0);
    expect(new Set(r.out.map((m) => m.t)).size).toBe(1);
  });

  it('one telex per gap, in order, stamped with the time it leaves', () => {
    const r = fly(burst(4), MIN);
    expect(r.out.map((m) => m.message.text)).toEqual(['DOC 0', 'DOC 1', 'DOC 2', 'DOC 3']);
    const t = r.out.map((m) => m.t);
    for (let i = 1; i < t.length; i++) expect((t[i] as number) - (t[i - 1] as number)).toBe(MIN);
    expect(Math.max(...r.queued)).toBe(3);
    expect(r.queued.at(-1)).toBe(0);
  });

  it('an answer to the pilot goes before the waiting documents', () => {
    const say = new Map([[30, [{ from: ofp.callsign, type: 'telex', text: 'REQ GATE' }]]]);
    const r = fly([...burst(4), gate], MIN, { say });
    expect(r.out.map((m) => m.message.text.split(' ')[0])).toEqual([
      'DOC',
      'GATE',
      'DOC',
      'DOC',
      'DOC',
    ]);
    expect(r.out[1]?.toPilot).toBe(true);
  });

  it('the outbox survives a state round trip', () => {
    const a = fly(burst(4), MIN);
    const b = fly(burst(4), MIN, { resumeAt: 100 });
    expect(b.out).toEqual(a.out);
  });
});
