import type { ConnexData, ConnexFlight, Ofp } from '@acars/core';
import { CONNEX_FROM_MIN, CONNEX_TO_MIN } from '@acars/core';
import { DataSourceError, type FetchContext, ICAO_RE, isObj, parseJson } from './common.js';

/**
 * Onward departures of the airline from the destination (T30, docs/06 "AeroDataBox", docs/07
 * C1–C11; OpenAPI v1.15.4.0 checked 2026-10-15).
 *
 * FIDS `GET /flights/airports/icao/{ICAO}/{fromLocal}/{toLocal}` (Tier 2, 2 units; window ≤ 12 h)
 * through RapidAPI with the user's own key (C1, C11): headers `X-RapidAPI-Key` and
 * `X-RapidAPI-Host`. One request per flight (C5): local time of the destination from STA+30 min
 * to STA+4 h, the date from the OFP. 204 = no departures. 401/403/429 and other 4xx end the
 * source for the flight ({@link DataSourceError.final}); network errors, timeouts and 5xx may be
 * retried once by the service.
 *
 * Kept: departures of the OFP airline (`airline.icao`), not cargo, not cancelled or diverted,
 * with an ICAO destination and a scheduled UTC time. Terms of use (ed. 2026-10-11): attribution
 * on the free plan (C4), no copy kept longer than 7 days (C9), personal non-commercial use (C3).
 * The field shapes are from the OpenAPI spec; a live answer is `[ПРОВЕРИТЬ]` (C6).
 */

/** C11: the only gateway for now; API.Market and the direct one — `[ПРИ РЕЛИЗЕ]`. */
export const AERODATABOX_GATEWAY = {
  base: 'https://aerodatabox.p.rapidapi.com',
  keyHeader: 'X-RapidAPI-Key',
  hostHeader: { 'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com' },
} as const;

const MIN = 60_000;

/** `2026-10-15T14:30` from epoch ms and a UTC offset in hours. */
export function localStamp(ms: number, offsetH: number): string {
  return new Date(ms + Math.round(offsetH * 60) * MIN).toISOString().slice(0, 16);
}

/** The FIDS URL of C5, or null when the OFP lacks the airline or the destination's UTC offset. */
export function connexUrl(ofp: Ofp): string | null {
  const offset = ofp.destination.utcOffsetH;
  if (ofp.airlineIcao === null || offset === null || !ICAO_RE.test(ofp.destination.icao)) {
    return null;
  }
  const sta = ofp.times.schedInMs;
  const from = localStamp(sta + CONNEX_FROM_MIN * MIN, offset);
  const to = localStamp(sta + CONNEX_TO_MIN * MIN, offset);
  const q =
    'direction=Departure&withLeg=false&withCancelled=false&withCodeshared=true' +
    '&withCargo=false&withPrivate=false&withLocation=false';
  return `${AERODATABOX_GATEWAY.base}/flights/airports/icao/${ofp.destination.icao}/${from}/${to}?${q}`;
}

/** One request (C5). Null when the OFP does not allow it (C10). */
export async function fetchConnex(
  ctx: FetchContext,
  key: string,
  ofp: Ofp,
): Promise<ConnexData | null> {
  const url = connexUrl(ofp);
  if (url === null || ofp.airlineIcao === null) return null;
  let res: { status: number; body: string };
  try {
    res = await ctx.http.request({
      method: 'GET',
      url,
      headers: {
        'User-Agent': ctx.userAgent,
        Accept: 'application/json',
        [AERODATABOX_GATEWAY.keyHeader]: key,
        ...AERODATABOX_GATEWAY.hostHeader,
      },
      timeoutMs: ctx.timeoutMs ?? 15_000,
    });
  } catch (e) {
    // Never the URL or headers in the message: the key must not reach a log.
    throw new DataSourceError(`AeroDataBox: ${e instanceof Error ? e.name : 'network error'}`);
  }
  const icao = ofp.destination.icao;
  if (res.status === 204) return { icao, list: [] };
  if (res.status >= 500) throw new DataSourceError(`AeroDataBox: HTTP ${res.status}`);
  if (res.status === 401 || res.status === 403) {
    throw new DataSourceError(`AeroDataBox: key rejected (${res.status})`, true);
  }
  if (res.status === 429) throw new DataSourceError('AeroDataBox: quota or rate limit (429)', true);
  if (res.status < 200 || res.status >= 300) {
    throw new DataSourceError(`AeroDataBox: HTTP ${res.status}`, true);
  }
  return { icao, list: parseConnex(parseJson(res.body, 'AeroDataBox'), ofp.airlineIcao) };
}

const CANCELLED = new Set(['Canceled', 'CanceledUncertain', 'Diverted']);
/** `2026-10-15 14:30Z` (AeroDataBox) or ISO `2026-10-15T14:30:00Z` / `+00:00`. */
const UTC_RE =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]00:?00)$/;

export function parseUtc(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = UTC_RE.exec(s.trim());
  if (m === null) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map((x) => Number(x ?? 0)) as number[];
  const t = Date.UTC(y as number, (mo as number) - 1, d, h, mi, se);
  return Number.isFinite(t) ? t : null;
}

/** Gate or terminal as A–Z0–9 (`Gate B 12` → `B12`), ≤ 6 characters; null otherwise. */
function code(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const t = s
    .toUpperCase()
    .replace(/\b(GATE|TERMINAL|TERM)\b/g, '')
    .replace(/[^A-Z0-9]/g, '');
  return t.length >= 1 && t.length <= 6 ? t : null;
}

/** The departures of `airline` in a FIDS answer (`{departures: [...]}`). */
export function parseConnex(json: unknown, airline: string): ConnexFlight[] {
  if (!isObj(json)) throw new DataSourceError('AeroDataBox: unexpected answer');
  const deps = json['departures'] ?? [];
  if (!Array.isArray(deps)) throw new DataSourceError('AeroDataBox: unexpected answer');
  const out: ConnexFlight[] = [];
  for (const f of deps) {
    if (!isObj(f) || !isObj(f['airline']) || f['airline']['icao'] !== airline) continue;
    if (f['isCargo'] === true || CANCELLED.has(String(f['status']))) continue;
    const mv = f['movement'];
    if (!isObj(mv) || !isObj(mv['airport']) || !isObj(mv['scheduledTime'])) continue;
    const dest = mv['airport']['icao'];
    const std = parseUtc(mv['scheduledTime']['utc']);
    const number =
      typeof f['number'] === 'string' ? f['number'].toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
    if (typeof dest !== 'string' || !ICAO_RE.test(dest) || std === null) continue;
    if (!/^[A-Z0-9]{3,8}$/.test(number)) continue;
    out.push({
      number,
      dest,
      std,
      terminal: code(mv['terminal']),
      gate: code(mv['gate']),
      codeshare: f['codeshareStatus'] === 'IsCodeshared',
    });
  }
  return out;
}
