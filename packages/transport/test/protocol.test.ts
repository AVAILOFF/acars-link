// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { describe, expect, it } from 'vitest';
import {
  buildRequest,
  HOPPIE_ENDPOINT,
  HoppieProtocolError,
  isCallsignInUse,
  isFatalReason,
  isValidCallsign,
  MAX_GET_URL_LENGTH,
  parsePing,
  parsePoll,
  parseResponse,
} from '../src/index.js';

const base = { logon: 'abcDEF123', from: 'OPSDLH4', to: 'DLH4', type: 'telex' as const };

describe('buildRequest', () => {
  it('uses GET with all parameters in the query when the URL is short', () => {
    const req = buildRequest(HOPPIE_ENDPOINT, { ...base, packet: 'GATE B12\nOK' }, 15_000);
    expect(req.method).toBe('GET');
    expect(req.body).toBeUndefined();
    expect(req.timeoutMs).toBe(15_000);
    const url = new URL(req.url);
    expect(url.origin + url.pathname).toBe(HOPPIE_ENDPOINT);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      logon: 'abcDEF123',
      from: 'OPSDLH4',
      to: 'DLH4',
      type: 'telex',
      packet: 'GATE B12\nOK',
    });
    expect(req.url.length).toBeLessThanOrEqual(MAX_GET_URL_LENGTH);
  });

  it('switches to POST with the packet in a form body when the URL would exceed 256', () => {
    const packet = 'LOADSHEET FINAL\n'.repeat(20);
    const req = buildRequest(HOPPIE_ENDPOINT, { ...base, packet }, 15_000);
    expect(req.method).toBe('POST');
    expect(req.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' });
    const url = new URL(req.url);
    expect(url.searchParams.has('packet')).toBe(false);
    expect(url.searchParams.get('type')).toBe('telex');
    expect(new URLSearchParams(req.body).get('packet')).toBe(packet);
  });
});

describe('parseResponse', () => {
  it('parses ok, ok with content and error with reason', () => {
    expect(parseResponse('ok')).toEqual({ ok: true, content: '' });
    expect(parseResponse(' ok {DLH4 telex {HELLO}}\n')).toEqual({
      ok: true,
      content: '{DLH4 telex {HELLO}}',
    });
    expect(parseResponse('error {invalid logon code}')).toEqual({
      ok: false,
      reason: 'invalid logon code',
    });
    expect(parseResponse('error {}')).toEqual({ ok: false, reason: '' });
    expect(parseResponse('error {multi\nline}')).toEqual({ ok: false, reason: 'multi\nline' });
  });

  it('rejects anything else', () => {
    expect(() => parseResponse('')).toThrow(HoppieProtocolError);
    expect(() => parseResponse('<html>502 Bad Gateway</html>')).toThrow(HoppieProtocolError);
    expect(() => parseResponse('okay')).toThrow(HoppieProtocolError);
  });
});

describe('parsePoll', () => {
  it('returns every message addressed to the polled station', () => {
    const r = parsePoll('{DLH4 telex {WILCO}} {EDDF cpdlc {/data2/1//WU/CLIMB TO FL350}}', 'OPS');
    expect(r.malformed).toBe(0);
    expect(r.messages).toEqual([
      { from: 'DLH4', to: 'OPS', type: 'telex', packet: 'WILCO' },
      { from: 'EDDF', to: 'OPS', type: 'cpdlc', packet: '/data2/1//WU/CLIMB TO FL350' },
    ]);
  });

  it('keeps empty packets, newlines and balanced braces inside a packet', () => {
    const r = parsePoll('{A1 telex {}} {B2 telex {LINE 1\nLINE {2}}} {C3 ads-c {X}}', 'OPS');
    expect(r.messages.map((m) => m.packet)).toEqual(['', 'LINE 1\nLINE {2}', 'X']);
    expect(r.messages[2]?.type).toBe('ads-c');
  });

  it('skips and counts malformed groups, ignores text outside groups', () => {
    const r = parsePoll('junk {A1 telex {OK}} {invalid} {lower telex {X}} {B2 telex {OK', 'OPS');
    expect(r.messages).toEqual([{ from: 'A1', to: 'OPS', type: 'telex', packet: 'OK' }]);
    expect(r.malformed).toBe(2);
  });

  it('returns nothing for an empty poll', () => {
    expect(parsePoll('', 'OPS')).toEqual({ messages: [], malformed: 0 });
  });
});

describe('parsePing and reason classes', () => {
  it('lists online callsigns', () => {
    expect(parsePing('')).toEqual([]);
    expect(parsePing('{DLH4 KLM123}')).toEqual(['DLH4', 'KLM123']);
    expect(parsePing('DLH4')).toEqual(['DLH4']);
  });

  it('classifies server error reasons', () => {
    expect(isFatalReason('invalid logon code')).toBe(true);
    expect(isFatalReason('illegal logon code')).toBe(true);
    expect(isFatalReason('callsign already in use')).toBe(false);
    expect(isCallsignInUse('callsign already in use')).toBe(true);
  });

  it('accepts only A–Z0–9 callsigns of 2–16 characters', () => {
    expect(isValidCallsign('OPSDLH123')).toBe(true);
    expect(isValidCallsign('DLH4')).toBe(true);
    for (const bad of ['', 'A', 'dlh4', 'ALL-CALLSIGNS', 'DLH 4', 'X{1}', 'A'.repeat(17)]) {
      expect(isValidCallsign(bad)).toBe(false);
    }
  });
});
