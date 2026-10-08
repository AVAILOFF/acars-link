/**
 * How a cockpit display shows a telex (docs/03-architecture.md "Профили дисплеев").
 *
 * Widths of real add-ons are unknown and are collected by "Проверка человеком" (T15).
 * The original only distinguishes a base width, B77x (+3) and B78x (+6).
 */
export interface DisplayProfile {
  readonly id: string;
  /** ICAO type designators; a trailing `*` matches a prefix (`B77*` → B772, B77W …). */
  readonly matchIcao: readonly string[];
  /** Case-insensitive regex source tested against the sim `TITLE`. */
  readonly matchTitleRegex?: string;
  /** Characters per line. */
  readonly lineWidth: number;
  /** Lines per page; longer messages are split into pages. */
  readonly maxLines?: number;
  readonly uppercase: boolean;
  /** Every character the display can show (space included). */
  readonly allowedChars: string;
  /** Line inserted between pages in the joined text; repeated/cut to the width. */
  readonly pageBreak?: string;
}

/**
 * Safe default set: A–Z, 0–9, space and plain punctuation. No `{}` (Hoppie packet
 * delimiters in poll replies), no quotes, backslash, `<>`, `|`, `_`, `~`, `^`, `$`.
 */
export const DEFAULT_ALLOWED_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:;/-+()'?!=%#*&@";

/** `[ПРОВЕРИТЬ]` base width: 24 = MCDU/CDU columns; the original's base value is unknown. */
export const BASE_LINE_WIDTH = 24;

export const DEFAULT_PROFILE: DisplayProfile = {
  id: 'default',
  matchIcao: [],
  lineWidth: BASE_LINE_WIDTH,
  uppercase: true,
  allowedChars: DEFAULT_ALLOWED_CHARS,
};

/** Boeing 777 family: base + 3 (as in the original). */
export const B77X_PROFILE: DisplayProfile = {
  id: 'b77x',
  matchIcao: ['B77*'],
  matchTitleRegex: '\\b(B?777|777X)',
  lineWidth: BASE_LINE_WIDTH + 3,
  uppercase: true,
  allowedChars: DEFAULT_ALLOWED_CHARS,
};

/** Boeing 787 family: base + 6 (as in the original). */
export const B78X_PROFILE: DisplayProfile = {
  id: 'b78x',
  matchIcao: ['B78*'],
  matchTitleRegex: '\\b(B?787)',
  lineWidth: BASE_LINE_WIDTH + 6,
  uppercase: true,
  allowedChars: DEFAULT_ALLOWED_CHARS,
};

export const BUILTIN_PROFILES: readonly DisplayProfile[] = [B77X_PROFILE, B78X_PROFILE];

export class DisplayProfileError extends Error {
  override readonly name = 'DisplayProfileError';
}

/** Throws {@link DisplayProfileError} on a profile the formatter cannot honour. */
export function validateProfile(p: DisplayProfile): DisplayProfile {
  const fail = (why: string) => {
    throw new DisplayProfileError(`display profile "${p.id}": ${why}`);
  };
  if (p.id.trim() === '') fail('empty id');
  if (!Number.isInteger(p.lineWidth) || p.lineWidth < 10 || p.lineWidth > 80) {
    fail(`lineWidth must be an integer 10..80, got ${p.lineWidth}`);
  }
  if (p.maxLines !== undefined && (!Number.isInteger(p.maxLines) || p.maxLines < 2)) {
    fail(`maxLines must be an integer ≥ 2, got ${p.maxLines}`);
  }
  if (!p.allowedChars.includes(' ')) fail('allowedChars must include a space');
  for (const c of '-.') if (!p.allowedChars.includes(c)) fail(`allowedChars must include "${c}"`);
  if (p.uppercase && /[a-z]/.test(p.allowedChars)) fail('uppercase profile allows lowercase');
  if (p.matchTitleRegex !== undefined) {
    try {
      new RegExp(p.matchTitleRegex, 'i');
    } catch {
      fail(`bad matchTitleRegex ${p.matchTitleRegex}`);
    }
  }
  if (p.pageBreak !== undefined) {
    if (p.pageBreak === '') fail('empty pageBreak');
    for (const c of p.pageBreak) if (!p.allowedChars.includes(c)) fail(`pageBreak char "${c}"`);
  }
  return p;
}

export interface AircraftIdentity {
  /** ICAO type designator from the OFP, e.g. `B77W`. */
  readonly icao?: string | null;
  /** Sim `TITLE`. */
  readonly title?: string | null;
}

const icaoMatches = (pattern: string, icao: string): boolean => {
  const p = pattern.toUpperCase();
  return p.endsWith('*') ? icao.startsWith(p.slice(0, -1)) : icao === p;
};

/**
 * First profile (in order) whose ICAO pattern or title regex matches; otherwise
 * `fallback`. Put user/add-on profiles first so they override the built-ins.
 */
export function selectProfile(
  aircraft: AircraftIdentity,
  profiles: readonly DisplayProfile[] = BUILTIN_PROFILES,
  fallback: DisplayProfile = DEFAULT_PROFILE,
): DisplayProfile {
  const icao = aircraft.icao?.trim().toUpperCase() ?? '';
  const title = aircraft.title ?? '';
  for (const p of profiles) {
    if (icao !== '' && p.matchIcao.some((m) => icaoMatches(m, icao))) return p;
    if (title !== '' && p.matchTitleRegex !== undefined) {
      if (new RegExp(p.matchTitleRegex, 'i').test(title)) return p;
    }
  }
  return fallback;
}
