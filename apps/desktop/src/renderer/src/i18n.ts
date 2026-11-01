// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { FlightPhase } from '@acars/core';
import {
  type AppError,
  type ErrorCode,
  type ErrorReason,
  LANGUAGE_IDS,
  type Language,
  type SystemCode,
  type UiText,
} from '../../shared/api.js';
import { de } from './messages-de.js';
import { en, type MessageKey } from './messages-en.js';
import { es } from './messages-es.js';
import { fr } from './messages-fr.js';
import { ru } from './messages-ru.js';

/**
 * UI strings by language (docs/08 decision 7, T85): `messages-<lang>.ts`. English has every key; another
 * language may lack some (shown in English), Russian is complete (its type requires it). ACARS messages
 * themselves are always English.
 */

export type { MessageKey };

export type Messages = Readonly<Partial<Record<MessageKey, string>>>;

type Complete = Readonly<Record<MessageKey, string>>;

export const MESSAGES: { readonly en: Complete; readonly ru: Complete } & Readonly<
  Partial<Record<Language, Messages>>
> = {
  en,
  ru,
  de,
  fr,
  es,
};

export type Translate = (
  key: MessageKey,
  params?: Readonly<Record<string, string | number>>,
) => string;

/**
 * An unknown key (e.g. a code from a newer main process) shows as text instead of crashing the UI; a key
 * not translated into `lang` shows in English (T85), without an error.
 */
export function translator(
  lang: Language,
  messages: Readonly<Partial<Record<string, Messages>>> = MESSAGES,
): Translate {
  const own: Readonly<Record<string, string | undefined>> = messages[lang] ?? {};
  const english: Readonly<Record<string, string | undefined>> = MESSAGES.en;
  return (key, params) => {
    const template = own[key] ?? english[key];
    if (template === undefined) {
      console.error(`i18n: no message for key "${key}" (${lang})`);
      return key;
    }
    return template.replace(/\{(\w+)\}/g, (m, name: string) =>
      params !== undefined && name in params ? String(params[name]) : m,
    );
  };
}

/** A UI string in every language that has it (T86): for texts the main process hands to the UI. */
export function catalogText(
  key: MessageKey,
  params?: Readonly<Record<string, string | number>>,
): UiText {
  const out: { -readonly [L in Language]?: string } = {};
  for (const l of LANGUAGE_IDS) {
    if (l === 'en' || MESSAGES[l]?.[key] !== undefined) out[l] = translator(l)(key, params);
  }
  return { ...out, en: translator('en')(key, params) };
}

export const phaseKey = (p: FlightPhase): MessageKey => `phase.${p}`;
export const systemKey = (c: SystemCode): MessageKey => `sys.${c}`;
export const errorKey = (c: ErrorCode): MessageKey => `err.${c}`;
export const reasonKey = (r: ErrorReason): MessageKey => `why.${r}`;

/** An error in the UI language (U-14): the reason code when main sent one, else its detail. */
export function errorText(
  t: Translate,
  e: Pick<AppError, 'code' | 'detail' | 'reason' | 'params'>,
): string {
  const detail = e.reason === undefined ? e.detail : t(reasonKey(e.reason), withPhase(t, e.params));
  return t(errorKey(e.code), { detail });
}

/** `phase` among error params is a flight phase: shown in the UI language. */
function withPhase(
  t: Translate,
  params: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = { ...params };
  if (out['phase'] !== undefined) out['phase'] = t(phaseKey(out['phase'] as FlightPhase));
  return out;
}

/** Params of a system entry that hold a flight phase; all others (callsigns, ids) are shown as is. */
const PHASE_PARAMS: Readonly<Partial<Record<SystemCode, readonly string[]>>> = {
  phase: ['from', 'to'],
  flight_stopped: ['phase'],
};

/** Text of a system feed entry in the UI language. */
export function systemText(
  t: Translate,
  code: SystemCode,
  params: Readonly<Record<string, string>>,
): string {
  if (code === 'next_ofp_failed') {
    // The error of the next OFP load travels as params: code, detail, reason and its values.
    const { code: c = 'internal', detail = '', reason = '', ...rest } = params;
    const error = errorText(t, {
      code: c as ErrorCode,
      detail,
      ...(reason === '' ? {} : { reason: reason as ErrorReason, params: rest }),
    });
    return t(systemKey(code), { error });
  }
  const out: Record<string, string> = { ...params };
  for (const k of PHASE_PARAMS[code] ?? []) {
    const p = out[k];
    if (p !== undefined) out[k] = t(phaseKey(p as FlightPhase));
  }
  return t(systemKey(code), out);
}
