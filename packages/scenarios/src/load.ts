// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import {
  type CompiledScenario,
  compileScenario,
  type ScenarioDef,
  ScenarioError,
  type Step,
  withGroups,
} from '@acars/core';
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import { parseDocument } from 'yaml';
import { SCENARIO_GROUPS } from './groups.js';
import { type LocaleSource, localize } from './locales.js';
import { SCENARIO_SCHEMA } from './schema.js';

/**
 * YAML → JSON Schema → `compileScenario`. Throws {@link ScenarioLoadError} with the
 * file name and every problem found.
 */

export class ScenarioLoadError extends Error {
  override readonly name = 'ScenarioLoadError';
  constructor(
    readonly file: string,
    readonly problems: readonly string[],
  ) {
    super(`${file}: ${problems.join('; ')}`);
  }
}

// strictRequired off: `required` inside oneOf/anyOf branches refers to sibling properties.
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
const validate = ajv.compile<ScenarioDef>(SCENARIO_SCHEMA);

function describe(e: ErrorObject): string {
  const at = e.instancePath === '' ? '(root)' : e.instancePath;
  if (e.keyword === 'additionalProperties') {
    return `${at}: unknown property "${String(e.params['additionalProperty'])}"`;
  }
  if (e.keyword === 'enum') {
    return `${at}: must be one of ${(e.params['allowedValues'] as unknown[]).join(', ')}`;
  }
  return `${at}: ${e.message ?? e.keyword}`;
}

/** Parses and schema-validates one scenario file. */
export function parseScenario(source: string, file = '<scenario>'): ScenarioDef {
  // YAML 1.2 core schema: `on: phase` stays the string "on" (YAML 1.1 would read true).
  const doc = parseDocument(source, { version: '1.2', schema: 'core', uniqueKeys: true });
  if (doc.errors.length > 0)
    throw new ScenarioLoadError(
      file,
      doc.errors.map((e) => e.message),
    );
  const data: unknown = doc.toJS();
  if (!validate(data)) {
    // oneOf failures repeat every branch's errors; keep them unique.
    const problems = [...new Set((validate.errors ?? []).map(describe))];
    throw new ScenarioLoadError(file, problems);
  }
  return data;
}

/** Scenario ids named by `resend` steps, nested branches included. */
function resendIds(steps: readonly Step[]): string[] {
  return steps.flatMap((s) =>
    'resend' in s
      ? [...s.resend.of]
      : 'branch' in s
        ? Object.values(s.branch).flatMap((arm) => resendIds(arm))
        : [],
  );
}

/** Parses, validates and compiles one scenario file. */
export function loadScenario(source: string, file = '<scenario>'): CompiledScenario {
  const def = parseScenario(source, file);
  try {
    return withGroups(compileScenario(def), SCENARIO_GROUPS);
  } catch (e) {
    if (e instanceof ScenarioError) throw new ScenarioLoadError(file, [`${e.path}: ${e.message}`]);
    throw e;
  }
}

/**
 * Loads several files; ids must be unique across them. Collects all errors. `locales` — translations of
 * the UI texts (T85, `locales/<lang>.yaml`), checked against the loaded scenarios.
 */
export function loadScenarios(
  files: readonly { readonly file: string; readonly source: string }[],
  locales: readonly LocaleSource[] = [],
): CompiledScenario[] {
  const out: CompiledScenario[] = [];
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const f of files) {
    try {
      const s = loadScenario(f.source, f.file);
      const dup = seen.get(s.id);
      if (dup !== undefined) problems.push(`${f.file}: id "${s.id}" already used by ${dup}`);
      else {
        seen.set(s.id, f.file);
        out.push(s);
      }
    } catch (e) {
      if (!(e instanceof ScenarioLoadError)) throw e;
      problems.push(e.message);
    }
  }
  for (const s of out) {
    for (const x of s.def.excludes ?? []) {
      if (!seen.has(x))
        problems.push(`${seen.get(s.id) ?? s.id}: excludes unknown scenario "${x}"`);
    }
    for (const x of resendIds(s.def.steps)) {
      if (!seen.has(x))
        problems.push(`${seen.get(s.id) ?? s.id}: resend of unknown scenario "${x}"`);
    }
  }
  if (problems.length > 0) throw new ScenarioLoadError('scenarios', problems);
  return locales.length === 0 ? out : localize(out, locales);
}
