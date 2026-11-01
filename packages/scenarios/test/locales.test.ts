// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { describe, expect, it } from 'vitest';
import { loadScenarios, missingTranslations, ScenarioLoadError } from '../src/index.js';

/** T85: translation files of the scenarios' UI texts. */

const scenario = `
id: ask
version: 1
category: irregular
title: Ask
description: Asks.
hint: Scenario hint.
enabled_by_default: true
trigger: { on: phase_enter, phase: CRUISE }
steps:
  - send: { id: question, body: "YES OR NO", hint: Question hint. }
  - wait:
      reply:
        id: answer
        options: [YES, NO]
        timeout_min: 5
        default: NO
        reply_hints: { YES: "Yes.", NO: "No." }
  - send: { body: END }
`;
const files = [{ file: 'ask.yaml', source: scenario }];
const de = (source: string) => [{ lang: 'de', file: 'locales/de.yaml', source }];
const problems = (source: string): string[] => {
  try {
    loadScenarios(files, de(source));
  } catch (e) {
    if (e instanceof ScenarioLoadError) return [...e.problems];
    throw e;
  }
  return [];
};

describe('scenario translations (T85)', () => {
  it('adds the language to the texts; what is not translated stays English only', () => {
    const [s] = loadScenarios(
      files,
      de(`
ask:
  title: Frage
  steps:
    question: { hint: Hinweis. }
    answer: { reply_hints: { YES: "Ja.", NO: "Nein." } }
`),
    );
    expect(s?.texts).toEqual({
      title: { en: 'Ask', de: 'Frage' },
      description: { en: 'Asks.' },
      hint: { en: 'Scenario hint.' },
    });
    expect(s?.steps[0]).toMatchObject({ hint: { en: 'Question hint.', de: 'Hinweis.' } });
    expect(s?.steps[1]).toMatchObject({
      hints: { YES: { en: 'Yes.', de: 'Ja.' }, NO: { en: 'No.', de: 'Nein.' } },
    });
    expect(missingTranslations(s === undefined ? [] : [s], 'de')).toEqual([
      'ask.description',
      'ask.hint',
    ]);
  });

  it('a translation of a scenario, step or text that does not exist is an error', () => {
    expect(problems('nope: { title: X }')).toEqual(['locales/de.yaml: nope: no such scenario']);
    expect(problems('ask: { steps: { other: { hint: X } } }')).toEqual([
      'locales/de.yaml: ask.steps.other.hint: no send step "other" with a hint',
    ]);
    expect(problems('ask: { steps: { question: { reply_hints: { YES: X } } } }')).toEqual([
      'locales/de.yaml: ask.steps.question.reply_hints: no wait: reply "question" with reply_hints',
    ]);
    expect(problems('ask: { steps: { answer: { reply_hints: { YES: X } } } }')).toEqual([
      'locales/de.yaml: ask.steps.answer.reply_hints: one line for each option',
    ]);
    expect(problems('ask: { titel: X }')[0]).toMatch(/must NOT have additional properties/);
    expect(() => loadScenarios(files, [{ lang: 'en', file: 'en.yaml', source: '{}' }])).toThrow(
      /other than en/,
    );
  });
});
