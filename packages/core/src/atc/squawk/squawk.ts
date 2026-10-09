import type { Rng } from '../../random/rng.js';
import { EUR_CAL_PAS, EUR_CAL_ROWS } from './eur-cal.js';
import { FAA_NBCAP_ARTCC } from './faa-nbcap.js';
import { ICAO_APAC_FIRS } from './icao-apac.js';

/**
 * Transponder code of a departure clearance (T24, docs/07): from the regional allocation tables
 * — EUR: EUROCONTROL CAL (ORCAM/CCAMS), US: FAA NBCAP (ARTCC blocks), Asia/Pacific: ICAO APAC
 * eANP — and a random code elsewhere (approved 2026-10-09). Rules (approved, docs/07 T24):
 * - never a special-purpose code ({@link SPECIAL_CODES}) and never a code ending in `00`;
 * - EUR: assignment rows whose units contain the departure state prefix, airport or FIR;
 *   destination `ALL` or matching; rows whose protection or via concerns the destination or a
 *   FIR of the route are left out;
 * - US: departure ARTCC = the airport's FIR (`KZNY` → ZNY, `PAZA` → ZAN); internal blocks when
 *   the destination is in the same ARTCC, else external; primary blocks first;
 * - APAC: the FIR's international or domestic blocks (domestic = same country); restricted
 *   blocks (notes 11–16) are not used; Australia/New Zealand domestic: any code except the
 *   FIR's international blocks.
 * Pure: the caller passes a seeded Rng (invariant 4).
 */

/**
 * Codes never handed out, with sources (checked 2026-10-09):
 * - 7500, 7600, 7700 (unlawful interference, radio failure, emergency) — SERA.13005 (EU
 *   923/2012), FAA NBCAP TBL A-1 ("reserved internationally"); 7501–7577, 7601–7607,
 *   7701–7707 — NBCAP TBL A-1 (reserved/allocated);
 * - 2000 (no ATC instruction, entering SSR airspace) and 7000 (VFR conspicuity) — SERA.13005;
 * - 1000 (Mode S conspicuity) — ICAO APAC eANP Vol II Part IV 3.6; not assigned for now (user
 *   decision 2026-10-09, docs/07 T24);
 * - 1200 (US VFR), 0000 ("must never be assigned by ATC"), 7400 (UAS lost link), 7777
 *   (reserved) — FAA NBCAP 8.d and TBL A-1.
 */
export const SPECIAL_CODES: ReadonlySet<string> = new Set([
  '0000',
  '1000',
  '1200',
  '2000',
  '7000',
  '7400',
  '7500',
  '7600',
  '7700',
  '7777',
  ...range('7501', '7577'),
  ...range('7601', '7607'),
  ...range('7701', '7707'),
]);

export type SquawkSource = 'eur-cal' | 'faa-nbcap' | 'icao-apac' | 'random';

export interface SquawkFlight {
  readonly origin: string;
  readonly destination: string;
  /** FIR of the departure airport (VATSpy `[Airports]`), null when unknown. */
  readonly originFir: string | null;
  readonly destinationFir: string | null;
  /** FIRs along the route, for the CAL protection and via columns. */
  readonly routeFirs: readonly string[];
  /** Country names (VATSpy `[Countries]`), null when unknown. */
  readonly originCountry: string | null;
  readonly destinationCountry: string | null;
}

export interface SquawkPlan {
  readonly source: SquawkSource;
  /** Codes the rule allows (sorted, special codes and xx00 removed); never empty. */
  readonly codes: readonly string[];
  /** Which table part was used, for logs and tests (`ZMP external EP`, `EUR-B 01 20-37` …). */
  readonly rule: string;
}

export interface Squawk {
  readonly code: string;
  readonly source: SquawkSource;
  readonly rule: string;
}

/** Allowed codes for a flight: the first table that has any, else every assignable code. */
export function squawkPlan(f: SquawkFlight): SquawkPlan {
  return usPlan(f) ?? eurPlan(f) ?? apacPlan(f) ?? randomPlan();
}

export function assignSquawk(f: SquawkFlight, rng: Rng): Squawk {
  const plan = squawkPlan(f);
  const code = plan.codes[rng.int(0, plan.codes.length - 1)] as string;
  return { code, source: plan.source, rule: plan.rule };
}

/** True when a code may be handed out at all. */
export function assignable(code: string): boolean {
  return /^[0-7]{4}$/.test(code) && !code.endsWith('00') && !SPECIAL_CODES.has(code);
}

function range(from: string, to: string): string[] {
  const out: string[] = [];
  for (let c = Number.parseInt(from, 8); c <= Number.parseInt(to, 8); c++) {
    out.push(c.toString(8).padStart(4, '0'));
  }
  return out;
}

