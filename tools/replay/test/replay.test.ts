// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateSyntheticFlight,
  type Ofp,
  parseSimbriefOfp,
  stageIndex,
  type TelemetrySnapshot,
  withGap,
  withPause,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import {
  compareOutbound,
  encodeLine,
  encodeRecording,
  eventsFromSnapshots,
  formatReport,
  parseJsonl,
  type Recording,
  RecordingError,
  recordedCoreOptions,
  recordingFromSnapshots,
  replay,
  snapshotsOf,
  syntheticRecording,
} from '../src/index.js';
import { defaultEnabled, pickScenarios, type ScenarioFile } from '../src/scenarios.js';

const OFP_FILE = join(
  import.meta.dirname,
  '../../../packages/core/test/fixtures/ofp/rctp-rjbb-a35k-kgs.json',
);
const BASE_DIR = join(import.meta.dirname, '../../../packages/scenarios/base');
const ofp: Ofp = parseSimbriefOfp(JSON.parse(await readFile(OFP_FILE, 'utf8')));
const { readdirSync, readFileSync } = await import('node:fs');
const base: ScenarioFile[] = readdirSync(BASE_DIR)
  .filter((f) => f.endsWith('.yaml'))
  .sort()
  .map((f) => ({ file: f, source: readFileSync(join(BASE_DIR, f), 'utf8') }));
const enabled = defaultEnabled(base);
const all = pickScenarios({ base, extra: [], recorded: enabled }).scenarios;
const normal = syntheticRecording({ ofp, scenarios: enabled });

const tmp = () => mkdtemp(join(tmpdir(), 'acars-replay-'));

