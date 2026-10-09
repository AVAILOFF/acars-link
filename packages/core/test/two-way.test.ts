import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AcarsCore,
  type CompiledScenario,
  type CoreEvent,
  compileScenario,
  generateSyntheticFlight,
  normalizePilotText,
  OPS_REPLY_ID,
  type OutboundMessage,
  type PilotMessage,
  parseCommand,
  parseSimbriefOfp,
  type ScenarioDef,
  ScenarioError,
  type SyntheticFlight,
  stageIndex,
} from '../src/index.js';

/** T12: pilot answers (`wait: reply`, `branch`), pilot commands, `resend`. */

const ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'ofp', 'rctp-rjbb-a35k-kgs.json'), 'utf8'),
  ),
);
const normal = generateSyntheticFlight({ ofp });
const MIN = 60_000;

const def = (d: Partial<ScenarioDef> & Pick<ScenarioDef, 'id' | 'trigger'>): ScenarioDef => ({
  version: 1,
  category: 'ops',
  title: d.id,
  enabled_by_default: true,
  steps: [{ send: { body: `${d.id.toUpperCase()}` } }],
  ...d,
});

const pilot = (text: string, from = ofp.callsign, type = 'telex'): PilotMessage => ({
  from,
  type,
  text,
});

interface Result {
  readonly core: AcarsCore;
  readonly out: OutboundMessage[];
  readonly events: CoreEvent[];
}

/** Flies `flight`; `say` maps a snapshot index to the pilot telexes of that tick. */
function fly(
  scenarios: readonly (ScenarioDef | CompiledScenario)[],
  say: ReadonlyMap<number, readonly PilotMessage[]> = new Map(),
  flight: SyntheticFlight = normal,
): Result {
  const compiled = scenarios.map((s) =>
    'steps' in s && 'conditions' in s && 'def' in s ? s : compileScenario(s as ScenarioDef),
  );
  const core = AcarsCore.create({ ofp, scenarios: compiled, seed: 'two-way' });
  core.startFlight();
  const out: OutboundMessage[] = [];
  const events: CoreEvent[] = [];
  flight.snapshots.forEach((s, i) => {
    const inbound = say.get(i);
    const r = core.tick({ now: s.t, telemetry: s, ...(inbound === undefined ? {} : { inbound }) });
    out.push(...r.outbound);
    events.push(...r.events);
  });
  return { core, out, events };
}

/** Message texts, lines joined by a space (wrapping depends on the profile). */
const texts = (r: Result, id?: string) =>
  r.out
    .filter((m) => id === undefined || m.scenarioId === id)
    .map((m) => m.message.text.replaceAll('\n', ' '));
const pilotEvents = (r: Result) => r.events.flatMap((e) => (e.type === 'PILOT_MESSAGE' ? [e] : []));
const at = (stage: Parameters<typeof stageIndex>[1], sec = 0) => stageIndex(normal, stage, sec);

/** Index of the first snapshot at or after the phase-machine entering `phase`. */
function phaseIndex(phase: string): number {
  const core = AcarsCore.create({ ofp, scenarios: [], seed: 'x' });
  core.startFlight();
  const i = normal.snapshots.findIndex(
    (s) => core.tick({ now: s.t, telemetry: s }).phase === phase,
  );
  if (i < 0) throw new Error(`no ${phase}`);
  return i;
}
const CRUISE = phaseIndex('CRUISE');

/** Asks in cruise: CONTINUE (default after 10 min) or DIVERT. */
const question = def({
  id: 'medical',
  trigger: { on: 'phase_enter', phase: 'CRUISE' },
  steps: [
    { send: { body: 'MEDICAL CASE ON BOARD\nREPLY CONTINUE OR DIVERT' } },
    { wait: { reply: { options: ['CONTINUE', 'DIVERT'], timeout_min: 10, default: 'CONTINUE' } } },
    {
      branch: {
        DIVERT: [{ send: { body: 'DIVERT NOTED {reply.arg}' } }],
        CONTINUE: [{ send: { body: 'CONTINUE NOTED TIMEOUT {reply.timeout}' } }],
      },
    },
    { send: { body: 'END {reply.option}' } },
  ],
});

