// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import {
  type AwaitedReply,
  type CompiledScenario,
  DCL_ID,
  type LocalText,
  OCL_ID,
  type OutboundMessage,
} from '@acars/core';
import { catalogText } from '../renderer/src/i18n.js';
import { LANGUAGE_IDS, type Language, type UiText } from '../shared/api.js';

/**
 * Hints to messages in the app (T57): what a message means and what each answer of a waiting
 * `wait: reply` means. Static texts from the scenario files (`hint`, `reply_hints`) and, for the
 * XATC departure and oceanic clearances, below. UI only: nothing here goes to the network.
 */

/**
 * How to confirm the clearances of the XATC station (T24, T27; facts of `dcl.ts`, `oceanic.ts`): UI
 * strings `hint.atc.*` (T86) in every language that has them.
 */
const atcHint = (key: 'hint.atc.dcl' | 'hint.atc.pdc' | 'hint.atc.ocl', station: string): UiText =>
  catalogText(key, { station });

/** A scenario text in the app languages: only the languages of the app are passed on. */
export const uiText = (h: LocalText): UiText => {
  const out: { -readonly [L in Language]?: string } = {};
  for (const l of LANGUAGE_IDS) if (h[l] !== undefined) out[l] = h[l];
  return { ...out, en: h.en };
};

export class MessageHints {
  private readonly byId: ReadonlyMap<string, CompiledScenario>;

  constructor(scenarios: readonly CompiledScenario[]) {
    this.byId = new Map(scenarios.map((c) => [c.id, c]));
  }

  /** The hint of a message: its `send` step's, else its scenario's; ATC clearances; else null. */
  forMessage(m: OutboundMessage): UiText | null {
    if (m.scenarioId === DCL_ID) {
      if (m.kind === 'cpdlc') return m.cpdlc?.ra === 'WU' ? atcHint('hint.atc.dcl', m.from) : null;
      return /^UNABLE\b/.test(m.message.text) ? null : atcHint('hint.atc.pdc', m.from);
    }
    if (m.scenarioId === OCL_ID) {
      return /^CLX\b/.test(m.message.text) ? atcHint('hint.atc.ocl', m.from) : null;
    }
    const c = this.byId.get(m.scenarioId);
    if (c === undefined) return null;
    const step = m.step === undefined ? undefined : c.steps[m.step];
    if (step?.kind === 'send' && step.hint !== null) return uiText(step.hint);
    return c.texts.hint === null ? null : uiText(c.texts.hint);
  }

  /** What each option of a waiting answer means; null = the scenario has no `reply_hints`. */
  forReply(r: AwaitedReply): Readonly<Record<string, UiText>> | null {
    const step = r.step === null ? undefined : this.byId.get(r.scenarioId)?.steps[r.step];
    if (step?.kind !== 'wait_reply' || step.hints === null) return null;
    const out: Record<string, UiText> = {};
    for (const [o, h] of Object.entries(step.hints)) out[o] = uiText(h);
    return out;
  }
}
