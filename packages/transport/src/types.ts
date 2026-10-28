// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { CpdlcHeader, FormattedMessage } from '@acars/core';

/**
 * Transport contract (CLAUDE.md, invariant 7): Hoppie, SayIntentions and the mock are
 * interchangeable. The app drives a transport with `tick()` from its main loop (once a
 * second is enough); the transport decides itself when a request may go out (queue,
 * rate limit, backoff, poll schedule) and reports results as events.
 */

export type TransportKind = 'hoppie' | 'sayintentions' | 'mock';

/** One telex to the aircraft. Only formatter output is accepted (invariant 9). */
export interface OutgoingTelex {
  /** Station callsign (sender), e.g. `OPSDLH123`. */
  readonly from: string;
  /** Aircraft callsign (recipient). */
  readonly to: string;
  readonly message: FormattedMessage;
  /**
   * Present for an ATC uplink (T23): sent as a Hoppie `cpdlc` packet `/data2/…` built from
   * this header and the message (`cpdlcPacket`, CPDLC profile); absent = `telex`.
   */
  readonly cpdlc?: CpdlcHeader;
}

/** A message the network delivered to one of our station callsigns. */
export interface InboundMessage {
  readonly from: string;
  /** Our callsign the message was addressed to (the one we polled). */
  readonly to: string;
  /** Hoppie message type as received (`telex`, `cpdlc`, `progress`, …). */
  readonly type: string;
  readonly packet: string;
}

/**
 * - `idle`: nothing sent yet;
 * - `ok`: the last request succeeded;
 * - `degraded`: requests fail, the transport keeps retrying with backoff;
 * - `halted`: a fatal error (bad logon code); nothing goes out until `resume()`.
 */
export type TransportStatus = 'idle' | 'ok' | 'degraded' | 'halted';

export type TransportEvent =
  | { readonly type: 'SENT'; readonly id: string; readonly t: number }
  | {
      readonly type: 'SEND_RETRY';
      readonly id: string;
      readonly t: number;
      readonly attempt: number;
      readonly nextAt: number;
      readonly reason: string;
    }
  | {
      readonly type: 'SEND_FAILED';
      readonly id: string;
      readonly t: number;
      readonly reason: string;
    }
  | { readonly type: 'INBOUND'; readonly t: number; readonly message: InboundMessage }
  | {
      readonly type: 'STATUS';
      readonly t: number;
      readonly status: TransportStatus;
      readonly reason?: string;
    };

export interface Transport {
  readonly kind: TransportKind;
  readonly status: TransportStatus;
  /** Number of telexes waiting to be sent. */
  readonly pending: number;
  /** Queues a telex; returns its id (used in SENT / SEND_* events). */
  send(telex: OutgoingTelex): string;
  /**
   * ATC station callsigns to poll even before they sent anything (T23: a ground station waits
   * for the aircraft's logon). Replaces the previous set; stations that sent a telex are
   * polled anyway.
   */
  listen(callsigns: readonly string[]): void;
  /** Poll faster for a while, e.g. after a message that expects a pilot reply. */
  expectReply(durationMs: number): void;
  /** Lets the transport start at most one request if one is due. Never blocks. */
  tick(): void;
  /** Events since the last call, oldest first. */
  takeEvents(): TransportEvent[];
  /** Leaves `halted` (e.g. after the user fixed the logon code). */
  resume(): void;
  /** Resolves when no request is in flight. */
  idle(): Promise<void>;
}
