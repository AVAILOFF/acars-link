// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { FlightPhase } from '@acars/core';
import type { AtcView } from './api.js';

/**
 * Aircraft whose `aircraftTitle` matches have no CPDLC through Hoppie: XATC can serve their PDC
 * request (telex) only (docs/07 T49 item 4, decision 2026-10-10). Filled only from a human
 * check or the add-on's documentation, with the date. Empty so far: Fenix A320 has CPDLC (ATC
 * MENU → CONNECTION, checked 2026-10-10); an unknown aircraft gets no hint.
 */
export const NO_CPDLC_AIRCRAFT: readonly RegExp[] = [];

export function lacksCpdlc(
  title: string | undefined,
  list: readonly RegExp[] = NO_CPDLC_AIRCRAFT,
): boolean {
  return title !== undefined && list.some((re) => re.test(title));
}

export interface AtcHint {
  /** i18n key (`atc.*`). */
  readonly key: 'atc.hint' | 'atc.hintFir' | 'atc.hintDcl' | 'atc.noCpdlc' | 'atc.fltNbr';
  readonly params: Readonly<Record<string, string>>;
}

export interface AtcHintInput {
  readonly atc: AtcView | null;
  readonly aircraftTitle: string | undefined;
  readonly phase: FlightPhase | null;
  readonly callsign: string | null;
  readonly noCpdlc?: readonly RegExp[];
}

/**
 * Lines under the Status list (T49): which station takes what, the CPDLC-less aircraft, and the
 * FLT NBR reminder on block. Nothing goes to the network.
 */
export function atcHints(i: AtcHintInput): readonly AtcHint[] {
  const out: AtcHint[] = [];
  const atc = i.atc;
  if (atc !== null) {
    if (lacksCpdlc(i.aircraftTitle, i.noCpdlc)) {
      out.push({ key: 'atc.noCpdlc', params: {} });
    } else if (atc.station !== null && atc.dcl !== null) {
      out.push({ key: 'atc.hint', params: { fir: atc.station, dcl: atc.dcl } });
    } else if (atc.station !== null) {
      out.push({ key: 'atc.hintFir', params: { fir: atc.station } });
    }
    if (atc.dcl !== null && (atc.station === null || lacksCpdlc(i.aircraftTitle, i.noCpdlc))) {
      out.push({ key: 'atc.hintDcl', params: { dcl: atc.dcl } });
    }
  }
  if (i.phase === 'ON_BLOCK' && i.callsign !== null) {
    out.push({ key: 'atc.fltNbr', params: { callsign: i.callsign } });
  }
  return out;
}
