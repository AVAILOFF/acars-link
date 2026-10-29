// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { Language } from '../shared/api.js';

/**
 * The question before the window closes during a flight (T56 U-03). With its recording written the
 * flight is offered to go on at the next start (T64); without it, it is lost. Texts of the main
 * process, EN + RU like `i18n.ts`. Button 0 closes, button 1 (default, Esc) keeps the flight.
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

const TEXTS: Readonly<
  Record<Language, Omit<CloseDialog, 'type' | 'defaultId' | 'cancelId' | 'noLink' | 'detail'>>
> = {
  en: {
    title: 'ACARS Link',
    message: 'A flight is in progress. Close the app?',
    buttons: ['Close app', 'Continue flight'],
  },
  ru: {
    title: 'ACARS Link',
    message: 'Идёт рейс. Закрыть приложение?',
    buttons: ['Закрыть приложение', 'Продолжить рейс'],
  },
};

const DETAIL: Readonly<Record<Language, Readonly<Record<'resume' | 'lost', string>>>> = {
  en: {
    resume:
      'At the next start (within 24 hours) the app offers to continue the flight. Unsent messages are sent then.',
    lost: 'The flight cannot be resumed after a restart: it is not recorded. Unsent messages will be discarded.',
  },
  ru: {
    resume:
      'При следующем запуске (в течение 24 часов) приложение предложит продолжить рейс. Неотправленные сообщения уйдут тогда.',
    lost: 'Рейс не записывается, после перезапуска его не продолжить. Неотправленные сообщения будут отброшены.',
  },
};

export function closeDialog(lang: Language, resumable: boolean): CloseDialog {
  return {
    type: 'warning',
    ...TEXTS[lang],
    detail: DETAIL[lang][resumable ? 'resume' : 'lost'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
}
