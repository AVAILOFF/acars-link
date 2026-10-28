// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { describe, expect, it } from 'vitest';
import {
  B73X_PROFILE,
  B75X_PROFILE,
  B77X_PROFILE,
  B78X_PROFILE,
  BASE_LINE_WIDTH,
  BUILTIN_PROFILES,
  checkText,
  DEFAULT_PROFILE,
  type DisplayProfile,
  DisplayProfileError,
  FormatError,
  formatMessage,
  selectProfile,
  validateProfile,
} from '../src/index.js';

const P = DEFAULT_PROFILE;

describe('formatMessage — text rules', () => {
  it('uppercases and keeps short lines as they are', () => {
    expect(formatMessage('gate b12\nstand 34', P).lines).toEqual(['GATE B12', 'STAND 34']);
  });

  it('wraps on spaces, every line ≤ width', () => {
    const f = formatMessage(
      'please advise your intentions regarding the delayed departure slot',
      P,
    );
    expect(f.lines).toEqual([
      'PLEASE ADVISE YOUR',
      'INTENTIONS REGARDING THE',
      'DELAYED DEPARTURE SLOT',
    ]);
    for (const l of f.lines) expect(l.length).toBeLessThanOrEqual(BASE_LINE_WIDTH);
  });

  it('breaks long tokens after / or -, otherwise hard', () => {
    expect(formatMessage('ROUTE RCTP/ABCDE/FGHIJ/KLMNO/PQRST', P).lines).toEqual([
      'ROUTE RCTP/ABCDE/FGHIJ/',
      'KLMNO/PQRST',
    ]);
    expect(formatMessage('X'.repeat(30), P).lines).toEqual(['X'.repeat(24), 'X'.repeat(6)]);
  });

  it('keeps alignment spaces inside a line, trims line ends', () => {
    expect(formatMessage('ZFW   180.2  MAX 192.0   ', P).lines).toEqual(['ZFW   180.2  MAX 192.0']);
  });

  it('maps typographic characters, strips diacritics, drops the rest and reports it', () => {
    const f = formatMessage('“Crème” — 25°C {ok} привет_A', P);
    expect(f.lines).toEqual(["'CREME' - 25 DEGC (OK)", '-A']);
    expect(f.dropped).toEqual(['П', 'Р', 'И', 'В', 'Е', 'Т']);
  });

  it('never emits Hoppie packet delimiters or quotes', () => {
    const f = formatMessage('a {b} "c" \\d | e', P);
    expect(f.text).not.toMatch(/[{}"\\|]/);
  });

  it('collapses blank lines, trims them at the edges, normalizes CRLF', () => {
    expect(formatMessage('\r\n\r\nA\r\n\r\n\r\nB\n\n', P).lines).toEqual(['A', '', 'B']);
  });

  it('rejects an empty body', () => {
    expect(() => formatMessage('  \n привет ', P)).toThrow(FormatError);
  });
});

describe('formatMessage — blocks and separators', () => {
  it('header + dashes, body, dots + footer', () => {
    const f = formatMessage(
      { header: 'Preliminary loadsheet', body: 'ZFW 180.2\nTOW 245.0', footer: 'prepared by ops' },
      P,
    );
    expect(f.lines).toEqual([
      'PRELIMINARY LOADSHEET',
      '-'.repeat(24),
      'ZFW 180.2',
      'TOW 245.0',
      '.'.repeat(24),
      'PREPARED BY OPS',
    ]);
    expect(f.text).toBe(f.lines.join('\n'));
    expect(f.profileId).toBe('default');
  });

  it('body separator lines are drawn across the width', () => {
    const f = formatMessage('A\n---\nB\n  .....  \nC\n===\n', B78X_PROFILE);
    expect(f.lines).toEqual(['A', '-'.repeat(30), 'B', '.'.repeat(30), 'C', '='.repeat(30)]);
  });

  it('a separator char the profile does not allow is filtered like any text', () => {
    const p: DisplayProfile = { ...P, allowedChars: P.allowedChars.replace('=', '') };
    expect(formatMessage('A\n===\nB', p).lines).toEqual(['A', '', 'B']);
  });

  it('width follows the profile', () => {
    const body = 'THIS IS A LINE OF EXACTLY THIRTY TWO'; // 36 chars
    expect(formatMessage(body, P).lines).toEqual(['THIS IS A LINE OF', 'EXACTLY THIRTY TWO']);
    expect(formatMessage(body, B77X_PROFILE).lines).toEqual([
      'THIS IS A LINE OF EXACTLY',
      'THIRTY TWO',
    ]);
    expect(formatMessage(body, B78X_PROFILE).lines).toEqual([
      'THIS IS A LINE OF EXACTLY',
      'THIRTY TWO',
    ]);
    expect(formatMessage('THIS IS A LINE OF EXACTLY THIR', B78X_PROFILE).lines).toHaveLength(1);
  });

  it('pages by maxLines, joined with the pageBreak line', () => {
    const p: DisplayProfile = { ...P, maxLines: 3, pageBreak: '- ' };
    const f = formatMessage('1\n2\n3\n4\n5', p);
    expect(f.pages).toEqual([
      ['1', '2', '3'],
      ['4', '5'],
    ]);
    expect(f.text).toBe(`1\n2\n3\n${'- '.repeat(12)}\n4\n5`);
    const { pageBreak: _, ...noBreak } = p;
    expect(formatMessage('1\n2\n3\n4', noBreak).text).toBe('1\n2\n3\n4');
  });

  it('lowercase profile keeps case', () => {
    const p: DisplayProfile = {
      ...P,
      id: 'mixed',
      uppercase: false,
      allowedChars: `${P.allowedChars}abcdefghijklmnopqrstuvwxyz`,
    };
    expect(formatMessage('Gate B12', p).lines).toEqual(['Gate B12']);
  });

  it('output always passes checkText', () => {
    const f = formatMessage({ header: 'h'.repeat(50), body: 'é'.repeat(60), footer: '…' }, P);
    expect(checkText(f.text, P)).toEqual([]);
  });
});

describe('checkText', () => {
  it('reports long lines and bad characters', () => {
    expect(checkText(`${'A'.repeat(25)}\nok{}`, P)).toEqual([
      'line 1 has 25 > 24 chars',
      'line 2 has disallowed "ok{}"',
    ]);
  });
});

describe('DisplayProfile', () => {
  it('built-ins: base, B77x = base + 3, B78x = base + 6 (as in the original)', () => {
    expect(DEFAULT_PROFILE.lineWidth).toBe(BASE_LINE_WIDTH);
    expect(B77X_PROFILE.lineWidth).toBe(BASE_LINE_WIDTH + 3);
    expect(B78X_PROFILE.lineWidth).toBe(BASE_LINE_WIDTH + 6);
    for (const p of [DEFAULT_PROFILE, ...BUILTIN_PROFILES]) expect(validateProfile(p)).toBe(p);
  });

  it('selects by OFP ICAO type or by sim title', () => {
    expect(selectProfile({ icao: 'B77W' }).id).toBe('b77x');
    expect(selectProfile({ icao: 'b772' }).id).toBe('b77x');
    expect(selectProfile({ icao: 'B789' }).id).toBe('b78x');
    expect(selectProfile({ icao: 'A35K' }).id).toBe('default');
    expect(selectProfile({ title: 'PMDG 777-300ER Air France' }).id).toBe('b77x');
    expect(selectProfile({ title: 'Boeing 787-10 Asobo' }).id).toBe('b78x');
    expect(selectProfile({ title: 'FlyByWire A320neo' }).id).toBe('default');
    expect(selectProfile({ icao: null, title: null }).id).toBe('default');
  });

  it('B737 NG/MAX: b73x at the base width until the human check (T52)', () => {
    expect(B73X_PROFILE.lineWidth).toBe(BASE_LINE_WIDTH);
    for (const icao of ['B736', 'B737', 'b738', 'B739', 'B37M', 'B38M', 'B39M', 'B3XM']) {
      expect(selectProfile({ icao }).id).toBe('b73x');
    }
    expect(selectProfile({ title: 'PMDG 737-800 Ryanair' }).id).toBe('b73x');
    expect(selectProfile({ title: 'PMDG B737-700' }).id).toBe('b73x');
    expect(selectProfile({ title: 'iFly 737 MAX 8' }).id).toBe('b73x');
    expect(selectProfile({ icao: 'B38M', title: 'iFly 737 MAX 8' }).id).toBe('b73x');
    expect(selectProfile({ icao: 'B77W', title: 'PMDG 777-300ER' }).id).toBe('b77x');
  });

  it('B757: b75x at the base width until the human check (T60)', () => {
    expect(B75X_PROFILE.lineWidth).toBe(BASE_LINE_WIDTH);
    expect(B75X_PROFILE.allowedChars).toBe(DEFAULT_PROFILE.allowedChars);
    for (const icao of ['B752', 'b753']) expect(selectProfile({ icao }).id).toBe('b75x');
    expect(selectProfile({ title: 'BlueBird 757-200' }).id).toBe('b75x');
    expect(selectProfile({ title: 'Bluebird B757-200 RR' }).id).toBe('b75x');
    expect(selectProfile({ icao: 'B752', title: 'BlueBird 757-200 PW' }).id).toBe('b75x');
    expect(selectProfile({ icao: 'B738' }).id).toBe('b73x');
    expect(selectProfile({ title: 'Some 1757 livery' }).id).toBe('default');
  });

  it('earlier (user) profiles override the built-ins', () => {
    const pmdg: DisplayProfile = {
      ...B77X_PROFILE,
      id: 'pmdg-777',
      matchIcao: [],
      matchTitleRegex: '^PMDG 777',
      lineWidth: 26,
    };
    const list = [pmdg, ...BUILTIN_PROFILES];
    expect(selectProfile({ icao: 'B77W', title: 'PMDG 777-300ER' }, list).id).toBe('pmdg-777');
    expect(selectProfile({ icao: 'B77W', title: 'Captain Sim 777' }, list).id).toBe('b77x');
  });

  it('validateProfile rejects broken profiles', () => {
    const bad: Partial<DisplayProfile>[] = [
      { id: ' ' },
      { lineWidth: 5 },
      { lineWidth: 24.5 },
      { maxLines: 1 },
      { allowedChars: 'ABC.-' },
      { allowedChars: `${P.allowedChars}a` },
      { matchTitleRegex: '(' },
      { pageBreak: '{' },
    ];
    for (const b of bad) {
      expect(() => validateProfile({ ...P, ...b })).toThrow(DisplayProfileError);
    }
  });
});
