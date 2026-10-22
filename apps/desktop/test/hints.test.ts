import { DCL_ID, DEFAULT_PROFILE, formatMessage, OCL_ID, type OutboundMessage } from '@acars/core';
import { describe, expect, it } from 'vitest';
import { MessageHints } from '../src/main/hints.js';
import { awaitingIds, firstSentence, messageHint } from '../src/renderer/src/hints.js';
import type { FeedEntry, PendingReply } from '../src/shared/api.js';

/** T57: hints of the XATC clearances (main) and what the renderer shows (setting on and off). */

const msg = (scenarioId: string, text: string, extra: Partial<OutboundMessage> = {}) =>
  ({
    scenarioId,
    from: 'XCTP',
    to: 'EVA2196',
    kind: 'telex',
    message: formatMessage(text, DEFAULT_PROFILE),
    t: 0,
    toPilot: false,
    ...extra,
  }) as OutboundMessage;

describe('hints of the XATC clearances', () => {
  const hints = new MessageHints([]);

  it('DCL: the CPDLC clearance (WU) asks for WILCO; the other packets have none', () => {
    const cld = msg(DCL_ID, 'CLD', { kind: 'cpdlc', cpdlc: { min: 3, mrn: null, ra: 'WU' } });
    expect(hints.forMessage(cld)?.en).toMatch(/^Departure clearance \(CLD\) from XCTP.*WILCO/);
    expect(hints.forMessage(cld)?.ru).toMatch(/WILCO/);
    const fsm = msg(DCL_ID, 'FSM', { kind: 'cpdlc', cpdlc: { min: 2, mrn: null, ra: 'NE' } });
    expect(hints.forMessage(fsm)).toBeNull();
  });

  it('US PDC by telex: no answer expected; UNABLE REVERT TO VOICE has no hint', () => {
    expect(hints.forMessage(msg(DCL_ID, 'PDC 001'))?.en).toMatch(/no answer is expected/);
    expect(hints.forMessage(msg(DCL_ID, 'UNABLE REVERT TO VOICE'))).toBeNull();
  });

  it('oceanic: the CLX asks for ROGER; RCL RECEIVED has no hint', () => {
    expect(hints.forMessage(msg(OCL_ID, 'CLX 1200 EGGX CLRNCE 123'))?.en).toMatch(/ROGER/);
    expect(hints.forMessage(msg(OCL_ID, 'RCL RECEIVED'))).toBeNull();
  });

  it('unknown scenarios and the engine answers have none', () => {
    expect(hints.forMessage(msg('#ops', 'UNABLE'))).toBeNull();
    expect(hints.forMessage(msg('nope', 'X', { step: 0 }))).toBeNull();
  });
});

describe('hints in the renderer', () => {
  const entry: FeedEntry = {
    kind: 'outbound',
    id: 'f1',
    t: 0,
    from: 'OPS822',
    to: 'EVA2196',
    scenarioId: 'x',
    text: 'X',
    delivery: 'sent',
    detail: null,
    hint: { en: 'Means.', ru: 'Значит.' },
  };
  const pending: PendingReply = {
    scenarioId: 'x',
    messageId: 'f1',
    station: 'OPS822',
    options: ['A', 'B'],
    hints: null,
    default: 'B',
    minutesLeft: 3,
  };

  it('on: the meaning and the awaited answer of the selected message; the feed mark', () => {
    expect(messageHint(true, entry, [pending])).toEqual({ text: entry.hint, reply: pending });
    expect(messageHint(true, { ...entry, hint: null }, [])).toBeNull();
    expect(awaitingIds(true, [pending, { ...pending, messageId: null }])).toEqual(new Set(['f1']));
  });

  it('off: nothing is shown', () => {
    expect(messageHint(false, entry, [pending])).toBeNull();
    expect(awaitingIds(false, [pending]).size).toBe(0);
  });

  it('a pilot message has no hint', () => {
    const pilot: FeedEntry = {
      kind: 'inbound',
      id: 'f2',
      t: 0,
      from: 'A',
      to: 'B',
      type: 'telex',
      text: 'X',
    };
    expect(messageHint(true, pilot, [pending])).toBeNull();
  });

  it('the request window shows the first sentence of the command hint', () => {
    expect(firstSentence('REQ WX <ICAO> asks (empty: the destination). This answer.')).toBe(
      'REQ WX <ICAO> asks (empty: the destination).',
    );
    expect(firstSentence('No full stop')).toBe('No full stop');
  });
});
