import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AcarsCore,
  B77X_PROFILE,
  B78X_PROFILE,
  type CompiledScenario,
  type CoreEvent,
  checkText,
  DEFAULT_PROFILE,
  type DisplayProfile,
  type FlightPhase,
  generateSyntheticFlight,
  MISSING,
  type Ofp,
  OPS_REPLY_ID,
  type OutboundMessage,
  type PilotMessage,
  parseSimbriefOfp,
  type SyntheticFlight,
  stageIndex,
  withGap,
  withPause,
  withSimRate,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { loadScenario, loadScenarios } from '../src/index.js';
import { standsFor } from './stands.js';

/**
 * T12: the pilot command scenarios (`commands/*.yaml`, docs/05 "Входящие команды пилота") with
 * the base set, as the app loads them. Every command at the gate and in cruise on 3 synthetic
 * flights × 3 profiles: each gets an answer, texts fit, nothing is missing.
 */

const dir = (name: string) => join(import.meta.dirname, '..', name);
const read = (name: string) =>
  readdirSync(dir(name))
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(dir(name), file), 'utf8') }));
const commandFiles = read('commands');
const all = loadScenarios([...read('base'), ...commandFiles]);
const commands = all.filter((s) => s.def.trigger.on === 'command');

const OFPS = join(import.meta.dirname, '../../core/test/fixtures/ofp');
const ofpOf = (name: string): Ofp =>
  parseSimbriefOfp(JSON.parse(readFileSync(join(OFPS, `${name}.json`), 'utf8')));
const kg = ofpOf('rctp-rjbb-a35k-kgs');
const lbs = ofpOf('rctp-rjbb-a35k-lbs-synthetic');
const normal = generateSyntheticFlight({ ofp: kg });
const goAround = generateSyntheticFlight({ ofp: kg, goAroundAglFt: 400 });
const lbsFlight = generateSyntheticFlight({ ofp: lbs, seed: 'lbs' });

interface Case {
  readonly name: string;
  readonly ofp: Ofp;
  readonly flight: SyntheticFlight;
}

const FLIGHTS: readonly Case[] = [
  { name: 'normal', ofp: kg, flight: normal },
  {
    name: 'go-around, pause at gate, ×4 in cruise',
    ofp: kg,
    flight: withSimRate(
      withPause(goAround, { atIndex: stageIndex(goAround, 'GATE', 600), durationSec: 300 }),
      {
        fromIndex: stageIndex(goAround, 'CRUISE', 300),
        toIndex: stageIndex(goAround, 'CRUISE', 1500),
        rate: 4,
      },
    ),
  },
  {
    name: 'lbs OFP, no flight number, telemetry gap in climb',
    ofp: lbs,
    flight: withGap(lbsFlight, { atIndex: stageIndex(lbsFlight, 'CLIMB', 120), durationSec: 90 }),
  },
];

/** What the pilot says, by phase-machine phase and seconds after entering it. */
type Script = readonly {
  readonly phase: FlightPhase;
  readonly sec: number;
  readonly say: string;
}[];

const SCRIPT: Script = [
  { phase: 'BOARDING', sec: 60, say: 'HELP' },
  { phase: 'BOARDING', sec: 61, say: 'req gate' },
  { phase: 'BOARDING', sec: 62, say: 'REQ WX' },
  { phase: 'BOARDING', sec: 63, say: 'REQ-WX-KJFK' },
  { phase: 'BOARDING', sec: 64, say: 'ETA' },
  { phase: 'BOARDING', sec: 65, say: 'REQ LOADSHEET' },
  { phase: 'BOARDING', sec: 66, say: 'DELAY 15 LATE CATERING' },
  { phase: 'BOARDING', sec: 67, say: 'DIVERT RJOO' },
  { phase: 'BOARDING', sec: 68, say: 'REQ REFUEL' },
  { phase: 'CRUISE', sec: 60, say: 'ETA' },
  { phase: 'CRUISE', sec: 61, say: 'REQ LS' },
  { phase: 'CRUISE', sec: 62, say: 'DELAY 5' },
  { phase: 'CRUISE', sec: 63, say: 'DIVERT RJOO' },
  { phase: 'CRUISE', sec: 90, say: 'MEDICAL' },
  { phase: 'CRUISE', sec: 120, say: 'REQ GATE' },
];

interface Exchange {
  readonly said: string;
  /** Scenario ids of the telexes sent on the tick of the pilot message. */
  readonly answers: string[];
}

