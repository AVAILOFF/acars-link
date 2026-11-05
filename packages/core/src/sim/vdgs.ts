// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

/**
 * GSX VDGS text (T22). Source: FSDreamTeam "VGDS Custom Messages System" developer manual,
 * 2025-07-29, shipped with GSX Pro in `couatl\GSX\SDK\Samples\VGDS\vgds_developer_manual.pdf`
 * (checked 2026-10-09; docs/06 "GSX VDGS"). The app writes the message to GSX's custom
 * message folder; this module only decides the text, deterministically.
 *
 * Limits per display type ("Display Types & Specifications"): small (SafeDock3) 4 characters,
 * 5 lines of which 2 are usable while parked; narrow (SafeDock TS24) 6×6; wide (SafeDock TS42)
 * 9×7; x (SafeDock X) 10×7. The manual's own examples exceed them; we keep to the table.
 * The last line of narrow, wide and x is GSX's own scrolling line ("VGDS Message Editor User
 * Manual", shipped with GSX Pro in `couatl\GSX\VGDS_EDITOR_USER_MANUAL.pdf`, "Reserved Lines";
 * checked 2026-11-05), so a message gets one line less: narrow 5, wide 6, x 6.
 *
 * Approved assumptions (user, 2026-10-09; docs/07 T22):
 * - characters: A–Z 0–9 space and `- / . :` only (the manual names no character set);
 * - `narrow` is required; `wide` and `x` fall back to the narrow lines, `small` is only shown
 *   when the scenario gives it;
 * - a line that does not fit is an error, never shortened.
 */

export const VDGS_DISPLAYS = {
  small: { chars: 4, lines: 2 },
  narrow: { chars: 6, lines: 5 },
  wide: { chars: 9, lines: 6 },
  x: { chars: 10, lines: 6 },
} as const;
export type VdgsDisplay = keyof typeof VDGS_DISPLAYS;
export const VDGS_DISPLAY_NAMES = Object.keys(VDGS_DISPLAYS) as readonly VdgsDisplay[];

/** Default and allowed page duration, seconds (the manual recommends 6 s). */
export const VDGS_DURATION = { default: 6, min: 1, max: 60 } as const;

export const VDGS_CHARS_RE = /^[A-Z0-9 \-/.:]*$/;

export interface VdgsLine {
  readonly text: string;
  readonly red: boolean;
}

export interface VdgsMessage {
  /** ICAO of the airport the message is for (the arrival airport, or the diversion). */
  readonly airport: string;
  readonly durationMs: number;
  /** Lines for each display type; `narrow`, `wide` and `x` are always present. */
  readonly displays: Readonly<Partial<Record<VdgsDisplay, readonly VdgsLine[]>>>;
}

/** Null when the lines fit `display`, else why not. Text must already be uppercase. */
export function checkVdgsLines(display: VdgsDisplay, lines: readonly VdgsLine[]): string | null {
  const lim = VDGS_DISPLAYS[display];
  if (lines.length === 0) return `${display}: no lines`;
  if (lines.length > lim.lines) return `${display}: ${lines.length} lines, max ${lim.lines}`;
  for (const l of lines) {
    if (!VDGS_CHARS_RE.test(l.text)) {
      return `${display}: "${l.text}" has characters other than A-Z 0-9 space - / . :`;
    }
    if (l.text.length > lim.chars) {
      return `${display}: "${l.text}" is ${l.text.length} characters, max ${lim.chars}`;
    }
  }
  return null;
}

/**
 * Builds the message from the rendered lines of a `vdgs:` step: uppercases and trims each
 * line, checks every display, fills `wide` and `x` from `narrow` when not given.
 * Throws {@link VdgsError} when something does not fit.
 */
export function buildVdgsMessage(
  airport: string,
  durationSec: number,
  given: Readonly<Partial<Record<VdgsDisplay, readonly VdgsLine[]>>>,
): VdgsMessage {
  const norm = (ls: readonly VdgsLine[]) =>
    ls.map((l) => ({ text: l.text.trim().toUpperCase(), red: l.red }));
  const narrow = given.narrow;
  if (narrow === undefined) throw new VdgsError('narrow lines are required');
  const displays: Partial<Record<VdgsDisplay, readonly VdgsLine[]>> = {};
  for (const d of VDGS_DISPLAY_NAMES) {
    const src = given[d] ?? (d === 'wide' || d === 'x' ? narrow : undefined);
    if (src === undefined) continue;
    const lines = norm(src);
    const why = checkVdgsLines(d, lines);
    if (why !== null) throw new VdgsError(why);
    displays[d] = lines;
  }
  return { airport, durationMs: Math.round(durationSec * 1000), displays };
}

export class VdgsError extends Error {
  override readonly name = 'VdgsError';
}
