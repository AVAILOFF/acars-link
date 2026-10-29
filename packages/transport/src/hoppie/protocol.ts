// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { HttpRequest } from '../http.js';
import type { InboundMessage } from '../types.js';

/**
 * Hoppie ACARS connect protocol (https://www.hoppie.nl/acars/system/tech.html, checked
 * 2026-10-08). Pure: builds requests and parses response bodies, no I/O.
 *
 * - Endpoint `connect.html` answers on https as well as http.
 * - Parameters `logon`, `from`, `to`, `type`, `packet`; GET and POST may be mixed. We send
 *   every request by POST with all of them in the form body (T68): the logon code never goes
 *   into a URL, where proxies, HTTPS-inspecting antivirus and runtime errors may keep it. The
 *   server reads `logon` from the body (checked 2026-10-29: without it `error (no logon code)`,
 *   with a wrong one `error {invalid logon code}`).
 * - Responses: `ok`, `ok {…}` or `error {reason}`. Poll: `ok {FROM type {packet}} …`;
 *   ping with callsigns: `ok {CS1 CS2}`.
 */

export const HOPPIE_ENDPOINT = 'https://www.hoppie.nl/acars/system/connect.html';
/** `to` for server-directed types (poll, ping): ignored but required. */
export const SERVER_CALLSIGN = 'SERVER';

export type HoppieType = 'ping' | 'telex' | 'poll' | 'cpdlc';

export interface HoppieParams {
  readonly logon: string;
  readonly from: string;
  readonly to: string;
  readonly type: HoppieType;
  readonly packet: string;
}

/** Callsign check before anything goes on the wire. Hoppie defines no formal format
 * `[ПРОВЕРИТЬ]` max length; we accept what its responses can carry: `A–Z0–9`. */
const CALLSIGN = /^[A-Z0-9]{2,16}$/;

export function isValidCallsign(cs: string): boolean {
  return CALLSIGN.test(cs);
}

/** POST to `endpoint` with every parameter in a form body; nothing in the query. */
export function buildRequest(endpoint: string, p: HoppieParams, timeoutMs: number): HttpRequest {
  const body = new URLSearchParams({
    logon: p.logon,
    from: p.from,
    to: p.to,
    type: p.type,
    packet: p.packet,
  });
  return {
    method: 'POST',
    url: endpoint,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    timeoutMs,
  };
}

export type HoppieResponse =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly reason: string };

export class HoppieProtocolError extends Error {
  override readonly name = 'HoppieProtocolError';
}

/** `ok[ …]` / `error {reason}`; anything else is a protocol error. */
export function parseResponse(body: string): HoppieResponse {
  const text = body.trim();
  const m = /^(ok|error)(?:\s+([\s\S]*))?$/.exec(text);
  if (m === null) throw new HoppieProtocolError(`unexpected response: ${preview(text)}`);
  const rest = m[2] ?? '';
  if (m[1] === 'ok') return { ok: true, content: rest };
  const open = rest.indexOf('{');
  const close = rest.lastIndexOf('}');
  const reason = open >= 0 && close > open ? rest.slice(open + 1, close) : rest;
  return { ok: false, reason: reason.trim() };
}

/** Top-level `{…}` groups of `content`, nested braces balanced. Text outside groups and an
 * unterminated tail are ignored. */
function groups(content: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === '{') {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (c === '}' && depth > 0) {
      depth--;
      if (depth === 0) out.push(content.slice(start, i));
    }
  }
  return out;
}

export interface PollResult {
  readonly messages: readonly InboundMessage[];
  /** Groups that did not match `FROM type {packet}`. */
  readonly malformed: number;
}

const POLL_GROUP = /^\s*([A-Z0-9]+)\s+([a-z][a-z-]*)\s*\{([\s\S]*)\}\s*$/;

/** `ok` content of a poll for `to`: `{FROM type {packet}} {FROM type {packet}} …`. */
export function parsePoll(content: string, to: string): PollResult {
  const messages: InboundMessage[] = [];
  let malformed = 0;
  for (const g of groups(content)) {
    const m = POLL_GROUP.exec(g);
    if (m === null || m[1] === undefined || m[2] === undefined || m[3] === undefined) {
      malformed++;
      continue;
    }
    messages.push({ from: m[1], to, type: m[2], packet: m[3] });
  }
  return { messages, malformed };
}

/** `ok` content of a ping: the online callsigns among those asked (`{CS1 CS2}`, braces
 * optional), if any. */
export function parsePing(content: string): string[] {
  const text = groups(content)[0] ?? content;
  return text.split(/\s+/).filter((cs) => CALLSIGN.test(cs));
}

/** Server error reasons that no retry can fix: the logon code is wrong. */
export function isFatalReason(reason: string): boolean {
  return /logon/i.test(reason);
}

/** Another logon code holds the callsign (lock TTL 100 s, tech.html). */
export function isCallsignInUse(reason: string): boolean {
  return /callsign already in use/i.test(reason);
}

function preview(s: string): string {
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}
