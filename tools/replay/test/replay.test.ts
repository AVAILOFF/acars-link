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
    expect(out.delayMs).toBe(30 * 60_000);
    expect(out.timeline[0]).toMatchObject({ kind: 'late_start', delayMin: 30 });
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
    expect(pickScenarios({ base, extra: [], recorded: [], all: true }).scenarios).toHaveLength(16);
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
