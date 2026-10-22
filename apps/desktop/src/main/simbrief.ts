import { type Ofp, OfpParseError, parseSimbriefOfp } from '@acars/core';
import type { HttpClient } from '@acars/transport';
import { AppFailure } from './errors.js';

/**
 * Latest OFP of a SimBrief user, docs/06 "SimBrief": `xml.fetcher.php?username=…&json=v2`.
 * An unknown user gives HTTP 400 with `{"fetch":{"status":"Error: Unknown UserID"}}`
 * (checked 2026-10-08).
 */

export const SIMBRIEF_ENDPOINT = 'https://www.simbrief.com/api/xml.fetcher.php';
const TIMEOUT_MS = 20_000;

/** SimBrief usernames: no spaces or control characters, ≤ 64. */
export function normalizeSimbriefUsername(input: unknown): string {
  if (typeof input !== 'string')
    throw new AppFailure('invalid_input', 'username: expected text', 'username_format');
  const u = input.trim();
  if (u === '' || u.length > 64 || /[\s\p{Cc}]/u.test(u)) {
    throw new AppFailure(
      'invalid_input',
      'username: 1..64 characters without spaces',
      'username_format',
    );
  }
  return u;
}

export function simbriefUrl(username: string): string {
  return `${SIMBRIEF_ENDPOINT}?username=${encodeURIComponent(username)}&json=v2`;
}

export async function fetchOfp(http: HttpClient, username: string): Promise<Ofp> {
  let res: Awaited<ReturnType<HttpClient['request']>>;
  try {
    res = await http.request({ method: 'GET', url: simbriefUrl(username), timeoutMs: TIMEOUT_MS });
  } catch (e) {
    throw new AppFailure('network', e instanceof Error ? e.message : String(e));
  }
  let json: unknown;
  try {
    json = JSON.parse(res.body);
  } catch {
    throw new AppFailure('simbrief_http', `HTTP ${res.status}, not JSON`);
  }
  const status = fetchStatus(json);
  if (status !== null && /^error/i.test(status)) {
    const unknownUser = /unknown user/i.test(status);
    throw new AppFailure(unknownUser ? 'simbrief_user' : 'simbrief_http', status);
  }
  if (res.status !== 200) throw new AppFailure('simbrief_http', `HTTP ${res.status}`);
  try {
    return parseSimbriefOfp(json);
  } catch (e) {
    if (e instanceof OfpParseError) throw new AppFailure('ofp_invalid', e.message);
    throw e;
  }
}

function fetchStatus(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return null;
  const fetch = (json as { fetch?: unknown }).fetch;
  if (typeof fetch !== 'object' || fetch === null) return null;
  const status = (fetch as { status?: unknown }).status;
  return typeof status === 'string' ? status : null;
}
