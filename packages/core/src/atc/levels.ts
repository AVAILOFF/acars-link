// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

/**
 * Cruising levels for the XATC station (T25, docs/07; sources in docs/06 "Эшелоны").
 *
 * Table: SERA Appendix 3 (Regulation (EU) No 923/2012), the same as ICAO Annex 2, App. 3,
 * table a (feet, RVSM FL290–410): odd levels FL10, 30 … 290, 310 … 410, 450, 490; even
 * levels FL20, 40 … 280, 300 … 400, 430, 470, 510. Which tracks fly odd levels is the
 * state's rule:
 * - ICAO / SERA: magnetic track 000–179 odd, 180–359 even;
 * - Spain (AIP ENR 1.7-3, AMDT 403/26, 19-FEB-26) and Portugal (ENR 1.7.5, 01 OCT 2026):
 *   090–269 odd, 270–089 even; France the same for IFR in the UTA only (AIC A 06/20, from
 *   2020-05-21; the UTA lower limit FL195 is `[ПРОВЕРИТЬ]` against AIP France ENR 1.3.5);
 * - New Zealand FIR (CAA NZ Part 91, amdt 12): 270–089 odd, 090–269 even.
 * Approved (2026-10-09): Italy — ICAO until its ENR 1.7 is read (`[ПРОВЕРИТЬ]`); metric
 * areas (China, DPRK) — the feet table too.
 */

export type LevelRuleId = 'ICAO' | 'SOUTH_ODD' | 'NORTH_ODD';

export interface LevelRule {
  readonly id: LevelRuleId;
  /** Where the rule comes from, for logs and tests. */
  readonly source: string;
}

const ICAO: LevelRule = { id: 'ICAO', source: 'SERA App. 3 / ICAO Annex 2 App. 3' };
const SPAIN: LevelRule = { id: 'SOUTH_ODD', source: 'AIP Spain ENR 1.7-3 (AMDT 403/26)' };
const PORTUGAL: LevelRule = { id: 'SOUTH_ODD', source: 'AIP Portugal ENR 1.7.5' };
const FRANCE_UTA: LevelRule = { id: 'SOUTH_ODD', source: 'AIC France A 06/20 (UTA)' };
const NEW_ZEALAND: LevelRule = { id: 'NORTH_ODD', source: 'CAA NZ Part 91' };

/** Lower limit of the French UTA, ft (`[ПРОВЕРИТЬ]` AIP France ENR 1.3.5 / ENR 2.1). */
export const FRANCE_UTA_FLOOR_FT = 19_500;

/** RVSM band (Doc 4444; SERA App. 3): non-RVSM aircraft are not cleared into it. */
export const RVSM_LOW_FT = 29_000;
export const RVSM_HIGH_FT = 41_000;

/**
 * Rule for a FIR (VATSpy or SimBrief id: `LECM`, `GCCC`, `LPPC`, `LFFF`, `NZZC` …) at a
 * level. Spain covers LE** and the Canarias FIR GCCC; Portugal LP** (Lisboa, Santa Maria).
 */
export function levelRule(fir: string | null, levelFt: number): LevelRule {
  const id = (fir ?? '').toUpperCase();
  if (id.startsWith('LE') || id === 'GCCC') return SPAIN;
  if (id.startsWith('LP')) return PORTUGAL;
  if (id.startsWith('LF') && levelFt >= FRANCE_UTA_FLOOR_FT) return FRANCE_UTA;
  if (id === 'NZZC') return NEW_ZEALAND;
  return ICAO;
}

/** True when the rule gives odd levels on this magnetic track. */
export function oddDirection(rule: LevelRuleId, trackMag: number): boolean {
  const t = ((trackMag % 360) + 360) % 360;
  if (rule === 'SOUTH_ODD') return t >= 90 && t < 270;
  if (rule === 'NORTH_ODD') return t >= 270 || t < 90;
  return t < 180;
}

function table(odd: boolean): readonly number[] {
  const out: number[] = [];
  for (let fl = odd ? 10 : 20; fl <= (odd ? 410 : 400); fl += 20) out.push(fl * 100);
  for (const fl of odd ? [450, 490] : [430, 470, 510]) out.push(fl * 100);
  return out;
}

export const ODD_LEVELS_FT = table(true);
export const EVEN_LEVELS_FT = table(false);

/** Cruising levels of the table for the direction (feet). */
export function tableLevels(rule: LevelRuleId, trackMag: number): readonly number[] {
  return oddDirection(rule, trackMag) ? ODD_LEVELS_FT : EVEN_LEVELS_FT;
}

export type LevelCheck =
  | { readonly ok: true }
  /** `direction` — wrong parity for the track; `airway` — outside the leg's SimBrief levels. */
  | { readonly ok: false; readonly why: 'direction' | 'airway' };

/**
 * Whether `levelFt` is a cruising level here. The parity is ours (table + state rule);
 * SimBrief's `fir_valid_levels` of the current leg adds the airway limits — unless it
 * shares no level with our table (a different rule), then ours alone counts (approved
 * 2026-10-09).
 */
export function checkLevel(
  levelFt: number,
  fir: string | null,
  trackMag: number,
  legLevelsFt: readonly number[] | null,
): LevelCheck {
  const ours = tableLevels(levelRule(fir, levelFt).id, trackMag);
  if (!ours.includes(levelFt)) return { ok: false, why: 'direction' };
  if (legLevelsFt !== null && legLevelsFt.length > 0) {
    const common = ours.filter((l) => legLevelsFt.includes(l));
    if (common.length > 0 && !common.includes(levelFt)) return { ok: false, why: 'airway' };
  }
  return { ok: true };
}

/** `FL350` at or above the transition level (or when FL was asked), else `6000FT`. */
export function levelText(levelFt: number, asFlightLevel: boolean): string {
  return asFlightLevel
    ? `FL${String(Math.round(levelFt / 100)).padStart(3, '0')}`
    : `${Math.round(levelFt)}FT`;
}
