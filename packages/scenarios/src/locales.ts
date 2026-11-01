// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { type CompiledScenario, type CompiledStep, type LocalText, sameOptions } from '@acars/core';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parseDocument } from 'yaml';
import { ScenarioLoadError } from './load.js';

/**
 * Translations of the scenarios' UI texts (T85): `locales/<lang>.yaml`, keyed by scenario id —
 * `title`, `description`, `hint` and, by step id (`send.id`, `reply.id`), a send step's `hint` and a
 * reply's `reply_hints`. The English texts stay in the scenario files; telexes are never translated.
 * A text without a translation is shown in English.
 */

export interface LocaleSource {
  /** Language code: `ru`, `de`, … (not `en`: English is the scenario files). */
  readonly lang: string;
  readonly file: string;
  readonly source: string;
}

export interface StepLocale {
  readonly hint?: string;
  readonly reply_hints?: Readonly<Record<string, string>>;
}

export interface ScenarioLocale {
  readonly title?: string;
  readonly description?: string;
  readonly hint?: string;
  readonly steps?: Readonly<Record<string, StepLocale>>;
}

export type Locale = Readonly<Record<string, ScenarioLocale>>;

const text = { type: 'string', minLength: 1 } as const;
const id = '^[a-z][a-z0-9_]*$';
const LOCALE_SCHEMA = {
  type: 'object',
  propertyNames: { pattern: id },
  additionalProperties: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: text,
      description: text,
      hint: text,
      steps: {
        type: 'object',
        propertyNames: { pattern: id },
        additionalProperties: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            hint: text,
            reply_hints: {
              type: 'object',
              minProperties: 1,
              propertyNames: { pattern: '^[A-Z][A-Z0-9]*$' },
              additionalProperties: text,
            },
          },
        },
      },
    },
  },
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile<Locale>(LOCALE_SCHEMA);

const LANG = /^[a-z]{2}$/;

/** Parses and schema-validates one translation file. */
export function parseLocale(source: string, file = '<locale>'): Locale {
  const doc = parseDocument(source, { version: '1.2', schema: 'core', uniqueKeys: true });
  if (doc.errors.length > 0)
    throw new ScenarioLoadError(
      file,
      doc.errors.map((e) => e.message),
    );
  const data: unknown = doc.toJS() ?? {};
  if (!validate(data)) {
    const problems = (validate.errors ?? []).map(
      (e) => `${e.instancePath === '' ? '(root)' : e.instancePath}: ${e.message ?? e.keyword}`,
    );
    throw new ScenarioLoadError(file, [...new Set(problems)]);
  }
  return data;
}

const withLang = (t: LocalText, lang: string, v: string | undefined): LocalText =>
  v === undefined ? t : { ...t, [lang]: v };

/**
 * Adds the translations to the compiled scenarios. Throws {@link ScenarioLoadError} with every problem:
 * a scenario or step that does not exist, a text that has no English original, `reply_hints` that do not
 * name exactly the options.
 */
export function localize(
  scenarios: readonly CompiledScenario[],
  locales: readonly LocaleSource[],
): CompiledScenario[] {
  const problems: string[] = [];
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  for (const l of locales) {
    if (!LANG.test(l.lang) || l.lang === 'en') {
      problems.push(`${l.file}: language "${l.lang}" must be a two-letter code other than en`);
      continue;
    }
    let locale: Locale;
    try {
      locale = parseLocale(l.source, l.file);
    } catch (e) {
      if (!(e instanceof ScenarioLoadError)) throw e;
      problems.push(e.message);
      continue;
    }
    for (const [sid, tr] of Object.entries(locale)) {
      const s = byId.get(sid);
      const at = `${l.file}: ${sid}`;
      if (s === undefined) {
        problems.push(`${at}: no such scenario`);
        continue;
      }
      if (tr.description !== undefined && s.texts.description === null) {
        problems.push(`${at}.description: the scenario has no English description`);
      }
      if (tr.hint !== undefined && s.texts.hint === null) {
        problems.push(`${at}.hint: the scenario has no English hint`);
      }
      const steps = s.steps.map((step): CompiledStep => {
        if (step.kind !== 'send' && step.kind !== 'wait_reply') return step;
        const t = step.id === null ? undefined : tr.steps?.[step.id];
        if (t === undefined) return step;
        if (step.kind === 'send' && step.hint !== null && t.hint !== undefined) {
          return { ...step, hint: withLang(step.hint, l.lang, t.hint) };
        }
        if (step.kind === 'wait_reply' && step.hints !== null && t.reply_hints !== undefined) {
          const rh = t.reply_hints;
          if (!sameOptions(step.options, Object.keys(rh))) {
            problems.push(`${at}.steps.${step.id}.reply_hints: one line for each option`);
            return step;
          }
          const hints: Record<string, LocalText> = {};
          for (const [o, h] of Object.entries(step.hints)) hints[o] = withLang(h, l.lang, rh[o]);
          return { ...step, hints };
        }
        return step;
      });
      for (const [stepId, t] of Object.entries(tr.steps ?? {})) {
        const has = (kind: 'send' | 'wait_reply') =>
          s.steps.some((x) =>
            x.kind === 'send'
              ? kind === 'send' && x.id === stepId && x.hint !== null
              : x.kind === 'wait_reply' && kind === x.kind && x.id === stepId && x.hints !== null,
          );
        if (t.hint !== undefined && !has('send')) {
          problems.push(`${at}.steps.${stepId}.hint: no send step "${stepId}" with a hint`);
        }
        if (t.reply_hints !== undefined && !has('wait_reply')) {
          problems.push(
            `${at}.steps.${stepId}.reply_hints: no wait: reply "${stepId}" with reply_hints`,
          );
        }
      }
      byId.set(sid, {
        ...s,
        steps,
        texts: {
          title: withLang(s.texts.title, l.lang, tr.title),
          description:
            s.texts.description === null
              ? null
              : withLang(s.texts.description, l.lang, tr.description),
          hint: s.texts.hint === null ? null : withLang(s.texts.hint, l.lang, tr.hint),
        },
      });
    }
  }
  if (problems.length > 0) throw new ScenarioLoadError('locales', problems);
  return scenarios.map((s) => byId.get(s.id) as CompiledScenario);
}

/** English texts of the scenarios without a `lang` translation (T85 completeness report): `id.path`. */
export function missingTranslations(
  scenarios: readonly CompiledScenario[],
  lang: string,
): string[] {
  const out: string[] = [];
  for (const s of scenarios) {
    const check = (path: string, t: LocalText | null) => {
      if (t !== null && t[lang] === undefined) out.push(`${s.id}.${path}`);
    };
    check('title', s.texts.title);
    check('description', s.texts.description);
    check('hint', s.texts.hint);
    for (const step of s.steps) {
      if (step.kind === 'send') check(`steps.${step.id}.hint`, step.hint);
      if (step.kind === 'wait_reply' && step.hints !== null) {
        for (const [o, h] of Object.entries(step.hints)) {
          check(`steps.${step.id}.reply_hints.${o}`, h);
        }
      }
    }
  }
  return out;
}
