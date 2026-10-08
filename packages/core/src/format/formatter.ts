import type { DisplayProfile } from './profile.js';

/**
 * Telex formatter (CLAUDE.md, invariant 9): every outbound message goes through
 * {@link formatMessage}. Uppercase, character filter, word wrap to the profile width,
 * header/footer separators, pages.
 *
 * Layout:
 * ```
 * HEADER
 * ------------------------   dashes after the header
 * BODY …
 * ........................   dots before the footer
 * FOOTER
 * ```
 * A body line made only of `-`, `.`, `=` or `*` (≥ 3) is a separator and is drawn
 * across the full width.
 */

export interface MessageBlocks {
  readonly header?: string;
  readonly body: string;
  readonly footer?: string;
}

declare const formatted: unique symbol;

export interface FormattedMessage {
  /** Brand: only {@link formatMessage} produces this type; transports accept nothing else. */
  readonly [formatted]: true;
  readonly profileId: string;
  /** All lines, every one ≤ `lineWidth`, only allowed characters. */
  readonly lines: readonly string[];
  /** `lines` split by `maxLines` (one page without it). */
  readonly pages: readonly (readonly string[])[];
  /** Pages joined with `\n` (and the profile `pageBreak` line between pages). */
  readonly text: string;
  /** Characters removed because the display cannot show them (unique, in order). */
  readonly dropped: readonly string[];
}

export class FormatError extends Error {
  override readonly name = 'FormatError';
}

/** Plain-ASCII stand-ins tried before a character is dropped. */
const REPLACEMENTS: Readonly<Record<string, string>> = {
  '\t': ' ',
  ' ': ' ',
  '"': "'",
  '‘': "'",
  '’': "'",
  '“': "'",
  '”': "'",
  '`': "'",
  '‐': '-',
  '‑': '-',
  '‒': '-',
  '–': '-',
  '—': '-',
  '−': '-',
  _: '-',
  '~': '-',
  '…': '...',
  '[': '(',
  ']': ')',
  '{': '(',
  '}': ')',
  '<': '(',
  '>': ')',
  '|': '/',
  '\\': '/',
  '×': 'X',
  '°': ' DEG',
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '→': '-',
  '←': '-',
};

const SEPARATOR = /^\s*([-.=*])\1{2,}\s*$/;
/** Combining marks left by NFD (é → e + ◌́). */
const COMBINING = /[̀-ͯ]/g;

function sanitizeLine(line: string, p: DisplayProfile, dropped: Set<string>): string {
  const text = p.uppercase ? line.toUpperCase() : line;
  const allowed = (c: string) => p.allowedChars.includes(c);
  let out = '';
  for (const c of text) {
    if (allowed(c)) {
      out += c;
      continue;
    }
    const sub = REPLACEMENTS[c] ?? c.normalize('NFD').replace(COMBINING, '');
    const subText = p.uppercase ? sub.toUpperCase() : sub;
    if (subText !== '' && subText !== c && [...subText].every(allowed)) out += subText;
    else dropped.add(c);
  }
  return out.trimEnd();
}

/**
 * The latest place in `line[0..width]` to wrap: at a space (dropped) or after a `/` or
 * `-` inside a token (routes, RCTP-RJBB, 21-31-01). Null → hard cut.
 */
function breakAt(line: string, width: number): { cut: number; skip: number } | null {
  for (let i = width; i > 0; i--) {
    if (line[i] === ' ' && line.slice(0, i).trim() !== '') return { cut: i, skip: 1 };
    const prev = line[i - 1];
    if ((prev === '/' || prev === '-') && i >= 2 && line[i - 2] !== ' ') return { cut: i, skip: 0 };
  }
  return null;
}

function wrap(line: string, width: number): string[] {
  const out: string[] = [];
  let rest = line;
  while (rest.length > width) {
    const b = breakAt(rest, width);
    const cut = b?.cut ?? width;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut + (b?.skip ?? 0)).trimStart();
  }
  out.push(rest);
  return out;
}

function block(
  text: string | undefined,
  p: DisplayProfile,
  dropped: Set<string>,
  separators: boolean,
): string[] {
  if (text === undefined) return [];
  const lines: string[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const sep = separators ? SEPARATOR.exec(raw) : null;
    if (sep !== null && p.allowedChars.includes(sep[1] as string)) {
      lines.push((sep[1] as string).repeat(p.lineWidth));
      continue;
    }
    lines.push(...wrap(sanitizeLine(raw, p, dropped), p.lineWidth));
  }
  // Drop leading/trailing blank lines and collapse runs of blank lines.
  const compact = lines.filter((l, i) => l !== '' || (i > 0 && lines[i - 1] !== ''));
  while (compact.at(-1) === '') compact.pop();
  return compact;
}

function fit(line: string, width: number): string {
  if (line.length >= width) return line.slice(0, width);
  return line.repeat(Math.ceil(width / line.length)).slice(0, width);
}

export function formatMessage(input: string | MessageBlocks, p: DisplayProfile): FormattedMessage {
  const m: MessageBlocks = typeof input === 'string' ? { body: input } : input;
  const dropped = new Set<string>();
  const header = block(m.header, p, dropped, false);
  const body = block(m.body, p, dropped, true);
  const footer = block(m.footer, p, dropped, false);
  if (body.length === 0) throw new FormatError('message body is empty after formatting');

  const lines = [
    ...header,
    ...(header.length > 0 ? ['-'.repeat(p.lineWidth)] : []),
    ...body,
    ...(footer.length > 0 ? ['.'.repeat(p.lineWidth), ...footer] : []),
  ];

  const pages: string[][] = [];
  const per = p.maxLines ?? lines.length;
  for (let i = 0; i < lines.length; i += per) pages.push(lines.slice(i, i + per));
  const pageBreak = p.pageBreak === undefined ? null : fit(p.pageBreak, p.lineWidth);
  const text = pages
    .map((page) => page.join('\n'))
    .join(pageBreak === null ? '\n' : `\n${pageBreak}\n`);

  const issues = checkText(text, p);
  if (issues.length > 0) throw new FormatError(`formatter bug: ${issues.join('; ')}`);

  return {
    profileId: p.id,
    lines,
    pages,
    text,
    dropped: [...dropped],
  } as unknown as FormattedMessage;
}

/**
 * Problems of already-formatted text against a profile: too long lines, characters the
 * display can't show. Empty = OK. For content validation (docs/05) and self-checks.
 */
export function checkText(text: string, p: DisplayProfile): string[] {
  const issues: string[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.length > p.lineWidth) {
      issues.push(`line ${i + 1} has ${line.length} > ${p.lineWidth} chars`);
    }
    const bad = [...new Set([...line].filter((c) => !p.allowedChars.includes(c)))];
    if (bad.length > 0) issues.push(`line ${i + 1} has disallowed ${JSON.stringify(bad.join(''))}`);
  });
  return issues;
}
