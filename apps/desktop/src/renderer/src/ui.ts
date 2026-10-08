import { useMemo } from 'react';
import type { UiText } from '../../shared/api.js';
import { type Translate, translator } from './i18n.js';
import { useStore } from './store.js';

/** Picks a scenario text (title, description) in the UI language; English when not translated. */
export function useUiText(): (text: UiText) => string {
  const lang = useStore((s) => s.settings?.language ?? 'en');
  return (text) => (lang === 'ru' ? (text.ru ?? text.en) : text.en);
}

export function useT(): Translate {
  const lang = useStore((s) => s.settings?.language ?? 'en');
  return useMemo(() => translator(lang), [lang]);
}

/** `1432Z`, the way airline documents write times. */
export function zulu(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}${p(d.getUTCMinutes())}Z`;
}

export const num = (n: number): string => Math.round(n).toLocaleString('en-US');
