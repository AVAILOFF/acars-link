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
import { LANGUAGE_IDS, type Language, type UiText } from '../shared/api.js';

/**
 * Hints to messages in the app (T57): what a message means and what each answer of a waiting
 * `wait: reply` means. Static texts from the scenario files (`hint`, `reply_hints`) and, for the
 * XATC departure and oceanic clearances, below. UI only: nothing here goes to the network.
 */

/** How to confirm the clearances of the XATC station (T24, T27; facts of `dcl.ts`, `oceanic.ts`). */
const ATC_HINTS: Readonly<Record<'dcl' | 'pdc' | 'ocl', UiText>> = {
  dcl: {
    en: 'Departure clearance (CLD) from {station} over CPDLC. Check it and reply WILCO on the FMS ATC (CPDLC) page, or UNABLE if you cannot accept it.',
    ru: 'Разрешение на вылет (CLD) от {station} по CPDLC. Проверьте его и ответьте WILCO на странице ATC (CPDLC) в FMS или UNABLE, если принять не можете.',
  },
  pdc: {
    en: 'Pre-departure clearance (PDC) from {station}, delivered through the airline as in the US; no answer is expected.',
    ru: 'Разрешение на вылет (PDC) от {station} через систему авиакомпании, как в США. Ответ не требуется.',
  },
  ocl: {
    en: 'Oceanic clearance (CLX) from Shanwick via {station}. Reply ROGER on the FMS ATC (CPDLC) page; without a reply within 10 minutes the clearance is cancelled.',
    ru: 'Океаническое разрешение (CLX) от Shanwick через {station}. Ответьте ROGER на странице ATC (CPDLC) в FMS; без ответа за 10 минут разрешение отменяется.',
  },
};

const fill = (t: UiText, station: string): UiText =>
  Object.fromEntries(
    Object.entries(t).map(([lang, text]) => [lang, text?.replace('{station}', station)]),
  ) as UiText;

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
      if (m.kind === 'cpdlc') return m.cpdlc?.ra === 'WU' ? fill(ATC_HINTS.dcl, m.from) : null;
      return /^UNABLE\b/.test(m.message.text) ? null : fill(ATC_HINTS.pdc, m.from);
    }
    if (m.scenarioId === OCL_ID) {
      return /^CLX\b/.test(m.message.text) ? fill(ATC_HINTS.ocl, m.from) : null;
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
