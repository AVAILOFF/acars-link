// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { FeedEntry, PendingReply, UiText } from '../../shared/api.js';

/**
 * What the hint block under the FMS screen shows (T57): the meaning of the selected message and the
 * answer the core waits for. Nothing when the setting "Message hints" is off or there is nothing
 * to say.
 */
export interface MessageHintView {
  readonly text: UiText | null;
  readonly reply: PendingReply | null;
}

export function messageHint(
  enabled: boolean,
  selected: FeedEntry | undefined,
  pending: readonly PendingReply[],
): MessageHintView | null {
  if (!enabled || selected === undefined || selected.kind !== 'outbound') return null;
  const reply = pending.find((p) => p.messageId === selected.id) ?? null;
  if (selected.hint === null && reply === null) return null;
  return { text: selected.hint, reply };
}

/** The first sentence of a command's hint: what the command does (the request window, T57). */
export function firstSentence(text: string): string {
  return /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
}

const NONE: ReadonlySet<string> = new Set();

/** Feed entries marked "awaiting reply"; none when the hints are off. */
export function awaitingIds(
  enabled: boolean,
  pending: readonly PendingReply[],
): ReadonlySet<string> {
  if (!enabled) return NONE;
  return new Set(pending.flatMap((p) => (p.messageId === null ? [] : [p.messageId])));
}
