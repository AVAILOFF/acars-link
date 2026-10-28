// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

/**
 * Shared bits of the adapters: one GET with timeout and User-Agent, JSON parsing that never
 * throws anything but {@link DataSourceError}, telex-safe text.
 */

/**
 * The HTTP seam (same shape as `@acars/transport`'s `HttpClient`, so the app passes the same
 * `fetchHttpClient()`): resolves with any status, rejects on network error or timeout.
 */
export interface HttpClient {
  request(req: {
    readonly method: 'GET' | 'POST';
    readonly url: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly timeoutMs: number;
  }): Promise<{ readonly status: number; readonly body: string }>;
}

export class DataSourceError extends Error {
  override readonly name = 'DataSourceError';
  /** No retry in this flight (a rejected key, an exhausted quota; T30). */
  readonly final: boolean;
  constructor(message: string, final = false) {
    super(message);
    this.final = final;
  }
}

/** docs/06: every adapter has a timeout. */
export const DEFAULT_TIMEOUT_MS = 15_000;

export interface FetchContext {
  readonly http: HttpClient;
  /** aviationweather.gov and Overpass ask for an identifying User-Agent. */
  readonly userAgent: string;
  readonly timeoutMs?: number;
}

export interface GetResult {
  readonly status: number;
  readonly body: string;
}

export async function request(
  ctx: FetchContext,
  url: string,
  init: { method?: 'GET' | 'POST'; body?: string; contentType?: string } = {},
): Promise<GetResult> {
  try {
    const res = await ctx.http.request({
      method: init.method ?? 'GET',
      url,
      headers: {
        'User-Agent': ctx.userAgent,
        Accept: 'application/json',
        ...(init.contentType === undefined ? {} : { 'Content-Type': init.contentType }),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
      timeoutMs: ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    return res;
  } catch (e) {
    throw new DataSourceError(e instanceof Error ? e.message : String(e));
  }
}

export function expectOk(res: GetResult, what: string): void {
  if (res.status === 429) throw new DataSourceError(`${what}: rate limited (429)`);
  if (res.status < 200 || res.status >= 300) {
    throw new DataSourceError(`${what}: HTTP ${res.status}`);
  }
}

export function parseJson(body: string, what: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new DataSourceError(`${what}: response is not JSON`);
  }
}

export const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * Text that can go into a telex as is: ASCII folded, upper case, only `A–Z 0–9` and a few
 * separators, single spaces, at most `max` characters (cut at a word).
 */
export function telexText(s: string, max = 60): string {
  const t = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 .,/()-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : cut.slice(0, max)).replace(/[ ,/(-]+$/, '');
}

export const ICAO_RE = /^[A-Z]{4}$/;