describe('pilot text and command parser', () => {
  it('normalizes case, separators and spaces', () => {
    expect(normalizePilotText('  req-wx/eddf  ')).toBe('REQ WX EDDF');
    expect(normalizePilotText('REQ-REFUEL')).toBe('REQ REFUEL');
    expect(normalizePilotText('{}"<>')).toBe('');
  });

  it('parses the commands of docs/05', () => {
    expect(parseCommand('REQ WX EDDF')).toEqual({
      ok: true,
      command: 'REQ_WX',
      args: { icao: 'EDDF', minutes: null, reason: null },
    });
    expect(parseCommand('REQ WX')).toMatchObject({ ok: true, args: { icao: null } });
    expect(parseCommand('REQ METAR RJBB')).toMatchObject({ command: 'REQ_WX' });
    expect(parseCommand('REQ GATE')).toMatchObject({ ok: true, command: 'REQ_GATE' });
    expect(parseCommand('REQ LOADSHEET')).toMatchObject({ ok: true, command: 'REQ_LOADSHEET' });
    expect(parseCommand('REQ LS')).toMatchObject({ ok: true, command: 'REQ_LOADSHEET' });
    expect(parseCommand('DELAY 20 LATE CATERING')).toEqual({
      ok: true,
      command: 'DELAY',
      args: { icao: null, minutes: 20, reason: 'LATE CATERING' },
    });
    expect(parseCommand('DELAY 15')).toMatchObject({ args: { minutes: 15, reason: null } });
    expect(parseCommand('DIVERT RJOO')).toMatchObject({ ok: true, args: { icao: 'RJOO' } });
    expect(parseCommand('ETA')).toMatchObject({ ok: true, command: 'ETA' });
    expect(parseCommand('HELP')).toMatchObject({ ok: true, command: 'HELP' });
  });

  it('known command with bad arguments: a hint; anything else: null', () => {
    expect(parseCommand('DELAY SOON')).toMatchObject({ ok: false, command: 'DELAY' });
    expect(parseCommand('DELAY 0')).toMatchObject({ ok: false });
    expect(parseCommand('DELAY 601')).toMatchObject({ ok: false });
    expect(parseCommand('DIVERT')).toMatchObject({ ok: false, hint: 'DIVERT ICAO' });
    expect(parseCommand('REQ WX FRANKFURT')).toMatchObject({ ok: false, command: 'REQ_WX' });
    expect(parseCommand('REQ REFUEL')).toBeNull();
    expect(parseCommand('HELLO')).toBeNull();
  });
});

