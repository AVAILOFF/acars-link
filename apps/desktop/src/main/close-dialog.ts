// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { translator } from '../renderer/src/i18n.js';
import type { Language } from '../shared/api.js';

/**
 * The question before the window closes during a flight (T56 U-03). With its recording written the
 * flight is offered to go on at the next start (T64); without it, it is lost. Texts of the main
 * process: the UI strings of `i18n.ts` (`close.*`, T86; a missing language = English). Button 0 closes, button 1 (default, Esc) keeps the flight.
 */
export interface CloseDialog {
  readonly type: 'warning';
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  readonly buttons: [string, string];
  readonly defaultId: 1;
  readonly cancelId: 1;
  readonly noLink: true;
}

export const CLOSE_BUTTON = 0;

export function closeDialog(lang: Language, resumable: boolean): CloseDialog {
  const t = translator(lang);
  return {
    type: 'warning',
    title: t('app.title'),
    message: t('close.message'),
    buttons: [t('close.close'), t('close.continue')],
    detail: t(resumable ? 'close.resume' : 'close.lost'),
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
}
