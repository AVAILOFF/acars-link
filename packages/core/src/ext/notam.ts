// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { Ofp, OfpNotam } from '../ofp/types.js';

/**
 * Company NOTAM summary (T95): the NOTAM SimBrief put into the OFP that matter for the arrival,
 * picked by their Q-code. Decode of the code: FAA JO 7930.2U, appendix B "International NOTAM (Q)
 * Codes" (https://www.faa.gov/air_traffic/publications/atpubs/Notam_html/appendix_b.html, a work
 * of the US government, public domain; checked 2026-11-07): letters 2–3 the subject, 4–5 its
 * condition. Only the codes are taken, no text.
 *
 * Approved by the user 2026-11-07: the subjects below in this order of importance; taxiways and
 * their lights (`MX`, `LX`, `LY`), obstacles (`OB`, `OL`), warnings (`W…`) and the rest are left
 * out; so are the conditions "back to normal" ({@link NORMAL_CONDITIONS}) and NOTAM without a
 * Q-code (Д2). The schedule (item D) is not parsed: it is shown as it is (Д3). Window ETA ± 1 h
 * (Д4), at most {@link NOTAM_MAX_ITEMS} per airport, the text cut to {@link NOTAM_TEXT_MAX}.
 */
export const NOTAM_SUBJECT_GROUPS: readonly (readonly string[])[] = [
  // Aerodrome
  ['FA'],
  // Runway, threshold, declared distances
  ['MR', 'MT', 'MD'],
  // ILS and its parts and categories, GNSS airfield operations
  ['IC', 'IG', 'IL', 'ID', 'IS', 'IT', 'IU', 'GA'],
  // Instrument approach, missed approach, operating minima, STAR
  ['PI', 'PU', 'PM', 'PA'],
  // Approach and runway lighting, PAPI / VASIS
  ['LA', 'LP', 'LV', 'LR', 'LE', 'LC', 'LZ', 'LH'],
  // Apron, aircraft stands, parking area
  ['MN', 'MP', 'MK'],
];

/**
 * Conditions that report a return to normal: resumed normal operations (`AK`), operational
 * (`AO`), flight checked and found reliable (`AF`), completed (`CC`), work completed (`HV`),
 * canceled (`CN`), promulgated shutdown canceled (`AX`).
 */
export const NORMAL_CONDITIONS: ReadonlySet<string> = new Set([
  'AK',
  'AO',
  'AF',
  'CC',
  'HV',
  'CN',
  'AX',
]);

/** Minutes either side of the ETA a NOTAM must overlap (Д4, game number). */
export const NOTAM_WINDOW_MIN = 60;
/** Items per airport (decision 3). */
export const NOTAM_MAX_ITEMS = 5;
/** Text of an item: two lines of the base display width (24). */
export const NOTAM_TEXT_MAX = 48;

/** Importance of a NOTAM: index of its subject group, null = not for the summary. */
export function notamRank(n: OfpNotam): number | null {
  if (n.qcode === null) return null;
  const subject = n.qcode.slice(1, 3);
  const condition = n.qcode.slice(3, 5);
  if (NORMAL_CONDITIONS.has(condition)) return null;
  const rank = NOTAM_SUBJECT_GROUPS.findIndex((g) => g.includes(subject));
  return rank < 0 ? null : rank;
}

/** NOTAM of `icao` for the summary at time `at`: in force within the window, most important first. */
export function selectNotams(
  notams: readonly OfpNotam[] | undefined,
  icao: string,
  at: number,
): OfpNotam[] {
  const from = at - NOTAM_WINDOW_MIN * 60_000;
  const to = at + NOTAM_WINDOW_MIN * 60_000;
  return (notams ?? [])
    .flatMap((n, i) => {
      if (n.icao !== icao || n.startMs > to || (n.endMs !== null && n.endMs < from)) return [];
      const rank = notamRank(n);
      return rank === null ? [] : [{ n, rank, i }];
    })
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .slice(0, NOTAM_MAX_ITEMS)
    .map((x) => x.n);
}

/** The words of `text` that fit in `max` characters (one long word is cut). */
export function clipWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(' ', max);
  return (cut > 0 ? text.slice(0, cut) : text.slice(0, max)).trimEnd();
}

/** `DDHHMM` UTC, as item C of a NOTAM gives the day and time. */
function ddhhmm(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}

/** Lines of one item: id and validity, the text, the schedule. */
export function notamLines(n: OfpNotam): string[] {
  const until =
    n.endMs === null ? 'PERM' : `TIL ${ddhhmm(n.endMs)}Z${n.endEstimated ? ' EST' : ''}`;
  const lines = [`${n.id} ${until}`, clipWords(n.text, NOTAM_TEXT_MAX)];
  if (n.schedule !== null) lines.push(clipWords(`SKED ${n.schedule}`, NOTAM_TEXT_MAX));
  return lines.filter((l) => l !== '');
}

/** Said of an airport without NOTAM for the summary. */
export const NOTAM_NIL = 'NIL SIGNIFICANT';

/** The items one after another, or {@link NOTAM_NIL}. */
export function notamText(list: readonly OfpNotam[]): string {
  return list.length === 0 ? NOTAM_NIL : list.flatMap(notamLines).join('\n');
}

/**
 * Time the NOTAM of `icao` are picked for: the departure (estimated OUT with the delay) for the
 * origin before take-off, else the ETA — take-off plus the planned time en route, or the planned
 * landing moved by the delay before take-off.
 */
export function notamTime(ofp: Ofp, icao: string, offMs: number | null, delayMs: number): number {
  const t = ofp.times;
  if (icao === ofp.origin.icao && icao !== ofp.destination.icao && offMs === null) {
    return t.estOutMs + delayMs;
  }
  if (offMs !== null) return offMs + t.estTimeEnrouteSec * 1000;
  return (t.estOnMs ?? t.estInMs) + delayMs;
}