interface Run {
  readonly out: OutboundMessage[];
  readonly events: CoreEvent[];
  readonly talk: Exchange[];
}

function fly(
  c: Case,
  scenarios: readonly CompiledScenario[],
  script: Script,
  profile: DisplayProfile = DEFAULT_PROFILE,
): Run {
  const core = AcarsCore.create({ ofp: c.ofp, scenarios, seed: 'cmd', profile });
  core.startFlight();
  const out: OutboundMessage[] = [];
  const events: CoreEvent[] = [];
  const talk: Exchange[] = [];
  const entered = new Map<FlightPhase, number>([['BOARDING', c.flight.snapshots[0]?.t ?? 0]]);
  const done = new Set<number>();
  for (const [k, s] of c.flight.snapshots.entries()) {
    const due = script.flatMap((line, i) => {
      const t0 = entered.get(line.phase);
      return t0 !== undefined && !done.has(i) && s.t >= t0 + line.sec * 1000 ? [i] : [];
    });
    for (const i of due) done.add(i);
    const inbound: PilotMessage[] = due.map((i) => ({
      from: c.ofp.callsign,
      type: 'telex',
      text: script[i]?.say ?? '',
    }));
    const r = core.tick({
      now: s.t,
      telemetry: s,
      inbound,
      ...(k === 0 ? { data: standsFor(c.ofp, s.t) } : {}),
    });
    for (const e of r.events) {
      if (e.type === 'PHASE_CHANGE' && !entered.has(e.to)) entered.set(e.to, e.t);
    }
    // One message per tick in the script, so the tick's telexes answer it.
    if (due.length > 0) {
      talk.push({
        said: due.map((i) => script[i]?.say).join(' + '),
        answers: r.outbound.map((m) => m.scenarioId),
      });
    }
    out.push(...r.outbound);
    events.push(...r.events);
  }
  return { out, events, talk };
}

// MISSING as a value, not inside a separator line of dashes.
const missing = new RegExp(`(^|[^-])${MISSING}($|[^-])`, 'm');
const errors = (r: Run) => r.events.filter((e) => e.type === 'SCENARIO_ERROR');

describe('pilot command scenarios', () => {
  it('load with the base set; file name = id', () => {
    expect(commands.map((s) => `${s.id}.yaml`)).toEqual(commandFiles.map((f) => f.file));
    expect(commands.every((s) => s.def.enabled_by_default)).toBe(true);
  });

  it('cover every command', () => {
    const covered = new Set(
      commands.map((s) => (s.def.trigger.on === 'command' ? s.def.trigger.command : null)),
    );
    expect([...covered].sort()).toEqual(
      ['DELAY', 'DIVERT', 'ETA', 'HELP', 'REQ_GATE', 'REQ_LOADSHEET', 'REQ_WX'].sort(),
    );
  });
});

describe.each(FLIGHTS)('the script on $name', (c) => {
  it.each([DEFAULT_PROFILE, B77X_PROFILE, B78X_PROFILE].map((p) => [p.id, p] as const))(
    '%s',
    (_, profile) => {
      const r = fly(c, all, SCRIPT, profile);
      expect(errors(r)).toEqual([]);
      expect(r.talk).toHaveLength(SCRIPT.length);
      for (const x of r.talk) expect(x.answers.length, x.said).toBeGreaterThan(0);
      for (const m of r.out) {
        expect(checkText(m.message.text, profile)).toEqual([]);
        expect(m.message.text, m.scenarioId).not.toMatch(missing);
        expect(m.message.lines.every((l) => l.length <= profile.lineWidth)).toBe(true);
      }
    },
  );
});

