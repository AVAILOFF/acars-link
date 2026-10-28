// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { CompiledScenario } from '@acars/core';
import { loadScenarios, parseScenario } from '@acars/scenarios';

/**
 * Which scenarios a replay runs. Extra files (being debugged) replace base scenarios with
 * the same id and are always enabled; otherwise the replay runs what the flight had enabled.
 */

export interface ScenarioFile {
  readonly file: string;
  readonly source: string;
}

export interface PickOptions {
  readonly base: readonly ScenarioFile[];
  readonly extra: readonly ScenarioFile[];
  /** Ids enabled in the recorded flight. */
  readonly recorded: readonly string[];
  /** Exactly these ids. */
  readonly only?: readonly string[];
  /** Every loaded scenario. */
  readonly all?: boolean;
}

export interface Picked {
  readonly scenarios: readonly CompiledScenario[];
  /** Recorded ids that are not among the loaded scenarios. */
  readonly missing: readonly string[];
}

export function pickScenarios(o: PickOptions): Picked {
  const extraIds = new Set(o.extra.map((f) => parseScenario(f.source, f.file).id));
  const base = o.base.filter((f) => !extraIds.has(parseScenario(f.source, f.file).id));
  const loaded = loadScenarios([...o.extra, ...base]);
  const known = new Set(loaded.map((s) => s.id));
  if (o.only !== undefined) {
    const unknown = o.only.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`unknown scenario id: ${unknown.join(', ')}`);
    return { scenarios: loaded.filter((s) => o.only?.includes(s.id)), missing: [] };
  }
  const missing = o.recorded.filter((id) => !known.has(id));
  if (o.all === true) return { scenarios: loaded, missing };
  const on = new Set([...o.recorded, ...extraIds]);
  return { scenarios: loaded.filter((s) => on.has(s.id)), missing };
}

/** Ids a new flight would run with the default settings. */
export function defaultEnabled(files: readonly ScenarioFile[]): string[] {
  return loadScenarios(files)
    .filter((s) => s.def.enabled_by_default)
    .map((s) => s.id);
}