describe('wait: reply and branch', () => {
  it('compiles into a flat program with jumps', () => {
    const c = compileScenario(question);
    expect(c.steps.map((s) => s.kind)).toEqual([
      'send',
      'wait_reply',
      'branch',
      'send',
      'jump',
      'send',
      'jump',
      'send',
    ]);
    expect(c.steps[2]).toEqual({ kind: 'branch', arms: { DIVERT: 3, CONTINUE: 5 }, end: 7 });
  });

  it('the pilot answer picks the arm; words after the option are reply.arg', () => {
    const ask = CRUISE;
    const r = fly([question], new Map([[ask + 30, [pilot('divert rjoo please')]]]));
    expect(texts(r, 'medical').slice(1)).toEqual(['DIVERT NOTED RJOO PLEASE', 'END DIVERT']);
    expect(r.events).toContainEqual(
      expect.objectContaining({ type: 'REPLY_EXPECTED', id: 'medical', timeoutMs: 10 * MIN }),
    );
    expect(pilotEvents(r)).toEqual([
      expect.objectContaining({
        result: 'reply',
        scenarioId: 'medical',
        text: 'DIVERT RJOO PLEASE',
      }),
    ]);
    // The answer comes on the tick of the pilot message.
    const answer = r.out.find((m) => m.message.text.startsWith('DIVERT NOTED'));
    expect(answer?.t).toBe(normal.snapshots[ask + 30]?.t);
  });

  it('no answer: the default after timeout_min of flight time', () => {
    const r = fly([question]);
    const asked = r.out.find((m) => m.scenarioId === 'medical')?.t ?? 0;
    expect(texts(r, 'medical').slice(1)).toEqual(['CONTINUE NOTED TIMEOUT TRUE', 'END CONTINUE']);
    const timeout = r.events.find((e) => e.type === 'REPLY_TIMEOUT');
    expect(timeout).toMatchObject({ id: 'medical', option: 'CONTINUE' });
    expect(timeout?.t).toBe(asked + 10 * MIN); // synthetic flight: 1 s steps at ×1
  });

  it('an answer without an arm goes on after the branch', () => {
    const d = def({
      ...question,
      steps: [
        { wait: { reply: { options: ['YES', 'NO'], timeout_min: 5, default: 'NO' } } },
        { branch: { YES: [{ send: { body: 'GOOD' } }] } },
        { send: { body: 'BYE {reply.option}' } },
      ],
    });
    const r = fly([d], new Map([[CRUISE + 5, [pilot('NO')]]]));
    expect(texts(r, 'medical')).toEqual(['BYE NO']);
  });

  it('nested questions', () => {
    const d = def({
      ...question,
      steps: [
        { wait: { reply: { options: ['A', 'B'], timeout_min: 5, default: 'A' } } },
        {
          branch: {
            A: [
              { send: { body: 'SURE' } },
              { wait: { reply: { options: ['X', 'Y'], timeout_min: 5, default: 'X' } } },
              { branch: { Y: [{ send: { body: 'AY' } }], X: [{ send: { body: 'AX' } }] } },
            ],
            B: [{ send: { body: 'B' } }],
          },
        },
        { send: { body: 'DONE' } },
      ],
    });
    const c = CRUISE;
    const r = fly(
      [d],
      new Map([
        [c + 5, [pilot('A')]],
        [c + 10, [pilot('Y')]],
      ]),
    );
    expect(texts(r, 'medical')).toEqual(['SURE', 'AY', 'DONE']);
  });

  it('serializes mid-question and resumes with the answer', () => {
    const c = compileScenario(question);
    const core = AcarsCore.create({ ofp, scenarios: [c], seed: 's' });
    core.startFlight();
    const ask = CRUISE;
    for (const s of normal.snapshots.slice(0, ask + 5)) core.tick({ now: s.t, telemetry: s });
    const resumed = AcarsCore.fromState(JSON.parse(JSON.stringify(core.getState())), {
      ofp,
      scenarios: [c],
      seed: 's',
    });
    const s = normal.snapshots[ask + 5];
    if (s === undefined) throw new Error('flight too short');
    const r = resumed.tick({ now: s.t, telemetry: s, inbound: [pilot('DIVERT')] });
    expect(r.outbound.map((m) => m.message.text)).toEqual(['DIVERT NOTED ----', 'END DIVERT']);
  });

  it('pilot messages wait while telemetry is lost', () => {
    const core = AcarsCore.create({ ofp, scenarios: [compileScenario(question)], seed: 'g' });
    core.startFlight();
    const c = CRUISE + 20;
    for (const s of normal.snapshots.slice(0, c)) core.tick({ now: s.t, telemetry: s });
    const t0 = normal.snapshots[c - 1]?.t ?? 0;
    // Lost after 30 s without a snapshot (docs/04); the answer arrives at 35 s.
    for (let k = 1; k <= 34; k++) core.tick({ now: t0 + k * 1000, telemetry: null });
    const during = core.tick({ now: t0 + 35_000, telemetry: null, inbound: [pilot('DIVERT')] });
    expect(during.outbound).toEqual([]);
    expect(core.getState().engine.inbox).toHaveLength(1);
    const back = normal.snapshots[c + 40];
    if (back === undefined) throw new Error('flight too short');
    const r = core.tick({ now: back.t, telemetry: back });
    expect(r.outbound.map((m) => m.message.text)).toEqual(['DIVERT NOTED ----', 'END DIVERT']);
    expect(core.getState().engine.inbox).toEqual([]);
  });

  it('rejects bad definitions', () => {
    const bad = (steps: ScenarioDef['steps']) => () =>
      compileScenario(def({ id: 'bad', trigger: { on: 'phase', phase: 'CRUISE' }, steps }));
    const w = (options: string[], d = options[0] as string) => ({
      wait: { reply: { options, timeout_min: 5, default: d } },
    });
    expect(bad([{ branch: { A: [{ send: { body: 'X' } }] } }])).toThrow(/needs a wait: reply/);
    expect(bad([w(['A']), { branch: { B: [{ send: { body: 'X' } }] } }])).toThrow(/not an option/);
    expect(bad([w(['A', 'B'], 'C')])).toThrow(/default/);
    expect(bad([w(['A', 'A'])])).toThrow(/unique/);
    expect(bad([w(['TWO WORDS'])])).toThrow(/one word/);
    expect(bad([w(['A']), { branch: { A: [] } }])).toThrow(/must not be empty/);
    expect(
      bad([
        w(['A', 'B']),
        { branch: { A: [w(['X'])] } },
        { branch: { A: [{ send: { body: 'X' } }] } },
      ]),
    ).toThrow(ScenarioError);
  });
});

