import {
  type AwaitedReply,
  type CompiledScenario,
  DCL_ID,
  type HintText,
  OCL_ID,
  type OutboundMessage,
} from '@acars/core';
import type { UiText } from '../shared/api.js';

/**
 * Hints to messages in the app (T57): what a message means and what each answer of a waiting
 * `wait: reply` means. Static texts from the scenario files (`hint`, `reply_hints`) and, for the
 * XATC departure and oceanic clearances, below. UI only: nothing here goes to the network.
 */

/** How to confirm the clearances of the XATC station (T24, T27; facts of `dcl.ts`, `oceanic.ts`). */
const ATC_HINTS = {
  dcl: {
    en: 'Departure clearance (CLD) from {station} over CPDLC. Check it and confirm with WILCO on the ATC (CPDLC) page of the FMS, or answer UNABLE if you cannot accept it.',
    ru: 'Разрешение на вылет (CLD) от {station} по CPDLC. Проверьте его и подтвердите WILCO на странице ATC (CPDLC) в FMS или ответьте UNABLE, если принять не можете.',
  },
  pdc: {
    en: 'Pre-departure clearance (PDC) from {station}, as US airlines get it through the company. Read it; no answer is expected.',
    ru: 'Разрешение на вылет (PDC) от {station} — так его получают авиакомпании США через свою систему. Прочитайте его; ответ не нужен.',
  },
  ocl: {
    en: 'Oceanic clearance (CLX) from Shanwick through {station}. Acknowledge it with ROGER on the ATC (CPDLC) page of the FMS; without an answer within 10 minutes the clearance is cancelled.',
    ru: 'Океанический клиренс (CLX) от Shanwick через {station}. Подтвердите его ответом ROGER на странице ATC (CPDLC) в FMS; без ответа за 10 минут клиренс отменяется.',
  },
} as const;

const fill = (t: { en: string; ru: string }, station: string): UiText => ({
  en: t.en.replace('{station}', station),
  ru: t.ru.replace('{station}', station),
});

const ui = (h: HintText): UiText => ({ en: h.en, ru: h.ru });

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
    if (step?.kind === 'send' && step.hint !== null) return ui(step.hint);
    return c.def.hint === undefined ? null : { en: c.def.hint, ru: c.def.hint_ru ?? null };
  }

  /** What each option of a waiting answer means; null = the scenario has no `reply_hints`. */
  forReply(r: AwaitedReply): Readonly<Record<string, UiText>> | null {
    const step = r.step === null ? undefined : this.byId.get(r.scenarioId)?.steps[r.step];
    if (step?.kind !== 'wait_reply' || step.hints === null) return null;
    const out: Record<string, UiText> = {};
    for (const [o, h] of Object.entries(step.hints)) out[o] = ui(h);
    return out;
  }
}
