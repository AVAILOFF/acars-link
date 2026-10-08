import type { Clock, Rng } from '@acars/core';
import { type HttpClient, HttpTimeoutError } from '../http.js';
import type {
  OutgoingTelex,
  Transport,
  TransportEvent,
  TransportKind,
  TransportStatus,
} from '../types.js';
import {
  buildRequest,
  HOPPIE_ENDPOINT,
  type HoppieParams,
  type HoppieResponse,
  isCallsignInUse,
  isFatalReason,
  isValidCallsign,
  parsePoll,
  parseResponse,
  SERVER_CALLSIGN,
} from './protocol.js';

/**
 * Hoppie-compatible transport (Hoppie; SayIntentions speaks the same protocol on its own
 * endpoint). Etiquette from tech.html (CLAUDE.md, invariant 6):
 * - one request in flight, at least `minRequestGapMs` between requests (no bursts);
 * - poll a station callsign only after it sent its first message, every 45–75 s at
 *   random, 20 s for a short while when a reply is expected;
 * - 15 s timeout; a failed poll is skipped until the next normal interval, a failed
 *   send is retried with exponential backoff and jitter, never in a tight loop.
 * Telexes go out strictly in order: a telex waiting for a retry holds the ones behind it.
 */

export interface RetryPolicy {
  /** Delay before the first retry; doubles with every attempt. */
  readonly baseMs: number;
  readonly maxMs: number;
  /** Attempts in total, the first one included. */
  readonly maxAttempts: number;
}

export interface HoppieTransportOptions {
  /** Personal logon code. Never logged, never put into events. */
  readonly logon: string;
  readonly http: HttpClient;
  readonly clock: Clock;
  readonly rng: Rng;
  readonly kind?: Exclude<TransportKind, 'mock'>;
  readonly endpoint?: string;
  /** Normal poll interval, random in [min, max]. Default 45–75 s. */
  readonly pollIntervalMs?: readonly [number, number];
  /** Poll interval while a reply is expected. Default 20 s. */
  readonly fastPollMs?: number;
  /** Upper bound for {@link Transport.expectReply}. Default 3 min. */
  readonly maxFastPollWindowMs?: number;
  /** Minimum time between two requests. Default 2 s. */
  readonly minRequestGapMs?: number;
  /** Default 15 s. */
  readonly timeoutMs?: number;
  readonly retry?: Partial<RetryPolicy>;
  /** Retry delay when another logon code holds the callsign (lock TTL 100 s). */
  readonly callsignInUseDelayMs?: number;
}

interface QueuedTelex {
  readonly id: string;
  readonly telex: OutgoingTelex;
  attempts: number;
  notBefore: number;
}

type Outcome =
  | { readonly kind: 'response'; readonly res: HoppieResponse }
  | { readonly kind: 'failure'; readonly reason: string };

const DEFAULT_RETRY: RetryPolicy = { baseMs: 5_000, maxMs: 300_000, maxAttempts: 6 };

export class HoppieTransport implements Transport {
  readonly kind: Exclude<TransportKind, 'mock'>;
  private readonly endpoint: string;
  private readonly pollInterval: readonly [number, number];
  private readonly fastPollMs: number;
  private readonly maxFastWindowMs: number;
  private readonly gapMs: number;
  private readonly timeoutMs: number;
  private readonly retry: RetryPolicy;
  private readonly inUseDelayMs: number;

  private readonly queue: QueuedTelex[] = [];
  /** Station callsign → next poll time. A station joins after its first sent telex. */
  private readonly polls = new Map<string, number>();
  private events: TransportEvent[] = [];
  private inflight: Promise<void> | null = null;
  private lastRequestAt = Number.NEGATIVE_INFINITY;
  private fastUntil = Number.NEGATIVE_INFINITY;
  private seq = 0;
  private current: TransportStatus = 'idle';

  constructor(private readonly o: HoppieTransportOptions) {
    if (o.logon.trim() === '') throw new TypeError('Hoppie logon code is empty');
    this.kind = o.kind ?? 'hoppie';
    this.endpoint = o.endpoint ?? HOPPIE_ENDPOINT;
    if (!this.endpoint.startsWith('https://')) {
      throw new TypeError('Hoppie endpoint must use https');
    }
    this.pollInterval = o.pollIntervalMs ?? [45_000, 75_000];
    this.fastPollMs = o.fastPollMs ?? 20_000;
    this.maxFastWindowMs = o.maxFastPollWindowMs ?? 180_000;
    this.gapMs = o.minRequestGapMs ?? 2_000;
    this.timeoutMs = o.timeoutMs ?? 15_000;
    this.retry = { ...DEFAULT_RETRY, ...o.retry };
    this.inUseDelayMs = o.callsignInUseDelayMs ?? 110_000;
    const [min, max] = this.pollInterval;
    if (!(min >= 20_000 && max >= min)) throw new RangeError('poll interval must be ≥ 20 s');
    if (this.fastPollMs < 20_000) throw new RangeError('fast poll interval must be ≥ 20 s');
    if (this.gapMs < 1_000) throw new RangeError('request gap must be ≥ 1 s');
    if (this.retry.maxAttempts < 1 || this.retry.baseMs < 1_000) {
      throw new RangeError('retry policy needs ≥ 1 attempt and a base delay ≥ 1 s');
    }
  }

  get status(): TransportStatus {
    return this.current;
  }

  get pending(): number {
    return this.queue.length;
  }