const finish = (codes: Iterable<string>): string[] => [...new Set(codes)].filter(assignable).sort();

// --- US: FAA NBCAP ---

function artccOf(fir: string | null): string | null {
  if (fir === null) return null;
  if (/^KZ[A-Z]{2}$/.test(fir)) return fir.slice(1);
  if (fir === 'PAZA') return 'ZAN';
  return null;
}

function usPlan(f: SquawkFlight): SquawkPlan | null {
  const artcc = artccOf(f.originFir);
  const rows = artcc === null ? undefined : FAA_NBCAP_ARTCC[artcc];
  if (rows === undefined) return null;
  const internal = artccOf(f.destinationFir) === artcc;
  const cat = internal ? 'I' : 'E';
  const of = (prio: (p: string) => boolean) =>
    finish(
      rows
        .filter(([, , p]) => prio(p))
        .flatMap(([from, to]) =>
          to === null ? range(`${from.slice(0, 2)}01`, `${from.slice(0, 2)}77`) : range(from, to),
        ),
    );
  // Primary blocks first (EP-n / IP-n), else every block of the category (ZAN has no P/S/T).
  const primary = of((p) => p.startsWith(`${cat}P`));
  const all = primary.length > 0 ? primary : of((p) => p === cat || p.startsWith(cat));
  if (all.length === 0) return null;
  return {
    source: 'faa-nbcap',
    codes: all,
    rule: `${artcc} ${internal ? 'internal' : 'external'}${primary.length > 0 ? ' primary' : ''}`,
  };
}

// --- EUR: EUROCONTROL CAL ---

const tokens = (s: string): string[] => (s === '' ? [] : s.split(' '));

/** A token names the airport (`ALL`, its ICAO/FIR, state prefix, 1-letter region, a PA). */
function names(tokenList: readonly string[], icao: string, fir: string | null): boolean {
  return tokenList.some((t) => {
    const u = t.toUpperCase();
    if (u === 'ALL' || u === icao || u === fir || u === icao.slice(0, 2)) return true;
    if (u.length === 1 && u === icao[0]) return true;
    const pa = EUR_CAL_PAS[u];
    return pa !== undefined && (pa.includes(icao.slice(0, 2)) || pa.includes(icao));
  });
}

function eurPlan(f: SquawkFlight): SquawkPlan | null {
  const units = EUR_CAL_ROWS.filter(([, , , u]) => names(tokens(u), f.origin, f.originFir));
  if (units.length === 0) return null;
  const route = f.routeFirs;
  const rows = units.filter(([, , , , dest, via, prot]) => {
    if (!names(tokens(dest), f.destination, f.destinationFir)) return false;
    const p = tokens(prot);
    if (
      p.length > 0 &&
      (names(p, f.destination, f.destinationFir) || route.some((r) => names(p, r, r)))
    ) {
      return false;
    }
    const v = tokens(via);
    return v.length === 0 || route.some((r) => names(v, r, r));
  });
  const codes = finish(rows.flatMap(([from, to]) => range(from, to)));
  if (codes.length === 0) return null;
  return { source: 'eur-cal', codes, rule: `${rows.length} rows` };
}

// --- Asia/Pacific: ICAO APAC eANP ---

const AU_NZ = new Set(['BRISBANE', 'MELBOURNE', 'NEW ZEALAND']);

function apacPlan(f: SquawkFlight): SquawkPlan | null {
  const fir = f.originFir;
  if (fir === null) return null;
  const entry = Object.entries(ICAO_APAC_FIRS).find(([, e]) => e.firs.includes(fir));
  if (entry === undefined) return null;
  const [name, e] = entry;
  const domestic = f.originCountry !== null && f.originCountry === f.destinationCountry ? 'D' : 'I';
  const usable = e.blocks.filter(([, , , note]) => note === null);
  let codes: string[];
  if (domestic === 'D' && AU_NZ.has(name)) {
    // Note `*`: all codes for domestic use, except where indicated (the international blocks).
    const intl = new Set(e.blocks.filter(([, , k]) => k === 'I').flatMap(([a, b]) => range(a, b)));
    codes = finish(range('0001', '7777').filter((c) => !intl.has(c)));
  } else {
    codes = finish(usable.filter(([, , k]) => k === domestic).flatMap(([a, b]) => range(a, b)));
  }
  if (codes.length === 0) return null;
  return {
    source: 'icao-apac',
    codes,
    rule: `${name} ${domestic === 'D' ? 'domestic' : 'international'}`,
  };
}

function randomPlan(): SquawkPlan {
  return { source: 'random', codes: finish(range('0001', '7777')), rule: 'no table' };
}
