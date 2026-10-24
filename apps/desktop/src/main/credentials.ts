import {
  buildRequest,
  HOPPIE_ENDPOINT,
  type HttpClient,
  isFatalReason,
  parseResponse,
  SERVER_CALLSIGN,
} from '@acars/transport';
import { AppFailure } from './errors.js';

/**
 * Checks of what the user types as credentials, and the Hoppie "Check" ping (U-06).
 * The SimBrief username lives with its endpoint in `simbrief.ts`.
 */

/** Hoppie logon codes: printable ASCII without spaces (they go into a URL/form field). */
const LOGON_RE = /^[\x21-\x7e]{4,64}$/;
/** A RapidAPI key: letters and digits (T30). */
const RAPIDAPI_KEY_RE = /^[A-Za-z0-9]{20,100}$/;
/** Sender of the check ping: Hoppie needs one; a ping locks no callsign (docs/06). */
const HOPPIE_CHECK_FROM = 'ACARSSIM';
const HOPPIE_CHECK_TIMEOUT_MS = 15_000;

export function normalizeHoppieCode(input: unknown): string {
  const code = typeof input === 'string' ? input.trim() : '';
  if (!LOGON_RE.test(code)) {
    throw new AppFailure(
      'invalid_input',
      'logon code: 4..64 characters without spaces',
      'logon_format',
    );
  }
  return code;
}

export function normalizeRapidApiKey(input: unknown): string {
  const key = typeof input === 'string' ? input.trim() : '';
  if (!RAPIDAPI_KEY_RE.test(key)) {
    throw new AppFailure(
      'invalid_input',
      'RapidAPI key: 20..100 letters and digits',
      'rapidapi_format',
    );
  }
  return key;
}

/**
 * One Hoppie `ping` with the code. tech.html: "a single ping" tests the link; a wrong code answers
 * `error {invalid logon code}` (checked 2026-10-22, docs/06). The caller keeps the rate limit.
 */
export async function pingHoppie(http: HttpClient, logon: string): Promise<void> {
  const req = buildRequest(
    HOPPIE_ENDPOINT,
    { logon, from: HOPPIE_CHECK_FROM, to: SERVER_CALLSIGN, type: 'ping', packet: '' },
    HOPPIE_CHECK_TIMEOUT_MS,
  );
  let body: string;
  try {
    const res = await http.request(req);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    body = res.body;
  } catch (e) {
    // Only the message: the request URL holds the code.
    throw new AppFailure('network', e instanceof Error ? e.message : String(e));
  }
  let res: ReturnType<typeof parseResponse>;
  try {
    res = parseResponse(body);
  } catch (e) {
    throw new AppFailure('network', e instanceof Error ? e.message : String(e));
  }
  if (res.ok) return;
  if (isFatalReason(res.reason)) throw new AppFailure('hoppie_logon', res.reason);
  throw new AppFailure('network', `Hoppie: ${res.reason}`);
}
