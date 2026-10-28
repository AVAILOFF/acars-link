// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AcarsCore,
  type CompiledScenario,
  compileScenario,
  generateSyntheticFlight,
  type OutboundMessage,
  parseSimbriefOfp,
  type ScenarioDef,
  ScenarioError,
} from '../src/index.js';

/** T57: hints of a scenario (UI only) and the answers the core waits for. */

const ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'ofp', 'rctp-rjbb-a35k-kgs.json'), 'utf8'),
  ),
);
const flight = generateSyntheticFlight({ ofp });

const question: ScenarioDef = {
  id: 'question',
  version: 1,
  category: 'irregular',
  title: 'Question',
  hint: 'Scenario hint.',
  hint_ru: 'Подсказка сценария.',
  enabled_by_default: true,
  trigger: { on: 'phase_enter', phase: 'CRUISE' },
  steps: [
    { send: { body: 'CONFIRM OR NEGATIVE' } },
    {
      wait: {
        reply: {
          options: ['CONFIRM', 'NEGATIVE'],
          timeout_min: 10,
          default: 'NEGATIVE',
          reply_hints: { CONFIRM: 'Yes.', NEGATIVE: 'No.' },
          reply_hints_ru: { CONFIRM: 'Да.', NEGATIVE: 'Нет.' },
        },
      },
    },
    {
      branch: {
        CONFIRM: [{ send: { body: 'CONFIRMED', hint: 'Step hint.', hint_ru: 'Подсказка шага.' } }],
      },
    },
    { send: { body: 'END' } },
  ],
};

const withSteps = (steps: ScenarioDef['steps']): ScenarioDef => ({ ...question, steps });

describe('hints in the scenario (T57)', () => {
  it('compiles the step hint and the hints of the answers; the scenario hint stays in def', () => {
    const c = compileScenario(question);
    expect(c.def.hint).toBe('Scenario hint.');
    const wait = c.steps.find((s) => s.kind === 'wait_reply');
    expect(wait).toMatchObject({
      hints: { CONFIRM: { en: 'Yes.', ru: 'Да.' }, NEGATIVE: { en: 'No.', ru: 'Нет.' } },
    });
    const sends = c.steps.flatMap((s) => (s.kind === 'send' ? [s.hint] : []));
    expect(sends).toEqual([null, { en: 'Step hint.', ru: 'Подсказка шага.' }, null]);
  });

  it('reply_hints name exactly the options; a Russian hint needs the English one', () => {
    const reply = (extra: object) =>
      withSteps([
        { send: { body: 'X' } },
        {
          wait: {
            reply: { options: ['A', 'B'], timeout_min: 1, default: 'A', ...extra },
          },
        },
      ]);
    expect(() => compileScenario(reply({ reply_hints: { A: 'a' } }))).toThrow(ScenarioError);
    expect(() => compileScenario(reply({ reply_hints: { A: 'a', B: 'b', C: 'c' } }))).toThrow(
      /one line for each option/,
    );
    expect(() =>
      compileScenario(reply({ reply_hints: { A: 'a', B: 'b' }, reply_hints_ru: { A: 'а' } })),
    ).toThrow(/reply_hints_ru/);
    expect(() => compileScenario(reply({ reply_hints_ru: { A: 'а', B: 'б' } }))).toThrow(
      /needs reply_hints/,
    );
    const { hint: _, ...noHint } = question;
    expect(() => compileScenario(noHint)).toThrow(/hint_ru/);
    expect(() => compileScenario(withSteps([{ send: { body: 'X', hint_ru: 'х' } }]))).toThrow(
      /send\.hint_ru/,
    );
  });
});

/** Flies until `stop` says so after a tick; `answer` is sent on the tick after the question. */
function run(
  scenarios: readonly CompiledScenario[],
  answer: string | null,
  stop: (core: AcarsCore, out: readonly OutboundMessage[]) => boolean = () => false,
) {
  const core = AcarsCore.create({ ofp, scenarios, seed: 'hints' });
  core.startFlight();
  const out: OutboundMessage[] = [];
  const pending: number[] = [];
  let asked = false;
  for (const s of flight.snapshots) {
    const inbound =
      asked && answer !== null && out.length === 1
        ? [{ from: ofp.callsign, type: 'telex', text: answer }]
        : [];
    out.push(...core.tick({ now: s.t, telemetry: s, inbound }).outbound);
    asked = out.length > 0;
    pending.push(core.pendingReplies.length);
    if (stop(core, out)) break;
  }
  return { core, out, pending };
}

describe('answers the core waits for (T57)', () => {
  const compiled = [compileScenario(question)];

  it('appear after the question with the options, the default and the time left', () => {
    const { core } = run(compiled, null, (c) => c.pendingReplies.length > 0);
    const [p] = core.pendingReplies;
    expect(p).toMatchObject({
      scenarioId: 'question',
      step: 1,
      options: ['CONFIRM', 'NEGATIVE'],
      default: 'NEGATIVE',
    });
    expect(p?.leftMs).toBeGreaterThan(9 * 60_000);
    expect(p?.leftMs).toBeLessThanOrEqual(10 * 60_000);
  });

  it('go away with the answer; the step of each message is on it', () => {
    const { out, pending } = run(compiled, 'CONFIRM');
    expect(out.map((m) => [m.message.text, m.step])).toEqual([
      ['CONFIRM OR NEGATIVE', 0],
      ['CONFIRMED', 3],
      ['END', 5],
    ]);
    expect(Math.max(...pending)).toBe(1);
    expect(pending.at(-1)).toBe(0);
  });

  it('go away when the time is up (the default is taken)', () => {
    const { out, pending } = run(compiled, null);
    expect(out.map((m) => m.message.text)).toEqual(['CONFIRM OR NEGATIVE', 'END']);
    expect(pending.filter((n) => n === 1).length).toBeGreaterThan(0);
    expect(pending.at(-1)).toBe(0);
  });

  it('are kept in the state: a core resumed from it waits for the same answer', () => {
    const { core } = run(compiled, null, (c) => c.pendingReplies.length > 0);
    const state = JSON.parse(JSON.stringify(core.getState()));
    const again = AcarsCore.fromState(state, { ofp, scenarios: compiled, seed: 'hints' });
    expect(again.pendingReplies).toEqual(core.pendingReplies);
  });

  it('a state saved before T57 (no step) still gives the wait, without its step', () => {
    const { core } = run(compiled, null, (c) => c.pendingReplies.length > 0);
    const state = JSON.parse(JSON.stringify(core.getState()));
    for (const r of state.engine.runs) delete r.reply.step;
    const again = AcarsCore.fromState(state, { ofp, scenarios: compiled, seed: 'hints' });
    expect(again.pendingReplies).toMatchObject([{ scenarioId: 'question', step: null }]);
  });
});
