/**
 * Minimal HTTP seam: transports never call `fetch` themselves, so tests run against a fake
 * server and the app picks the implementation (Electron main: {@link fetchHttpClient}).
 */

export interface HttpRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** The request must reject after this long (Hoppie: 15 s). */
  readonly timeoutMs: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
}

export interface HttpClient {
  /** Resolves with any HTTP status; rejects on network error or timeout. */
  request(req: HttpRequest): Promise<HttpResponse>;
}

export class HttpTimeoutError extends Error {
  override readonly name = 'HttpTimeoutError';
}

/** `HttpClient` over the global `fetch` (Node ≥ 18, Electron). */
export function fetchHttpClient(fetchFn: typeof fetch = fetch): HttpClient {
  return {
    async request(req) {
      try {
        const res = await fetchFn(req.url, {
          method: req.method,
          ...(req.headers === undefined ? {} : { headers: { ...req.headers } }),
          ...(req.body === undefined ? {} : { body: req.body }),
          signal: AbortSignal.timeout(req.timeoutMs),
          redirect: 'error',
        });
        return { status: res.status, body: await res.text() };
      } catch (e) {
        if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
          throw new HttpTimeoutError(`timeout after ${req.timeoutMs} ms`);
        }
        // Never rethrow as-is: messages of some runtimes include the URL, i.e. the logon code.
        throw new Error(`network error${causeCode(e)}`);
      }
    },
  };
}

/** ` (ENOTFOUND)` and the like from Node's `fetch failed` cause, or nothing. */
function causeCode(e: unknown): string {
  const cause = e instanceof Error ? e.cause : undefined;
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const code = cause.code;
    if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) return ` (${code})`;
  }
  return '';
}