  send(telex: OutgoingTelex): string {
    for (const cs of [telex.from, telex.to]) {
      if (!isValidCallsign(cs)) throw new TypeError(`invalid callsign "${cs}"`);
    }
    if (telex.message.text.trim() === '') throw new TypeError('empty telex');
    this.seq++;
    const id = `tx-${this.seq}`;
    this.queue.push({ id, telex, attempts: 0, notBefore: Number.NEGATIVE_INFINITY });
    return id;
  }

  expectReply(durationMs: number): void {
    const now = this.o.clock.now();
    this.fastUntil = Math.max(this.fastUntil, now + Math.min(durationMs, this.maxFastWindowMs));
    for (const [cs, at] of this.polls) this.polls.set(cs, Math.min(at, now + this.fastPollMs));
  }

  tick(): void {
    if (this.current === 'halted' || this.inflight !== null) return;
    const now = this.o.clock.now();
    if (now - this.lastRequestAt < this.gapMs) return;

    const head = this.queue[0];
    if (head !== undefined && head.notBefore <= now) {
      this.start(now, this.sendHead(head));
      return;
    }
    let due: string | undefined;
    let dueAt = Number.POSITIVE_INFINITY;
    for (const [cs, at] of this.polls) {
      if (at <= now && at < dueAt) {
        due = cs;
        dueAt = at;
      }
    }
    if (due !== undefined) this.start(now, this.poll(due));
  }

  takeEvents(): TransportEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  resume(): void {
    if (this.current === 'halted') this.setStatus(this.o.clock.now(), 'idle');
  }

  idle(): Promise<void> {
    return this.inflight ?? Promise.resolve();
  }

  private start(now: number, work: Promise<void>): void {
    this.lastRequestAt = now;
    this.inflight = work.finally(() => {
      this.inflight = null;
    });
  }

  private async sendHead(q: QueuedTelex): Promise<void> {
    q.attempts++;
    const out = await this.request({
      logon: this.o.logon,
      from: q.telex.from,
      to: q.telex.to,
      type: 'telex',
      packet: q.telex.message.text,
    });
    const now = this.o.clock.now();
    if (out.kind === 'failure') return this.retryHead(q, now, out.reason, null);
    if (out.res.ok) {
      this.queue.shift();
      this.events.push({ type: 'SENT', id: q.id, t: now });
      this.setStatus(now, 'ok');
      if (!this.polls.has(q.telex.from)) this.polls.set(q.telex.from, this.nextPoll(now));
      return;
    }
    const reason = this.clean(out.res.reason);
    if (isFatalReason(reason)) {
      q.attempts--; // not the telex's fault: it goes out unchanged after resume()
      this.setStatus(now, 'halted', reason);
      return;
    }
    if (isCallsignInUse(reason)) return this.retryHead(q, now, reason, this.inUseDelayMs);
    this.queue.shift();
    this.events.push({ type: 'SEND_FAILED', id: q.id, t: now, reason });
    this.setStatus(now, 'ok'); // the server answered: the link itself works
  }

  private retryHead(q: QueuedTelex, now: number, reason: string, fixedDelay: number | null) {
    this.setStatus(now, 'degraded', reason);
    if (q.attempts >= this.retry.maxAttempts) {
      this.queue.shift();
      this.events.push({ type: 'SEND_FAILED', id: q.id, t: now, reason });
      return;
    }
    const exp = Math.min(this.retry.maxMs, this.retry.baseMs * 2 ** (q.attempts - 1));
    const delay = fixedDelay ?? Math.round(exp * (0.8 + 0.4 * this.o.rng.next()));
    q.notBefore = now + delay;
    this.events.push({
      type: 'SEND_RETRY',
      id: q.id,
      t: now,
      attempt: q.attempts,
      nextAt: q.notBefore,
      reason,
    });
  }

  private async poll(station: string): Promise<void> {
    const out = await this.request({
      logon: this.o.logon,
      from: station,
      to: SERVER_CALLSIGN,
      type: 'poll',
      packet: '',
    });
    const now = this.o.clock.now();
    // Success or not, the next poll waits a full interval (no immediate retry).
    this.polls.set(station, this.nextPoll(now));
    if (out.kind === 'failure') {
      this.setStatus(now, 'degraded', out.reason);
      return;
    }
    if (!out.res.ok) {
      const reason = this.clean(out.res.reason);
      this.setStatus(now, isFatalReason(reason) ? 'halted' : 'degraded', reason);
      return;
    }
    this.setStatus(now, 'ok');
    for (const message of parsePoll(out.res.content, station).messages) {
      this.events.push({ type: 'INBOUND', t: now, message });
    }
  }

  private nextPoll(now: number): number {
    if (now < this.fastUntil) return now + this.fastPollMs;
    const [min, max] = this.pollInterval;
    return now + this.o.rng.int(min, max);
  }

  private async request(p: HoppieParams): Promise<Outcome> {
    try {
      const res = await this.o.http.request(buildRequest(this.endpoint, p, this.timeoutMs));
      if (res.status < 200 || res.status >= 300) {
        return { kind: 'failure', reason: `http ${res.status}` };
      }
      return { kind: 'response', res: parseResponse(res.body) };
    } catch (e) {
      const reason = e instanceof HttpTimeoutError ? 'timeout' : errorText(e);
      return { kind: 'failure', reason: this.clean(reason) };
    }
  }

  private setStatus(t: number, status: TransportStatus, reason?: string): void {
    if (status === this.current) return;
    this.current = status;
    this.events.push(
      reason === undefined ? { type: 'STATUS', t, status } : { type: 'STATUS', t, status, reason },
    );
  }

  /** The logon code must never leave the transport (CLAUDE.md, invariant 2). */
  private clean(text: string): string {
    return text.split(this.o.logon).join('***');
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message || e.name : 'network error';
}