describe('a conversation on the normal flight', () => {
  const r = fly(FLIGHTS[0] as Case, all, SCRIPT);
  const answer = (said: string, n = 0) =>
    r.talk.filter((x) => x.said === said)[n]?.answers ?? ['(not said)'];
  const textOf = (id: string, n = 0) =>
    r.out.filter((m) => m.scenarioId === id)[n]?.message.text ?? '';

  it('each message is answered by the right scenario', () => {
    expect(answer('HELP')).toEqual(['cmd_help']);
    expect(answer('req gate')).toEqual(['cmd_req_gate']);
    expect(answer('REQ WX')).toEqual(['cmd_req_wx']);
    expect(answer('REQ-WX-KJFK')).toEqual(['cmd_req_wx_no_data']);
    expect(answer('ETA')).toEqual(['cmd_eta_ground']);
    expect(answer('REQ LOADSHEET')).toEqual(['cmd_req_loadsheet_none']);
    expect(answer('DELAY 15 LATE CATERING')).toEqual(['cmd_delay']);
    expect(answer('DIVERT RJOO')).toEqual([OPS_REPLY_ID]); // on the ground
    expect(answer('REQ REFUEL')).toEqual([OPS_REPLY_ID]);
    expect(answer('ETA', 1)).toEqual(['cmd_eta_gs']); // with telemetry: by ground speed (T44)
    expect(answer('REQ LS')).toEqual(['cmd_req_loadsheet']);
    expect(answer('DELAY 5')).toEqual([OPS_REPLY_ID]); // off block already
    expect(answer('DIVERT RJOO', 1)).toEqual(['cmd_divert']);
    expect(answer('MEDICAL')).toEqual(['cmd_divert', 'cmd_divert']);
    expect(answer('REQ GATE')).toEqual(['cmd_req_gate_divert']);
  });

  it('REQ GATE names the same gate as the arrival scenarios would', () => {
    const gate = /EXPECTED GATE (\w+)/.exec(textOf('cmd_req_gate'))?.[1];
    const plain = fly(FLIGHTS[0] as Case, all, []);
    const expected = plain.out.find((m) => m.scenarioId === 'gate_assignment')?.message.text;
    expect(expected).toContain(`EXPECTED GATE ${gate}`);
  });

  it('REQ LOADSHEET in cruise is the loadsheet sent before, verbatim', () => {
    const resent = textOf('cmd_req_loadsheet');
    const sheets = r.out.filter(
      (m) => m.scenarioId === 'final_loadsheet' || m.scenarioId === 'prelim_loadsheet',
    );
    expect(resent).toBe(sheets.at(-1)?.message.text);
  });

  it('DELAY moves the off-block time and the pre-departure documents', () => {
    expect(textOf('cmd_delay')).toMatch(/DELAY 15 MIN\nREASON LATE CATERING\nNEW EOBT \d{4}Z/);
    const plain = fly(FLIGHTS[0] as Case, all, []);
    const at = (run: Run, id: string) => run.out.find((m) => m.scenarioId === id)?.t ?? 0;
    // The synthetic flight pushes back on time anyway, so look at a document well before STD.
    expect(at(r, 'prelim_loadsheet') - at(plain, 'prelim_loadsheet')).toBe(15 * 60_000);
  });

  it('after DIVERT no destination arrival messages', () => {
    const ids = r.out.map((m) => m.scenarioId);
    for (const id of ['gate_assignment', 'arrival_info', 'welcome_turnaround']) {
      expect(ids).not.toContain(id);
    }
    expect(textOf('cmd_divert', 1).replaceAll('\n', ' ')).toContain('MEDICAL TEAM ORDERED AT RJOO');
  });

  it('snapshot', () => {
    expect(
      r.out
        .filter((m) => m.scenarioId.startsWith('cmd_') || m.scenarioId === OPS_REPLY_ID)
        .map((m) => `${new Date(m.t).toISOString()} ${m.scenarioId}\n${m.message.text}`),
    ).toMatchSnapshot();
  });
});

describe('reference/scenarios/medical_onboard.yaml (docs/05 example)', () => {
  // Without the parts of later tasks: `set` (T14) and `calc.*` (T13/T14).
  const source = readFileSync(
    join(import.meta.dirname, '../../../reference/scenarios/medical_onboard.yaml'),
    'utf8',
  )
    .replace(/\n\s+- set: .*/, '')
    .replace(/NEAREST SUITABLE .*\n/, '')
    .replace('excludes: [unruly_passenger]\n', '');
  const medical = { ...loadScenario(source, 'medical_onboard.yaml'), probability: 1 };

  it('asks in cruise; DIVERT and silence take their arms', () => {
    const c = FLIGHTS[0] as Case;
    const divert = fly(c, [medical], [{ phase: 'CRUISE', sec: 30, say: 'divert' }]);
    expect(divert.out.map((m) => m.message.text.split('\n')[0])).toEqual([
      'OPS MSG',
      'ROGER DIVERT',
    ]);
    const silent = fly(c, [medical], []);
    expect(silent.out.map((m) => m.message.text.split('\n')[0])).toEqual([
      'OPS MSG',
      'MEDICAL UPDATE: PAX',
    ]);
    const asked = silent.out[0]?.t ?? 0;
    // 10 min to answer, then 15 min wait (flight time = clock time on this flight).
    expect(silent.out[1]?.t).toBe(asked + 25 * 60_000);
  });
});