describe('JSONL format', () => {
  it('round-trips a recording', () => {
    const parsed = parseJsonl(encodeRecording(normal));
    expect(parsed.kind).toBe('recording');
    if (parsed.kind !== 'recording') return;
    // Via JSON: -0 in the synthetic data is written as 0.
    expect(parsed.recording).toEqual(JSON.parse(JSON.stringify(normal)));
    expect(parsed.warnings).toEqual([]);
  });

  it('drops a broken last line (crash mid-write), rejects broken lines elsewhere', () => {
    const text = encodeRecording({ ...normal, events: normal.events.slice(0, 10) });
    const cut = `${text}{"type":"tick","now":17`;
    const p = parseJsonl(cut);
    expect(p.warnings).toEqual([expect.stringMatching(/^line 12: incomplete/)]);
    expect(p.kind === 'recording' && p.recording.events).toHaveLength(10);
    const lines = text.split('\n');
    lines.splice(3, 0, '{oops');
    expect(() => parseJsonl(lines.join('\n'))).toThrow(/line 4: not JSON/);
    expect(() => parseJsonl(text.replace(/\n/g, '\r\n'))).not.toThrow();
  });

  it('checks the header and every line', () => {
    const [h, ...rest] = encodeRecording(normal).split('\n');
    const header = JSON.parse(h as string);
    const bad = (patch: object) =>
      [JSON.stringify({ ...header, ...patch }), ...rest.slice(0, 3)].join('\n');
    expect(() => parseJsonl(bad({ v: 2 }))).toThrow(/unsupported version 2/);
    expect(() => parseJsonl(bad({ format: 'x' }))).toThrow(RecordingError);
    expect(() => parseJsonl(bad({ ofp: { callsign: 'X' } }))).toThrow(/ofp/);
    expect(() => parseJsonl(bad({ profile: { id: 'p' } }))).toThrow(/profile/);
    const line = (x: object) => [h, JSON.stringify(x)].join('\n');
    expect(() => parseJsonl(line({ type: 'tick', now: 1, telemetry: { v: 1 } }))).toThrow(
      /line 2: telemetry/,
    );
    expect(() => parseJsonl(line({ type: 'end', now: 1, to: 'HOME' }))).toThrow(/line 2: to/);
    expect(() => parseJsonl(line({ type: 'warp', now: 1 }))).toThrow(/unknown type "warp"/);
    expect(() => parseJsonl('')).toThrow(/empty/);
  });

  it('reads `rops` of recordings made before T58 as `xatc`', () => {
    const xatc = { enabled: true, standAside: false, randomDirects: true };
    const withXatc: Recording = { ...normal, header: { ...normal.header, xatc } };
    const [h, ...rest] = encodeRecording(withXatc).split('\n');
    const { xatc: _, ...header } = JSON.parse(h as string);
    const old = parseJsonl([JSON.stringify({ ...header, rops: xatc }), ...rest].join('\n'));
    if (old.kind !== 'recording') throw new Error('not a recording');
    expect(old.recording.header.xatc).toEqual(xatc);
    expect(old.recording.header).not.toHaveProperty('rops');
    const texts = (rec: Recording) =>
      replay(rec, { scenarios: all }).outbound.map((m) => m.message.text);
    expect(texts(old.recording)).toEqual(texts(withXatc));
    expect(() =>
      parseJsonl([JSON.stringify({ ...header, rops: { enabled: 1 } }), ...rest].join('\n')),
    ).toThrow(/xatc/);
  });

  it('keeps `squawkTables` of the public build in the header and restores it (T72)', () => {
    const xatc = { enabled: true, squawkTables: 'public' } as const;
    const rec: Recording = { ...normal, header: { ...normal.header, xatc } };
    const back = parseJsonl(encodeRecording(rec));
    if (back.kind !== 'recording') throw new Error('not a recording');
    expect(back.recording.header.xatc).toEqual(xatc);
    expect(recordedCoreOptions(back.recording.header, all).xatc).toEqual(xatc);
    const bad = encodeRecording({
      ...normal,
      header: { ...normal.header, xatc: { enabled: true, squawkTables: 'everything' } as never },
    });
    expect(() => parseJsonl(bad)).toThrow(/xatc/);
  });

  it('reads bare snapshot files (bridge --replay format) and writes them back', () => {
    const snaps = snapshotsOf(normal);
    const text = snaps.map((s) => `${JSON.stringify(s)}\n`).join('');
    const p = parseJsonl(text);
    expect(p.kind).toBe('snapshots');
    expect(p.kind === 'snapshots' && p.snapshots).toEqual(JSON.parse(JSON.stringify(snaps)));
    expect(() => parseJsonl(`${text}{"type":"start","now":1}\n`)).toThrow(
      /not a recording header or TelemetrySnapshot/,
    );
  });

  it('fills telemetry gaps with empty 1 Hz ticks, like the app main loop', () => {
    const f = generateSyntheticFlight({ ofp });
    const [s0, s1, s2] = f.snapshots as [TelemetrySnapshot, TelemetrySnapshot, TelemetrySnapshot];
    const ev = eventsFromSnapshots([s0, s1, { ...s2, t: s1.t + 4_000 }]);
    expect(
      ev.map((e) => (e.type === 'tick' ? (e.telemetry === null ? 'null' : 'snap') : e.type)),
    ).toEqual(['start', 'snap', 'snap', 'null', 'null', 'null', 'snap']);
    // ±0.5 s jitter adds no empty ticks.
    const jitter = [s0, { ...s1, t: s0.t + 1_400 }];
    expect(eventsFromSnapshots(jitter).filter((e) => e.type === 'tick')).toHaveLength(2);
    expect(() => eventsFromSnapshots([s1, s0])).toThrow(/backwards/);
  });

  it('one line per call, newline-terminated', () => {
    expect(encodeLine({ type: 'stop', now: 5 })).toBe('{"type":"stop","now":5}\n');
  });
});

