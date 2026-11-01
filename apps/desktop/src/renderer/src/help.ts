// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { Language } from '../../shared/api.js';
import { de } from './help-de.js';
import { en } from './help-en.js';
import { es } from './help-es.js';
import { fr } from './help-fr.js';
import { ja } from './help-ja.js';
import { ru } from './help-ru.js';

/**
 * The "Help" tab: a short manual and FAQ, one file per language (`help-<lang>.ts`, T85; a language
 * without one shows English). Names of buttons and settings are quoted as the
 * UI shows them (i18n.ts); keep them in step when those strings change.
 */

/** A paragraph, a list, or an external https link (opened in the browser by the main process). */
export type HelpBlock =
  | string
  | { readonly list: readonly string[]; readonly ordered?: boolean }
  | { readonly link: string; readonly href: string };

export interface HelpItem {
  readonly id: string;
  readonly q: string;
  readonly a: readonly HelpBlock[];
}

export interface HelpSection {
  readonly id: string;
  readonly title: string;
  readonly items: readonly HelpItem[];
}

export const HELP: { readonly en: readonly HelpSection[] } & Readonly<
  Partial<Record<Language, readonly HelpSection[]>>
> = { en, ru, de, fr, es, ja };

/** The help in `lang`, English when there is none (T85). */
export const helpFor = (lang: Language): readonly HelpSection[] => HELP[lang] ?? HELP.en;

/** The text of a block, for the search box. */
function blockText(b: HelpBlock): string {
  if (typeof b === 'string') return b;
  return 'list' in b ? b.list.join(' ') : b.link;
}

/**
 * Text as the search compares it: NFKC (full-width ＯＦＰ and half-width ｶﾅ as the help writes them, T87) and
 * lower case. Matching is by substring, so Japanese without spaces between words is found too.
 */
const fold = (s: string): string => s.normalize('NFKC').toLowerCase();

/** Sections with only the items whose question or answer contains the query; empty sections go. */
export function searchHelp(sections: readonly HelpSection[], query: string): HelpSection[] {
  const q = fold(query.trim());
  return sections
    .map((s) => ({
      ...s,
      items:
        q === ''
          ? s.items
          : s.items.filter((i) => fold([i.q, ...i.a.map(blockText)].join(' ')).includes(q)),
    }))
    .filter((s) => s.items.length > 0);
}
