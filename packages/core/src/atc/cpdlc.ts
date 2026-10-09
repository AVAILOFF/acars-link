import { type FormattedMessage, formatMessage } from '../format/formatter.js';
import type { DisplayProfile } from '../format/profile.js';

/**
 * Hoppie CPDLC packets (T23, docs/06 "CPDLC через Hoppie"). Hoppie carries CPDLC as free
 * text in a `cpdlc` message whose packet is `/data2/<min>/<mrn>/<ra>/<text>`:
 * - `min` — message identification number, counted by the sender;
 * - `mrn` — the `min` of the message this one answers, empty for an opening message;
 * - `ra` — response attribute: `WU` (WILCO/UNABLE), `AN` (AFFIRM/NEGATIVE), `R` (ROGER),
 *   `NE` (no response, not enabled), `Y` (response required), `N` (no response);
 * - `text` — `@` marks a value the display may highlight, `@_@` separates parts of a line
 *   ("CURRENT ATC UNIT@_@EDGG@_@LANGEN CTL").
 * Sources (checked 2026-10-09): FlyByWire A32NX `AcarsConnector.ts` / `CpdlcMessage.ts`
 * (GPL-3.0, format only, no code taken), packets captured on the network in the YV E-Jet
 * `hoppie-driver.nas` and in `hoppie-standalone` (MIT). FBW reads the text as the sixth
 * `/`-separated field only, so an uplink text must not contain `/` (see {@link CPDLC_PROFILE}).
 */

export type CpdlcResponse = 'WU' | 'AN' | 'R' | 'NE' | 'Y' | 'N';

const RESPONSES: readonly CpdlcResponse[] = ['WU', 'AN', 'R', 'NE', 'Y', 'N'];

export interface CpdlcHeader {
  readonly min: number;
  /** The answered message's `min`; null for an opening message. */
  readonly mrn: number | null;
  readonly ra: CpdlcResponse;
}

export interface CpdlcPacket extends CpdlcHeader {
  /** Upper case, `@` markers and `@_@` separators turned into single spaces. */
  readonly text: string;
}

/**
 * Characters of an uplink: A–Z, 0–9, space, `@` and `_` (markers), plain punctuation. No `/`
 * (packet separator), no `{}` (Hoppie poll delimiters). One logical line: the aircraft
 * wraps it, so the width is only the formatter's limit (lines are joined with spaces).
 */
export const CPDLC_PROFILE: DisplayProfile = {
  id: 'cpdlc',
  matchIcao: [],
  lineWidth: 80,
  uppercase: true,
  allowedChars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:-+()?@_',
};

/** Formats the text of an uplink (CLAUDE.md, invariant 9). */
export function formatCpdlc(text: string): FormattedMessage {
  return formatMessage(text, CPDLC_PROFILE);
}

/** The `/data2/` packet of an uplink: the formatted lines joined back into one line. */
export function cpdlcPacket(h: CpdlcHeader, message: FormattedMessage): string {
  if (message.profileId !== CPDLC_PROFILE.id) {
    throw new TypeError(`CPDLC text must be formatted with the ${CPDLC_PROFILE.id} profile`);
  }
  return `/data2/${h.min}/${h.mrn ?? ''}/${h.ra}/${message.lines.join(' ')}`;
}

/** Normalized text of a CPDLC message, for matching. */
export function cpdlcText(text: string): string {
  return text.toUpperCase().replaceAll('@_@', ' ').replaceAll('@', ' ').replace(/\s+/g, ' ').trim();
}

/** Parses a received packet; null when it is not `/data2/…`. A `/` in the text is kept. */
export function parseCpdlc(packet: string): CpdlcPacket | null {
  const m = /^\s*\/data2\/(\d+)\/(\d*)\/([A-Za-z]{1,2})\/([\s\S]*)$/i.exec(packet);
  if (m === null) return null;
  const ra = (m[3] as string).toUpperCase() as CpdlcResponse;
  if (!RESPONSES.includes(ra)) return null;
  return {
    min: Number(m[1]),
    mrn: m[2] === '' ? null : Number(m[2]),
    ra,
    text: cpdlcText(m[4] as string),
  };
}
