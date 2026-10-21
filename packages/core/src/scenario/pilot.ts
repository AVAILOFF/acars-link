import type { PilotCommand } from './types.js';

/**
 * Pilot telexes (docs/05 "Входящие команды пилота"): normalization and the command parser.
 * Tolerant to case, spaces and separators: aircraft send `REQ-REFUEL` (Fenix free text,
 * docs/06), people type `req  wx eddf`. After {@link normalizePilotText} the text is words of
 * `A–Z0–9` split by single spaces, so it is safe to echo into a telex.
 */

/** A message from the aircraft, as the transport received it. */
export interface PilotMessage {
  /** Sender callsign. Only the flight's own callsign counts as the pilot. */
  readonly from: string;
  /** Hoppie message type (`telex`, `cpdlc`, …); the airline reads only `telex`. */
  readonly type: string;
  readonly text: string;
  /**
   * Our callsign the message was addressed to (T23). Messages to a XATC station go to
   * the station, the rest to the airline; absent (older recordings, typed in the app) = the
   * airline.
   */
  readonly to?: string;
}

export function normalizePilotText(text: string): string {
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/** Arguments of a parsed command, seen by scenarios as `cmd.*`. */
export interface CommandArgs {
  readonly icao: string | null;
  readonly minutes: number | null;
  readonly reason: string | null;
  /** `REQ GATE CHANGE <gate>`: the gate asked for. */
  readonly gate: string | null;
}

export type ParsedCommand =
  | { readonly ok: true; readonly command: PilotCommand; readonly args: CommandArgs }
  /** A known command with bad arguments; `hint` is the expected format (telex text). */
  | { readonly ok: false; readonly command: PilotCommand; readonly hint: string };

/** Upper bound of `DELAY <min>`. */
export const MAX_PILOT_DELAY_MIN = 600;

const ICAO = /^[A-Z]{4}$/;
const NO_ARGS: CommandArgs = { icao: null, minutes: null, reason: null, gate: null };
const GATE_REF = /^[A-Z]{0,2}\d{1,3}[A-Z]?$/;

/** Parses a normalized text; null = not a command. Extra words after a command are ignored. */
export function parseCommand(normalized: string): ParsedCommand | null {
  const [w0, w1, w2, ...rest] = normalized.split(' ');
  const ok = (command: PilotCommand, args: Partial<CommandArgs> = {}): ParsedCommand => ({
    ok: true,
    command,
    args: { ...NO_ARGS, ...args },
  });
  switch (w0) {
    case 'REQ':
      switch (w1) {
        case 'WX':
        case 'METAR':
          // Without an airport: the destination (the engine fills it in).
          if (w2 === undefined) return ok('REQ_WX');
          return ICAO.test(w2)
            ? ok('REQ_WX', { icao: w2 })
            : { ok: false, command: 'REQ_WX', hint: 'REQ WX ICAO' };
        case 'GATE': {
          if (w2 !== 'CHANGE') return ok('REQ_GATE');
          // REQ GATE CHANGE [gate] [reason…]
          const [g, ...why] = rest;
          const asked = g !== undefined && GATE_REF.test(g) ? g : null;
          const reason = (asked === null ? [g, ...why] : why).filter((w) => w !== undefined);
          return ok('REQ_GATE_CHANGE', {
            gate: asked,
            reason: reason.length === 0 ? null : reason.join(' '),
          });
        }
        case 'ATIS':
          if (w2 === undefined) return ok('REQ_ATIS');
          return ICAO.test(w2)
            ? ok('REQ_ATIS', { icao: w2 })
            : { ok: false, command: 'REQ_ATIS', hint: 'REQ ATIS ICAO' };
        case 'LOADSHEET':
        case 'LS':
          return ok('REQ_LOADSHEET');
        default:
          return null;
      }
    case 'DELAY': {
      const min = w1 === undefined || !/^\d{1,4}$/.test(w1) ? Number.NaN : Number(w1);
      if (!(min >= 1 && min <= MAX_PILOT_DELAY_MIN)) {
        return { ok: false, command: 'DELAY', hint: `DELAY MIN 1-${MAX_PILOT_DELAY_MIN} REASON` };
      }
      const reason = [w2, ...rest].filter((w) => w !== undefined).join(' ');
      return ok('DELAY', { minutes: min, reason: reason === '' ? null : reason });
    }
    case 'DIVERT':
      return w1 !== undefined && ICAO.test(w1)
        ? ok('DIVERT', { icao: w1 })
        : { ok: false, command: 'DIVERT', hint: 'DIVERT ICAO' };
    case 'MEDICAL': {
      // The pilot's own report: the rest of the text is passed on as the symptoms.
      const text = [w1, w2, ...rest].filter((w) => w !== undefined).join(' ');
      return ok('MEDICAL', { reason: text === '' ? null : text });
    }
    case 'RDY':
      return ok('RDY');
    case 'ETA':
      return ok('ETA');
    case 'HELP':
      return ok('HELP');
    default:
      return null;
  }
}
