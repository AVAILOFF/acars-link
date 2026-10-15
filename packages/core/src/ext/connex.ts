import type { Ofp } from '../ofp/types.js';
import { createRng } from '../random/rng.js';

/**
 * Onward flights of the airline from the destination (T30, docs/07 C1–C11): AeroDataBox FIDS
 * departures fetched by the app with the user's key and passed in as `ExtDataUpdate.connex`.
 * The core only selects among them: same airline, a window after the scheduled arrival,
 * operating flight over its codeshare twin, one flight by the seed (C6).
 */

/** One departure of the airline (already filtered by the adapter: airline, no cargo, not cancelled). */
export interface ConnexFlight {
  /** `LH1234` — upper-case A–Z0–9 (an identifier, kept after the purge, C9). */
  readonly number: string;
  /** Airport the flight goes to, ICAO (an identifier, kept after the purge). */
  readonly dest: string;
  /** Scheduled departure, epoch ms UTC; null once purged from an old recording (C9). */
  readonly std: number | null;
  /** Terminal and gate when the source has them; null otherwise or once purged. */
  readonly terminal: string | null;
  readonly gate: string | null;
  /** Marketed by the airline, operated by another (`codeshareStatus: IsCodeshared`). */
  readonly codeshare: boolean;
}

/** Departures of the destination `icao` in the window of C5. */
export interface ConnexData {
  readonly icao: string;
  readonly list: readonly ConnexFlight[];
}

const MIN = 60_000;
/** C5: the window asked for, after the scheduled arrival (STA). */
export const CONNEX_FROM_MIN = 30;
export const CONNEX_TO_MIN = 240;
/** C6: the first choice is among the departures of the first 2 h of the window. */
export const CONNEX_FIRST_MIN = 120;
/** C8: `connex_list` shows at most this many departures. */
export const CONNEX_LIST_MAX = 4;
/** C4: last line of every message with these data (free channel: attribution required). */
export const CONNEX_ATTRIBUTION = 'SRC AERODATABOX';

/**
 * Usable departures in time order: in the window after the STA, with a time (not purged), to
 * another airport; of a codeshare and an operating flight at the same time to the same place
 * only the operating one (C6).
 */
export function connexCandidates(data: ConnexData | null | undefined, ofp: Ofp): ConnexFlight[] {
  if (data === null || data === undefined || data.icao !== ofp.destination.icao) return [];
  const sta = ofp.times.schedInMs;
  const from = sta + CONNEX_FROM_MIN * MIN;
  const to = sta + CONNEX_TO_MIN * MIN;
  const best = new Map<string, ConnexFlight>();
  for (const f of data.list) {
    if (f.std === null || f.std < from || f.std > to || f.dest === ofp.destination.icao) continue;
    const key = `${f.std}/${f.dest}`;
    const had = best.get(key);
    if (had === undefined || (had.codeshare && !f.codeshare)) best.set(key, f);
  }
  return [...best.values()].sort(
    (a, b) =>
      (a.std as number) - (b.std as number) ||
      (a.number < b.number ? -1 : a.number > b.number ? 1 : 0),
  );
}

/**
 * The onward flight of `irr.connect_*` (C6): by the seed among the candidates of the first
 * 2 h of the window, else among all; null when there is none.
 */
export function pickConnection(
  data: ConnexData | null | undefined,
  ofp: Ofp,
  seed: number | string,
): ConnexFlight | null {
  const all = connexCandidates(data, ofp);
  if (all.length === 0) return null;
  const limit = ofp.times.schedInMs + (CONNEX_FROM_MIN + CONNEX_FIRST_MIN) * MIN;
  const first = all.filter((f) => (f.std as number) <= limit);
  return createRng(`${String(seed)}/#connex`).pick(first.length > 0 ? first : all);
}

/** Gate, else the terminal (`TERM 2`), else null. */
export function connexGate(f: ConnexFlight): string | null {
  return f.gate ?? (f.terminal === null ? null : `TERM ${f.terminal}`);
}
