/**
 * IATA delay codes (T43): what a delay is made of and how the departure / block report codes it.
 *
 * Codes: IATA Airport Handling Manual AHM730, as reproduced in EUROCONTROL CODA Digest
 * "Delays to Air Transport in Europe", September 2012, Annex F "Standard IATA Delay Codes
 * (AHM730)" (eurocontrol.int/archive_download/all/node/9022, checked 2026-10-15). The digest may
 * be copied with EUROCONTROL named as the source, for non-commercial use, unmodified: only the
 * code numbers are used here (the user accepted the non-commercial condition, 2026-10-15).
 *
 * Which code a pilot's reason gets is an assumption (keywords below), as is coding the late
 * start 63 and an unexplained remainder 99.
 */

/** A part of the departure delay: `code` (two digits), `ms` it added. */
export interface DelayPart {
  readonly code: string;
  readonly ms: number;
}

/** Codes of AHM730 the core can produce or a pilot can give (`DELAY 20 41`). */
const KNOWN = new Set([
  ...['06', '09', '11', '12', '13', '14', '15', '16', '17', '18', '19'],
  ...['21', '22', '23', '24', '25', '26', '27', '28', '29'],
  ...['31', '32', '33', '34', '35', '36', '37', '38', '39'],
  ...['41', '42', '43', '44', '45', '46', '47', '48', '51', '52', '55', '56', '57', '58'],
  ...['61', '62', '63', '64', '65', '66', '67', '68', '69'],
  ...['71', '72', '73', '75', '76', '77', '81', '82', '83', '84', '85', '86', '87', '88', '89'],
  ...['91', '92', '93', '94', '95', '96', '97', '98', '99'],
]);

/** Late start of the flight: late crew boarding or departure procedures (63 FT). */
export const LATE_START_CODE = '63';
/** Slot (`set: flight.delay_min`): ATFM due to ATC en-route demand/capacity (81 AT). */
export const SLOT_CODE = '81';
/** Delay without a known cause: other reason (99 MX). */
export const OTHER_CODE = '99';

/** Reason word → code; the first word of the reason that matches wins (assumption). */
const WORDS: Readonly<Record<string, string>> = {
  ATC: '81',
  SLOT: '81',
  ATFM: '81',
  FLOW: '81',
  CTOT: '81',
  WX: '71',
  WEATHER: '71',
  DEICE: '75',
  DEICING: '75',
  ICE: '75',
  SNOW: '75',
  TECH: '41',
  TECHNICAL: '41',
  DEFECT: '41',
  MEL: '41',
  MAINT: '41',
  MAINTENANCE: '41',
  ENGINEER: '41',
  ENGINEERING: '41',
  FUEL: '36',
  FUELING: '36',
  FUELLING: '36',
  REFUEL: '36',
  REFUELING: '36',
  REFUELLING: '36',
  CATERING: '37',
  CLEANING: '35',
  BOARDING: '15',
  PAX: '15',
  PASSENGER: '15',
  PASSENGERS: '15',
  BAG: '18',
  BAGS: '18',
  BAGGAGE: '18',
  LOADING: '32',
  CARGO: '32',
  LOADSHEET: '31',
  PAPERWORK: '31',
  DOCS: '31',
  CREW: '63',
  PUSHBACK: '39',
  PUSH: '39',
  TUG: '39',
  GPU: '39',
  SECURITY: '85',
  CUSTOMS: '86',
  IMMIGRATION: '86',
  GATE: '87',
  STAND: '87',
  ROTATION: '93',
  INBOUND: '93',
};

/** Code of a pilot's `DELAY` reason: a code given first, else a keyword, else 99. */
export function reasonCode(reason: string | null): string {
  const words = (reason ?? '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  const first = words[0];
  if (first !== undefined && KNOWN.has(first)) return first;
  for (const w of words) {
    const code = WORDS[w];
    if (code !== undefined) return code;
  }
  return OTHER_CODE;
}

const hhmm = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}${String(min % 60).padStart(2, '0')}`;

/**
 * Delay element of a movement message (`DL81/63/0025/0010`, one code `DL81/0025`): up to two
 * codes, then a four-digit hhmm duration for each (MVT, IATA AHM780, as described in OAG "MVT,
 * MVA & DIV Message Types and Examples", checked 2026-10-15) for an off-block `delayMin` minutes after STD; null when not late. The parts
 * are taken largest first (same code summed) until the delay is used up; what they do not
 * explain is 99. Only the two largest are shown, as in MVT.
 */
export function delayLine(parts: readonly DelayPart[], delayMin: number): string | null {
  if (!(delayMin >= 1)) return null;
  const byCode = new Map<string, number>();
  for (const p of parts) byCode.set(p.code, (byCode.get(p.code) ?? 0) + p.ms);
  const sorted = [...byCode].sort((a, b) => b[1] - a[1]);
  const out: [string, number][] = [];
  let left = delayMin;
  for (const [code, ms] of sorted) {
    if (left <= 0) break;
    const min = Math.min(left, Math.round(ms / 60_000));
    if (min <= 0) continue;
    out.push([code, min]);
    left -= min;
  }
  if (left > 0) {
    const other = out.find(([c]) => c === OTHER_CODE);
    if (other !== undefined) other[1] += left;
    else out.push([OTHER_CODE, left]);
  }
  const shown = out.sort((a, b) => b[1] - a[1]).slice(0, 2);
  return `DL${[...shown.map(([c]) => c), ...shown.map(([, m]) => hhmm(m))].join('/')}`;
}