describe('pilot commands', () => {
  const gate = def({
    id: 'cmd_gate',
    trigger: { on: 'command', command: 'REQ_GATE' },
    steps: [{ send: { body: 'GATE {ops.arr_gate} FOR {cmd.text}' } }],
  });
  const wx = def({
    id: 'cmd_wx',
    trigger: { on: 'command', command: 'REQ_WX' },
    conditions: ['cmd.metar != null'],
    steps: [{ send: { body: '{cmd.icao} {cmd.metar}' } }],
  });
  const wxNone = def({
    id: 'cmd_wx_none',
    trigger: { on: 'command', command: 'REQ_WX' },
    conditions: ['cmd.metar == null'],
    steps: [{ send: { body: 'NO WX FOR {cmd.icao}' } }],
  });
  const delay = def({
    id: 'cmd_delay',
    trigger: { on: 'command', command: 'DELAY' },
    steps: [
      {
        send: {
          body: 'DELAY {cmd.minutes} {cmd.reason} TOTAL {flight.delay_min} EOBT {ofp.est_out|hhmm}',
        },
      },
    ],
  });
  const divert = def({
    id: 'cmd_divert',
    trigger: { on: 'command', command: 'DIVERT' },
    steps: [{ send: { body: 'DIVERT {cmd.icao} {flight.divert}' } }],
  });
  const loadsheet = def({
    id: 'loadsheet',
    trigger: { on: 'phase_enter', phase: 'TAXI_OUT' },
    steps: [{ send: { header: 'LOADSHEET', body: 'ZFW {load.zfw_kg|kg1}' } }],
  });
  const resend = def({
    id: 'cmd_ls',
    trigger: { on: 'command', command: 'REQ_LOADSHEET' },
    conditions: ["'loadsheet' in flight.sent"],
    steps: [{ resend: { of: ['loadsheet'] } }],
  });

  it('every request answered, repeatedly (cooldown none by default)', () => {
    const b = at('GATE', 60);
    const r = fly(
      [gate],
      new Map([
        [b, [pilot('req gate')]],
        [b + 5, [pilot('REQ-GATE')]],
      ]),
    );
    expect(texts(r, 'cmd_gate')).toHaveLength(2);
    expect(texts(r, 'cmd_gate')[0]).toMatch(/^GATE [A-E]\d+ FOR REQ GATE$/);
  });

  it('REQ WX: METAR from the OFP for orig/dest/altn, else the other scenario', () => {
    const b = at('CRUISE');
    const r = fly(
      [wx, wxNone],
      new Map([
        [b, [pilot('REQ WX')]],
        [b + 1, [pilot('REQ WX RCTP')]],
        [b + 2, [pilot('REQ WX KJFK')]],
      ]),
    );
    expect(texts(r, 'cmd_wx')).toEqual(
      [`${ofp.destination.icao} ${ofp.destination.metar}`, `RCTP ${ofp.origin.metar}`].map((t) =>
        expect.stringContaining(t.slice(0, 20)),
      ),
    );
    expect(texts(r, 'cmd_wx_none')).toEqual(['NO WX FOR KJFK']);
  });

  it('DELAY before off-block moves the estimates; after it, UNABLE', () => {
    const b = at('GATE', 60);
    const r = fly(
      [delay],
      new Map([
        [b, [pilot('DELAY 20 LATE CATERING')]],
        [at('CRUISE'), [pilot('DELAY 10')]],
      ]),
    );
    const eobt = new Date(ofp.times.estOutMs + 20 * MIN);
    const hhmm = `${String(eobt.getUTCHours()).padStart(2, '0')}${String(eobt.getUTCMinutes()).padStart(2, '0')}`;
    expect(texts(r, 'cmd_delay')).toEqual([`DELAY 20 LATE CATERING TOTAL 20 EOBT ${hhmm}`]);
    expect(r.core.delayMs).toBe(20 * MIN);
    expect(texts(r, OPS_REPLY_ID)).toEqual(['UNABLE DELAY OFF BLOCK ALREADY SEND HELP FOR LIST']);
  });

  it('DIVERT only airborne, not to the destination', () => {
    const r = fly(
      [divert],
      new Map([
        [at('GATE', 60), [pilot('DIVERT RJOO')]],
        [at('CRUISE'), [pilot(`DIVERT ${ofp.destination.icao}`)]],
        [at('CRUISE', 10), [pilot('DIVERT RJOO')]],
      ]),
    );
    expect(texts(r, OPS_REPLY_ID)).toEqual([
      expect.stringContaining('NOT AIRBORNE'),
      expect.stringContaining('IS DESTINATION'),
    ]);
    expect(texts(r, 'cmd_divert')).toEqual(['DIVERT RJOO RJOO']);
    expect(r.core.getState().engine.divert).toBe('RJOO');
  });

  it('REQ LOADSHEET resends the last loadsheet verbatim', () => {
    const r = fly(
      [loadsheet, resend],
      new Map([
        [at('GATE', 1), [pilot('REQ LOADSHEET')]],
        [at('CRUISE'), [pilot('REQ LS')]],
      ]),
    );
    // Before the loadsheet was sent: no scenario applies → RCVD.
    expect(texts(r, OPS_REPLY_ID)).toEqual(['RCVD REQ LOADSHEET']);
    expect(texts(r, 'cmd_ls')).toEqual(texts(r, 'loadsheet'));
  });

  it('unknown text, other senders, CPDLC', () => {
    const b = at('GATE', 60);
    const r = fly(
      [gate],
      new Map([
        [
          b,
          [
            pilot('REQ REFUEL'),
            pilot('REQ GATE', 'XYZ123'),
            pilot('/data2/0//Y/REQUEST LOGON', ofp.callsign, 'cpdlc'),
            pilot('  '),
          ],
        ],
      ]),
    );
    expect(texts(r)).toEqual(['UNABLE REQ REFUEL SEND HELP FOR LIST']);
    expect(pilotEvents(r).map((e) => [e.result, e.detail])).toEqual([
      ['unknown', null],
      ['ignored', 'from XYZ123'],
      ['ignored', 'type cpdlc'],
      ['ignored', 'empty'],
    ]);
  });

  it('a reply option wins over a command with the same word', () => {
    const ask = CRUISE;
    const r = fly([question, divert], new Map([[ask + 30, [pilot('DIVERT RJOO')]]]));
    expect(texts(r, 'cmd_divert')).toEqual([]);
    expect(texts(r, 'medical')).toContain('DIVERT NOTED RJOO');
    expect(r.core.getState().engine.divert).toBeNull();
  });

  it('same inputs → same output', () => {
    const say = new Map([[at('GATE', 60), [pilot('DELAY 5'), pilot('REQ GATE')]]]);
    expect(fly([gate, delay], say).out).toEqual(fly([gate, delay], say).out);
  });
});
