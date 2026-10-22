import type { Language } from '../shared/api.js';

/**
 * The question before the window closes during a flight (T56 U-03): the flight lives in memory
 * only and cannot be continued after a restart. Texts of the main process, EN + RU like `i18n.ts`.
 * Button 0 closes, button 1 (default, Esc) keeps the flight.
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
  Record<Language, Omit<CloseDialog, 'type' | 'defaultId' | 'cancelId' | 'noLink'>>
> = {
  en: {
    title: 'ACARS Sim',
    message: 'A flight is running. Close the app?',
    detail:
      'The flight cannot be continued after a restart, and messages not sent yet are dropped.',
    buttons: ['Close the app', 'Keep the flight'],
  },
  ru: {
    title: 'ACARS Sim',
    message: 'Идёт рейс. Закрыть приложение?',
    detail: 'После перезапуска рейс не продолжить, неотправленные сообщения будут отброшены.',
    buttons: ['Закрыть приложение', 'Продолжить рейс'],
  },
};

export function closeDialog(lang: Language): CloseDialog {
  return { type: 'warning', ...TEXTS[lang], defaultId: 1, cancelId: 1, noLink: true };
}