describe('replay through the core', () => {
  const r = replay(normal, { scenarios: all });

  it('phase sequence of the normal synthetic flight (docs/04 snapshot)', () => {
    expect(r.phases).toMatchSnapshot();
    expect(r.finalPhase).toBe('ON_BLOCK');
    // No late start; the only delay is the slot of slot_ctot (T43, CTOT − planned OFF).
    expect(r.delayMs).toBe(25 * 60_000);
  });

  it('timeline report (brief)', () => {
    expect(formatReport(r, { brief: true })).toMatchSnapshot();
  });

  it('is deterministic; the seed changes the random choices', () => {
    const again = replay(normal, { scenarios: all });
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
    const other = replay(normal, { scenarios: all, seed: 'another seed' });
    expect(other.outbound.map((m) => m.message.text)).not.toEqual(
      r.outbound.map((m) => m.message.text),
    );
  });

  it('go-around, pause and telemetry loss show up in the timeline', () => {
    const f = generateSyntheticFlight({ ofp, goAroundAglFt: 400 });
    const paused = withPause(f, { atIndex: stageIndex(f, 'CRUISE', 600), durationSec: 120 });
    const odd = withGap(paused, { atIndex: stageIndex(paused, 'CRUISE', 1800), durationSec: 60 });
    const rec = recordingFromSnapshots(odd.snapshots, { ofp, scenarios: enabled });
    const out = replay(rec, { scenarios: all });
    expect(out.phases).toContain('GO_AROUND');
    const text = formatReport(out, { brief: true, verbose: true });
    expect(text).toContain('TELEMETRY  lost');
    expect(text).toContain('TELEMETRY  restored after');
    expect(text).toContain('SIM        paused');
  });

  it('late start: a short boarding is replayed as a delayed flight', () => {
    const late = syntheticRecording({ ofp, scenarios: enabled }, { boardingSec: 5 * 60 });
    const out = replay(late, { scenarios: all });
    // 5 min left: under the 20 min of version 2 → delayed by 15, the rest fitted to 20 min.
    expect(out.delayMs).toBe(15 * 60_000);
    expect(out.timeline[0]).toMatchObject({ kind: 'late_start', delayMin: 15 });
  });

  it.each([30, 50])('%i min before STD: no delay, every document comes before STD', (min) => {
    const rec = syntheticRecording({ ofp, scenarios: enabled }, { boardingSec: min * 60 });
    // Without the slot: its delay would move the later documents past the (synthetic) pushback.
    const out = replay(rec, { scenarios: all.filter((s) => s.id !== 'slot_ctot') });
    expect(out.timeline.some((e) => e.kind === 'late_start')).toBe(false);
    const std = ofp.times.schedOutMs;
    const sent = (id: string) => out.outbound.filter((m) => m.scenarioId === id);
    for (const id of ['crew_info', 'prelim_loadsheet', 'takeoff_data', 'final_loadsheet']) {
      expect(sent(id), id).toHaveLength(1);
      expect(sent(id)[0]?.t ?? Infinity, id).toBeLessThan(std);
    }
    const order = out.outbound
      .map((m) => m.scenarioId)
      .filter((id) =>
        ['crew_info', 'prelim_loadsheet', 'takeoff_data', 'final_loadsheet'].includes(id),
      );
    expect(order).toEqual(['crew_info', 'prelim_loadsheet', 'takeoff_data', 'final_loadsheet']);
  });

  it('end and stop lines: end outside ON_BLOCK is reported, events after stop are ignored', () => {
    const ev = normal.events;
    const rec: Recording = {
      header: normal.header,
      events: [...ev.slice(0, 100), { type: 'end', now: 1e13, to: 'DONE' }],
    };
    const out = replay(rec, { scenarios: [] });
    expect(out.timeline.at(-1)).toMatchObject({ kind: 'error' });
    const stopped = replay(
      {
        header: normal.header,
        events: [...ev.slice(0, 50), { type: 'stop', now: 0 }, ...ev.slice(50)],
      },
      { scenarios: [] },
    );
    expect(stopped.ticks).toBe(49);
  });

  it('T64: resume and sent lines; the replay goes on over the restart as one flight', () => {
    const ev = normal.events;
    const whole = replay(normal, { scenarios: all });
    const out = whole.outbound[0];
    if (out === undefined) throw new Error('no telex');
    const at = 400;
    const restarted: Recording = {
      header: { ...normal.header, simTime: false },
      events: [
        ...ev.slice(0, at),
        { type: 'sent', t: out.t, n: 0, result: 'sent' },
        { type: 'resume', now: 1 },
        ...ev.slice(at),
      ],
    };
    const text = encodeRecording(restarted);
    const parsed = parseJsonl(text);
    expect(parsed.kind === 'recording' && parsed.recording).toEqual(
      JSON.parse(JSON.stringify(restarted)),
    );
    const r = replay(restarted, { scenarios: all });
    expect(r.outbound).toEqual(whole.outbound);
    expect(r.ticks).toBe(whole.ticks);
    expect(r.timeline.filter((e) => e.kind === 'resume')).toEqual([{ kind: 'resume', now: 1 }]);
    expect(formatReport(r, { brief: true })).toContain('RESUME');

    const [h] = text.split('\n');
    const line = (x: object) => [h, JSON.stringify(x)].join('\n');
    expect(() => parseJsonl(line({ type: 'sent', t: 1, n: -1, result: 'sent' }))).toThrow(
      /line 2: n/,
    );
    expect(() => parseJsonl(line({ type: 'sent', t: 1, n: 0, result: 'lost' }))).toThrow(
      /line 2: result/,
    );
    expect(() => parseJsonl(line({ type: 'resume' }))).toThrow(/line 2: now/);
    const header = JSON.parse(h as string);
    expect(() => parseJsonl(JSON.stringify({ ...header, simTime: 'yes' }))).toThrow(/simTime/);
  });

  it('T77: the app version in the header; a recording without it reads as before', () => {
    expect(normal.header.appVersion).toBeUndefined();
    const v: Recording = { ...normal, header: { ...normal.header, appVersion: '0.1.1' } };
    const parsed = parseJsonl(encodeRecording(v));
    expect(parsed.kind === 'recording' && parsed.recording.header.appVersion).toBe('0.1.1');
    const [h] = encodeRecording(v).split('\n');
    const header = JSON.parse(h as string);
    expect(() => parseJsonl(JSON.stringify({ ...header, appVersion: 11 }))).toThrow(/appVersion/);
  });

  it('compareOutbound names missing, extra and changed telexes', () => {
    const live = r.outbound.map((m) => ({
      type: 'out' as const,
      t: m.t,
      scenarioId: m.scenarioId,
      from: m.from,
      to: m.to,
      text: m.message.text,
    }));
    const [a, b, ...rest] = live;
    if (a === undefined || b === undefined) throw new Error('need telexes');
    expect(compareOutbound(live, r.outbound)).toEqual([]);
    expect(compareOutbound([a, { ...b, text: 'X' }, ...rest], r.outbound)).toEqual([
      `#2: ${b.scenarioId}: text or callsigns differ`,
    ]);
    expect(compareOutbound(live.slice(0, -1), r.outbound)[0]).toMatch(/extra in replay/);
    expect(compareOutbound(live, r.outbound.slice(1))[0]).toMatch(/^#1: scenario/);
  });
});

describe('scenario selection', () => {
  const crew = base.find((f) => f.file === 'crew_info.yaml');
  if (crew === undefined) throw new Error('crew_info.yaml');
  const edited: ScenarioFile = {
    file: 'my/crew_info.yaml',
    source: crew.source.replace('CREW INFO', 'CREW INFO EDITED'),
  };

  it('defaults to the scenarios of the flight; extra files replace base ones and are on', () => {
    const p = pickScenarios({ base, extra: [edited], recorded: ['fuel_slip', 'gone'] });
    expect(p.scenarios.map((s) => s.id).sort()).toEqual(['crew_info', 'fuel_slip']);
    expect(p.missing).toEqual(['gone']);
    const r = replay(normal, { scenarios: p.scenarios });
    const crewTelex = r.outbound.find((m) => m.scenarioId === 'crew_info');
    expect(crewTelex?.message.lines[0]).toBe('CREW INFO EDITED');
  });

  it('--only and --all', () => {
    expect(
      pickScenarios({ base, extra: [], recorded: enabled, only: ['slot_ctot'] }).scenarios.map(
        (s) => s.id,
      ),
    ).toEqual(['slot_ctot']);
    expect(() => pickScenarios({ base, extra: [], recorded: [], only: ['nope'] })).toThrow(/nope/);
    expect(pickScenarios({ base, extra: [], recorded: [], all: true }).scenarios).toHaveLength(18);
  });
});

describe('CLI', () => {
  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return {
      io: { out: (t: string) => void out.push(t), err: (t: string) => void err.push(t) },
      out: () => out.join(''),
      err: () => err.join(''),
    };
  }

  it('synth → run → snapshots → run with --ofp', async () => {
    const dir = await tmp();
    const rec = join(dir, 'syn.jsonl');
    expect(await main(['synth', '--ofp', OFP_FILE, '--out', rec, '--go-around', '300'])).toBe(0);

    const a = io();
    expect(await main(['run', rec, '--brief'], a.io)).toBe(0);
    expect(a.out()).toMatch(/^SJX822 RCTP-RJBB \(synthetic, recorded /);
    expect(a.out()).toContain('PHASE      APPROACH → GO_AROUND');
    expect(a.out()).toMatch(/final phase ON_BLOCK, \d+ telexes\n$/);

    const snaps = join(dir, 'snaps.jsonl');
    expect(await main(['snapshots', rec, '--out', snaps])).toBe(0);
    const b = io();
    expect(await main(['run', snaps], b.io)).toBe(2);
    expect(b.err()).toContain('has no header: pass --ofp');
    const c = io();
    expect(await main(['run', snaps, '--ofp', OFP_FILE, '--brief'], c.io)).toBe(0);
    expect(c.out().split('\n').slice(2)).toEqual(a.out().split('\n').slice(2));
  });

  it('--check compares with the live telexes; --json prints one entry per line', async () => {
    const dir = await tmp();
    const r = replay(normal, { scenarios: all });
    const live = r.outbound.map((m) => ({
      type: 'out' as const,
      t: m.t,
      scenarioId: m.scenarioId,
      from: m.from,
      to: m.to,
      text: m.message.text,
    }));
    const good = join(dir, 'good.jsonl');
    await writeFile(good, encodeRecording({ ...normal, events: [...normal.events, ...live] }));
    const a = io();
    expect(await main(['run', good, '--check', '--json'], a.io)).toBe(0);
    expect(a.err()).toMatch(/telexes match the live run/);
    const entries = a
      .out()
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(entries.filter((e) => e.kind === 'out')).toHaveLength(live.length);

    const b = io();
    expect(await main(['run', good, '--check', '--only', 'crew_info'], b.io)).toBe(1);
    expect(b.err()).toMatch(/differences from the live run/);
  });

  it('extra scenario files, profile and usage errors', async () => {
    const dir = await tmp();
    const rec = join(dir, 'syn.jsonl');
    await writeFile(rec, encodeRecording(normal));
    const crew = join(dir, 'crew_info.yaml');
    await writeFile(
      crew,
      (await readFile(join(BASE_DIR, 'crew_info.yaml'), 'utf8')).replace('CREW INFO', 'MY CREW'),
    );
    const a = io();
    expect(
      await main(['run', rec, '--no-base', '--scenarios', crew, '--profile', 'b78x'], a.io),
    ).toBe(0);
    expect(a.out()).toContain('| MY CREW');
    expect(a.out()).toContain('1 scenarios, profile b78x');
    expect(a.err()).toContain('warning: scenarios of the flight not found');

    for (const argv of [
      ['run'],
      ['fly'],
      ['run', rec, '--profile', 'x'],
      ['run', rec, '--bogus'],
    ]) {
      const e = io();
      expect(await main(argv, e.io)).toBe(2);
      expect(e.err()).toMatch(/^error: /);
    }
    const h = io();
    expect(await main(['--help'], h.io)).toBe(0);
    expect(h.out()).toContain('pnpm replay run');
  });

  it('--pilot: pilot telexes on the timeline, answered by the command scenarios', async () => {
    const dir = await tmp();
    const rec = join(dir, 'syn.jsonl');
    expect(await main(['synth', '--ofp', OFP_FILE, '--out', rec])).toBe(0);
    const a = io();
    const args = ['run', rec, '--brief', '--pilot', '1=req gate', '--pilot', '2=HELLO'];
    expect(await main(args, a.io)).toBe(0);
    expect(a.out()).toContain('PILOT      "REQ GATE" → command REQ_GATE');
    expect(a.out()).toContain('TELEX      cmd_req_gate');
    expect(a.out()).toContain('PILOT      "HELLO" → unknown');
    expect(a.out()).toContain('TELEX      #ops');
    const bad = io();
    expect(await main(['run', rec, '--pilot', 'soon=ETA'], bad.io)).toBe(2);
    expect(bad.err()).toMatch(/expected <min>=<text>/);
  });
});

describe('pilot telexes in a recording (T12)', () => {
  it('tick lines carry inbound; replay passes it to the core', () => {
    const scenarios = pickScenarios({
      base: [
        ...base,
        {
          file: 'cmd.yaml',
          source: [
            'id: cmd_gate',
            'version: 1',
            'category: ops',
            'title: gate',
            'enabled_by_default: true',
            'trigger: { on: command, command: REQ_GATE }',
            'steps: [{ send: { body: "GATE {ops.arr_gate}" } }]',
          ].join('\n'),
        },
      ],
      extra: [],
      recorded: [...enabled, 'cmd_gate'],
    }).scenarios;
    const events = normal.events.map((e, i) =>
      i === 100 && e.type === 'tick'
        ? { ...e, inbound: [{ from: ofp.callsign, type: 'telex', text: 'REQ GATE' }] }
        : e,
    );
    const rec: Recording = { ...normal, events };
    const parsed = parseJsonl(encodeRecording(rec));
    if (parsed.kind !== 'recording') throw new Error('not a recording');
    const r = replay(parsed.recording, { scenarios });
    expect(r.outbound.filter((m) => m.scenarioId === 'cmd_gate')).toHaveLength(1);
    const line = (x: object) => [encodeLine(normal.header).trim(), JSON.stringify(x)].join('\n');
    expect(() =>
      parseJsonl(line({ type: 'tick', now: 1, telemetry: null, inbound: [{ from: 'X' }] })),
    ).toThrow(/inbound/);
  });
});

describe('external data in a recording (T13)', () => {
  it('tick lines carry data; replay passes it to the core; bad data is rejected', () => {
    const gateMsg = {
      file: 'gate.yaml',
      source: [
        'id: gate_now',
        'version: 1',
        'category: ops',
        'title: gate',
        'enabled_by_default: true',
        'trigger: { on: phase_enter, phase: CRUISE }',
        'steps: [{ send: { body: "GATE {ops.arr_gate} {wx.dest_live}" } }]',
      ].join('\n'),
    };
    const scenarios = pickScenarios({
      base: [gateMsg],
      extra: [],
      recorded: ['gate_now'],
    }).scenarios;
    const t = (normal.events[5] as { now: number }).now;
    const data = {
      t,
      wx: { RJBB: { metar: 'RJBB 080600Z 03008KT Q1018', taf: null, obsTime: t } },
      stands: { icao: 'RJBB', list: [{ ref: 'K7', kind: 'stand' as const }] },
    };
    const events = normal.events.map((e, i) => (i === 5 && e.type === 'tick' ? { ...e, data } : e));
    const rec: Recording = { ...normal, header: { ...normal.header, dataWaitMs: 60_000 }, events };
    const parsed = parseJsonl(encodeRecording(rec));
    if (parsed.kind !== 'recording') throw new Error('not a recording');
    expect(parsed.recording.header.dataWaitMs).toBe(60_000);
    const r = replay(parsed.recording, { scenarios });
    expect(r.outbound.map((m) => m.message.text)).toEqual(['GATE K7 TRUE']);
    const line = (x: object) => [encodeLine(normal.header).trim(), JSON.stringify(x)].join('\n');
    expect(() =>
      parseJsonl(line({ type: 'tick', now: 1, telemetry: null, data: { t: 1, wx: 3 } })),
    ).toThrow(/line 2: data update: wx/);
    const [h] = encodeRecording(normal).split('\n');
    expect(() =>
      parseJsonl(JSON.stringify({ ...JSON.parse(h as string), dataWaitMs: -1 })),
    ).toThrow(/dataWaitMs/);
  });
});

describe('airline memory in a recording (T14)', () => {
  it('the header flags start the replayed core', () => {
    const reader = {
      file: 'reader.yaml',
      source: [
        'id: reader',
        'version: 1',
        'category: irregular',
        'title: reader',
        'enabled_by_default: true',
        'trigger: { on: phase_enter, phase: CRUISE }',
        'conditions: ["flags.note != null"]',
        'steps: [{ send: { body: "NOTE {flags.note}" } }, { set: { flags.note: null } }]',
      ].join('\n'),
    };
    const scenarios = pickScenarios({ base: [reader], extra: [], recorded: ['reader'] }).scenarios;
    const rec: Recording = { ...normal, header: { ...normal.header, flags: { note: 'MEL OPEN' } } };
    const parsed = parseJsonl(encodeRecording(rec));
    if (parsed.kind !== 'recording') throw new Error('not a recording');
    expect(replay(parsed.recording, { scenarios }).outbound.map((m) => m.message.text)).toEqual([
      'NOTE MEL OPEN',
    ]);
    expect(replay(normal, { scenarios }).outbound).toEqual([]);
    const [h] = encodeRecording(normal).split('\n');
    expect(() => parseJsonl(JSON.stringify({ ...JSON.parse(h as string), flags: [1] }))).toThrow(
      /flags/,
    );
  });
});

describe('kind of flight in a recording (T89)', () => {
  const pax = {
    file: 'pax.yaml',
    source: [
      'id: pax',
      'version: 1',
      'category: irregular',
      'title: pax',
      'enabled_by_default: true',
      'operations: [sched_pax]',
      'trigger: { on: phase_enter, phase: CRUISE }',
      'steps: [{ send: { body: "PAX ON BOARD" } }]',
    ].join('\n'),
  };
  const scenarios = pickScenarios({ base: [pax], extra: [], recorded: ['pax'] }).scenarios;
  const texts = (r: Recording) => replay(r, { scenarios }).outbound.map((m) => m.message.text);

  it('a synthetic flight records the filter and the recognized kind', () => {
    expect(normal.header.flightKind).toEqual({ override: null, kind: 'sched_pax' });
    expect(recordedCoreOptions(normal.header, scenarios).flightKind).toEqual({ override: null });
    expect(texts(normal)).toEqual(['PAX ON BOARD']);
  });

  it("the user's choice in a tick before OUT is replayed; a recording before T89 has no filter", () => {
    const [first, ...rest] = normal.events;
    const tick = rest.findIndex((e) => e.type === 'tick');
    const events = [...rest];
    const t = events[tick];
    if (t?.type !== 'tick') throw new Error('no tick');
    events[tick] = { ...t, flightKind: { override: 'cargo' } };
    const chosen: Recording = {
      ...normal,
      events: [first as Recording['events'][number], ...events],
    };
    const parsed = parseJsonl(encodeRecording(chosen));
    if (parsed.kind !== 'recording') throw new Error('not a recording');
    expect(texts(parsed.recording)).toEqual([]);
    const { flightKind: _, ...old } = chosen.header;
    expect(recordedCoreOptions(old as Recording['header'], scenarios)).not.toHaveProperty(
      'flightKind',
    );
    expect(texts({ ...chosen, header: old as Recording['header'] })).toEqual(['PAX ON BOARD']);
  });

  it('checks the kind in the header and in the ticks', () => {
    const [h] = encodeRecording(normal).split('\n');
    const header = JSON.parse(h as string);
    expect(() =>
      parseJsonl(JSON.stringify({ ...header, flightKind: { override: 'tanker' } })),
    ).toThrow(/flightKind/);
    const line = (x: object) => [h, JSON.stringify(x)].join('\n');
    expect(() =>
      parseJsonl(line({ type: 'tick', now: 1, telemetry: null, flightKind: { override: 1 } })),
    ).toThrow(/line 2: flightKind/);
  });
});

describe('rescue services in a replay (T54)', () => {
  it('MEDICAL in cruise: the rescue command is on the timeline, the same on every run', () => {
    const dir = join(import.meta.dirname, '../../../packages/scenarios/commands');
    const commands: ScenarioFile[] = readdirSync(dir)
      .filter((f) => f.endsWith('.yaml'))
      .sort()
      .map((f) => ({ file: f, source: readFileSync(join(dir, f), 'utf8') }));
    const scenarios = pickScenarios({
      base: [...base, ...commands],
      extra: [],
      recorded: [],
      only: ['cmd_medical'],
    }).scenarios;
    const flight = generateSyntheticFlight({ ofp });
    const first = normal.events[0];
    const t0 = first !== undefined && 'now' in first ? first.now : 0;
    const cruise = (flight.snapshots[stageIndex(flight, 'CRUISE', 600)]?.t ?? 0) - t0;
    const pilot = [
      { afterMin: cruise / 60_000, text: 'MEDICAL PAX UNCONSCIOUS' },
      { afterMin: cruise / 60_000 + 1, text: 'CONTINUE' },
    ];
    const run = () =>
      replay(normal, { scenarios, pilot }).timeline.flatMap((e) =>
        e.kind === 'cmd' ? [e.command] : [],
      );
    const a = run();
    expect(a).toEqual([
      expect.objectContaining({
        command: 'rescue',
        scenarioId: 'cmd_medical',
        action: 'start',
        level: 'medical',
        airport: ofp.destination.icao,
        runway: ofp.destination.planRwy,
      }),
    ]);
    expect(run()).toEqual(a);
    const report = formatReport(replay(normal, { scenarios, pilot }), {});
    expect(report).toContain('SIM        cmd_medical  rescue');
  });
});

describe('flight report in a replay (T69)', () => {
  const last = normal.events.at(-1) as { now: number };
  const end = { type: 'end' as const, now: last.now + 1000, to: 'DONE' as const };
  const closed: Recording = { ...normal, events: [...normal.events, end] };
  const r = replay(closed, { scenarios: all });

  it('the report is taken when the flight is closed: OOOI as on the timeline', () => {
    expect(r.ended).toBe(true);
    expect(r.recordedReport).toBeNull();
    const oooi = (k: string) =>
      r.timeline.flatMap((e) =>
        e.kind === 'event' && e.event.type === `OOOI_${k}` ? [e.event.t] : [],
      );
    for (const k of ['OUT', 'OFF', 'ON', 'IN'] as const) {
      expect([r.report.times[k].actual]).toEqual(oooi(k));
    }
    expect(r.report.blockMs.actual).toBe((oooi('IN')[0] ?? 0) - (oooi('OUT')[0] ?? 0));
    expect(r.report.touchdownFpm).toBeNull();
    expect(r.report.landed?.icao).toBe('RJBB');
  });

  it('what happens after the end (turnaround) is not in the report', () => {
    const later = Array.from({ length: 600 }, (_, i) => ({
      type: 'tick' as const,
      now: end.now + (i + 1) * 1000,
      telemetry: null,
    }));
    const more = replay({ ...closed, events: [...closed.events, ...later] }, { scenarios: all });
    expect(more.report).toEqual(r.report);
    // Without `end`: the report of the last line, marked as not closed.
    const open = replay(normal, { scenarios: all });
    expect(open.ended).toBe(false);
    expect(open.report.times.IN.actual).toBe(r.report.times.IN.actual);
  });

  it('the `summary` line: parsed, compared by `summary --check`', async () => {
    const line = { type: 'summary' as const, now: end.now, report: r.report };
    const text = encodeRecording({ ...closed, events: [...closed.events, line] });
    const parsed = parseJsonl(text);
    expect(parsed.kind === 'recording' && parsed.recording.events.at(-1)).toEqual(line);
    const broken = text.replace('"report":{"v":1', '"report":{"v":7');
    expect(() => parseJsonl(broken)).toThrow(/report must be a FlightReport v1/);

    const dir = await tmp();
    const good = join(dir, 'good.jsonl');
    await writeFile(good, text);
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (t: string) => void out.push(t), err: (t: string) => void err.push(t) };
    expect(await main(['summary', good, '--check', '--json'], io)).toBe(0);
    expect(JSON.parse(out.join(''))).toEqual(r.report);
    expect(err.join('')).toMatch(/matches the one the app wrote/);

    const other = { ...r.report, messages: { ...r.report.messages, airline: 999 } };
    const bad = join(dir, 'bad.jsonl');
    await writeFile(
      bad,
      encodeRecording({ ...closed, events: [...closed.events, { ...line, report: other }] }),
    );
    out.length = 0;
    expect(await main(['summary', bad, '--check'], io)).toBe(1);
    expect(out.join('')).toMatch(/^FLIGHT REPORT SJX822 RCTP-RJBB A35K/);
    expect(out.join('')).toContain('landed        RJBB');
    expect(out.join('')).toContain('touchdown     no data');

    const none = join(dir, 'none.jsonl');
    await writeFile(none, encodeRecording(closed));
    expect(await main(['summary', none, '--check'], io)).toBe(1);
    expect(err.join('')).toMatch(/has no summary line/);
  });
});
