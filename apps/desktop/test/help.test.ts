// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { describe, expect, it } from 'vitest';
import { HELP, type HelpSection, helpFor, searchHelp } from '../src/renderer/src/help.js';
import { MESSAGES } from '../src/renderer/src/i18n.js';
import type { Language } from '../src/shared/api.js';

/** T85: every language that has a help file (`help-<lang>.ts`). */
const LANGS = Object.entries(HELP).flatMap(([lang, sections]) =>
  sections === undefined ? [] : [{ lang, sections }],
);

describe('Help tab', () => {
  it('has the same sections, questions and blocks in every language (T85)', () => {
    const shape = (sections: readonly HelpSection[]) =>
      sections.map((s) => [s.id, s.items.map((i) => [i.id, i.a.length])]);
    expect(LANGS.map((l) => l.lang)).toEqual(expect.arrayContaining(['en', 'ru']));
    for (const l of LANGS) expect(shape(l.sections), l.lang).toEqual(shape(HELP.en));
  });

  it('a language without a help file shows English (T85)', () => {
    expect(helpFor('ru')).toBe(HELP.ru);
    expect(helpFor('xx' as Language)).toBe(HELP.en);
  });

  it('links only to https', () => {
    for (const s of LANGS.flatMap((l) => l.sections)) {
      for (const i of s.items) {
        for (const b of i.a) {
          if (typeof b !== 'string' && 'link' in b) expect(b.href).toMatch(/^https:\/\//);
        }
      }
    }
  });

  it('search keeps matching questions and drops empty sections', () => {
    const found = searchHelp(HELP.en, 'f-pln request');
    expect(found.length).toBeGreaterThan(0);
    for (const s of found) expect(s.items.length).toBeGreaterThan(0);
    expect(found.flatMap((s) => s.items.map((i) => i.id))).toContain('inibuilds');
    expect(searchHelp(helpFor('ru'), 'zzzz')).toEqual([]);
    expect(searchHelp(helpFor('ru'), '  ')).toHaveLength(helpFor('ru').length);
  });
});

/** The texts of a help, in order: titles, questions, paragraphs, list lines, link texts. */
const texts = (sections: readonly HelpSection[]): string[] =>
  sections.flatMap((s) => [
    s.title,
    ...s.items.flatMap((i) => [
      i.q,
      ...i.a.flatMap((b) => (typeof b === 'string' ? [b] : 'list' in b ? b.list : [b.link])),
    ]),
  ]);

describe('Help quotes the UI (T86)', () => {
  const english = new Map<string, string>();
  for (const [k, v] of Object.entries(MESSAGES.en)) if (!english.has(v)) english.set(v, k);

  it('a label quoted in the English help that is a UI string appears in that language’s help as its UI string', () => {
    let checked = 0;
    for (const { lang, sections } of LANGS.filter((l) => l.lang !== 'en')) {
      const own = MESSAGES[lang as Language] as Readonly<Record<string, string | undefined>>;
      const theirs = texts(sections);
      for (const [n, text] of texts(HELP.en).entries()) {
        for (const m of text.matchAll(/“([^”]+)”/g)) {
          const key = english.get(m[1] ?? '');
          const label = key === undefined ? undefined : own[key];
          if (label === undefined || lang === 'ru') continue; // ru: written by hand before T86
          expect(theirs[n], `${lang}: “${m[1]}”`).toContain(label);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('Help search in Japanese (T87)', () => {
  const ids = (q: string) => searchHelp(helpFor('ja'), q).flatMap((s) => s.items.map((i) => i.id));

  it('finds a word inside text without spaces', () => {
    expect(ids('初飛行')).toContain('first');
    expect(ids('返信')).toContain('reply');
  });

  it('full-width Latin and half-width kana match the help text (NFKC)', () => {
    expect(ids('ＯＦＰ')).toEqual(ids('OFP'));
    expect(ids('ＯＦＰ').length).toBeGreaterThan(0);
    expect(ids('ﾒｯｾｰｼﾞ')).toEqual(ids('メッセージ'));
  });
});
