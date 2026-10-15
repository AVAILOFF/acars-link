import type { DivertAirport } from '../ext/data.js';
import { distanceNm } from '../geo/geo.js';
import type { Ofp } from '../ofp/types.js';
import { type AircraftFamily, aircraftInfo } from './aircraft.js';

/**
 * Where a diverting aircraft is sent (T50, docs/07 T50 part B). Candidates are the airports of the
 * OFP the dispatcher picked for the type — the origin and the alternates, the destination left
 * out — and, when the nearest of them is far, a reserve from OurAirports (`DivertAirport`).
 *
 * Rules (approved 2026-10-15):
 * - `ofp`: the nearest candidate of the OFP; if it is farther than {@link DIVERT_RESERVE_NM}, the
 *   nearest suitable reserve airport when that one is closer (PAN, medical, unruly passenger);
 * - `any`: the nearest of all, the reserve included (MAYDAY, fire in the cabin: time matters).
 *
 * `[ПРОВЕРИТЬ]` the OFP's en-route alternates (ERA), ETOPS airports and take-off alternate are not
 * read yet: the structure of `enroute_altn` / `etops` / `takeoff_altn` in the SimBrief JSON is
 * unverified (no OFP with them was available, 2026-10-15). They join {@link ofpCandidates} once
 * parsed.
 */

/** Past this distance to the nearest airport of the OFP a reserve airport is looked for, NM. */
export const DIVERT_RESERVE_NM = 250;

/** What a runway must offer for a type. */
export interface RunwayNeed {
  /** Length of the runway, m. */
  readonly lengthM: number;
  /** Width, m. */
  readonly widthM: number;
  /** Only a `large_airport` (the A380: OurAirports has no code F, so size stands in). */
  readonly large?: boolean;
}

/**
 * Runway needs by aircraft family (approved by the user 2026-10-15, docs/07 T50):
 * - length: the landing field length of the manufacturers' airport-planning documents for the
 *   family's member with the longest one — dry runway, sea level (ISA), at its maximum landing
 *   weight, Boeing with flaps 30 — read off the chart and rounded up to 50 m. The documents give
 *   these curves "for information only"; the readings were taken on 2026-10-15 (Airbus: from the
 *   vector curves of the PDF, Boeing: from the pixels of the chart image, about ±10 m);
 * - width: a game rule, not Annex 14 (not openly available): 45 m for wide-bodies, 30 m for the
 *   rest; the A380 also needs a `large_airport`.
 *
 * The regional families (E-Jet, CRJ, ATR, DH8) have no entry: no open document was checked, so
 * they get the OFP's airports only, as before T50. The 777X (B778, B779) is not in the 777 figure
 * (its ACAP was not read).
 */
export const RUNWAY_NEEDS: Readonly<Partial<Record<AircraftFamily, RunwayNeed>>> = {
  // Airbus AC A321 Rev. 35 (Jul 01/26), FIGURE-3-4-1-991-007-A01: A321-200 CFM56, MLW 77.8 t,
  // ≈ 1749 m (A321neo LEAP, MLW 79.2 t: ≈ 1598 m).
  A320: { lengthM: 1750, widthM: 30 },
  // Airbus AC A330 Rev. 34 (Dec 01/25), FIGURE-3-4-1-991-017-A01: A330-900, MLW 191 t, ≈ 1950 m
  // (A330-300, 187 t: ≤ 1752 m; A330-800, 186 t: ≈ 1877 m).
  A330: { lengthM: 1950, widthM: 45 },
  // Airbus AC A350 Rev. 17 (Jul 01/26), FIGURE-3-4-0-991-002-B01: A350-1000, MLW 236 t, ≈ 2112 m.
  A350: { lengthM: 2150, widthM: 45 },
  // Airbus AC A380 Rev. 20 (Dec 01/25), FIGURE-3-4-1-991-001-A01: A380-800, MLW 395 t, ≈ 1930 m.
  A380: { lengthM: 1950, widthM: 45, large: true },
  // Boeing D6-38A004 (737 MAX) Rev K (Jul 2025), 3.4.11, 737-10 flaps 30, MLW 75 931 kg: ≈ 1787 m
  // (D6-58325-7 (737NG) Rev C (Oct 2025), 3.4.5, 737-900ER flaps 30, MLW 71 350 kg: ≈ 1700 m).
  B737: { lengthM: 1800, widthM: 30 },
  // Boeing D6-58326-3 (747-8) Rev E (Jan 2026), 3.4.1, 747-8F flaps 30, MLW 346 091 kg: ≈ 2242 m
  // (747-8, MLW 312 072 kg: ≈ 1978 m).
  B747: { lengthM: 2250, widthM: 45 },
  // Boeing D6-58329-2 (777-200LR/-300ER/F) Rev G (Dec 2024), 3.4.6, 777-300ER flaps 30, MLW 251 290 kg:
  // ≈ 1859 m (777F GE90-115BL, MLW 260 815 kg: ≈ 1758 m).
  B777: { lengthM: 1900, widthM: 45 },
  // Boeing D6-58333 (787) Rev Q (Oct 2025), 3.4.5, 787-10 flaps 30, MLW 201 848 kg: ≈ 1850 m.
  B787: { lengthM: 1900, widthM: 45 },
};

export interface Place {
  readonly lat: number;
  readonly lon: number;
}

export interface DivertChoice {
  readonly icao: string;
  readonly nm: number;
  readonly lat: number;
  readonly lon: number;
}

/** The OFP's own candidates: origin and alternates, the destination excluded, no repeats. */
export function ofpCandidates(ofp: Ofp): readonly (Place & { readonly icao: string })[] {
  const out: (Place & { readonly icao: string })[] = [];
  for (const a of [ofp.origin, ...ofp.alternates]) {
    if (a.icao === ofp.destination.icao || out.some((x) => x.icao === a.icao)) continue;
    out.push(a);
  }
  return out;
}

/** Reserve airports a type can land at: runway long and wide enough, not an OFP airport. */
export function suitableReserve(
  list: readonly DivertAirport[],
  need: RunwayNeed | undefined,
  exclude: ReadonlySet<string>,
): readonly DivertAirport[] {
  if (need === undefined) return [];
  return list.filter(
    (a) =>
      !exclude.has(a.icao) &&
      a.rwyM >= need.lengthM &&
      (a.widthM === null || a.widthM >= need.widthM) &&
      (need.large !== true || a.large),
  );
}

function nearest<T extends Place & { readonly icao: string }>(
  pos: Place,
  list: readonly T[],
): { readonly apt: T; readonly nm: number } | null {
  let best: { apt: T; nm: number } | null = null;
  for (const apt of list) {
    const nm = distanceNm(pos, apt);
    // Ties go to the earlier in the list (the OFP's order), then by code: deterministic.
    if (best === null || nm < best.nm || (nm === best.nm && apt.icao < best.apt.icao)) {
      best = { apt, nm };
    }
  }
  return best;
}

export function pickDivert(input: {
  readonly pos: Place;
  readonly ofp: Ofp;
  readonly reserve: readonly DivertAirport[] | undefined;
  readonly family: AircraftFamily | null;
  readonly mode: 'ofp' | 'any';
  readonly needs?: Readonly<Partial<Record<AircraftFamily, RunwayNeed>>>;
}): DivertChoice | null {
  const own = ofpCandidates(input.ofp);
  const ofpNearest = nearest(input.pos, own);
  const need = input.family === null ? undefined : (input.needs ?? RUNWAY_NEEDS)[input.family];
  const skip = new Set([input.ofp.destination.icao, ...own.map((a) => a.icao)]);
  const reserveNearest = nearest(
    input.pos,
    suitableReserve(input.reserve ?? [], need, skip).map((a) => ({ ...a })),
  );
  const take = (x: { apt: Place & { readonly icao: string }; nm: number } | null) =>
    x === null ? null : { icao: x.apt.icao, nm: Math.round(x.nm), lat: x.apt.lat, lon: x.apt.lon };
  if (reserveNearest === null) return take(ofpNearest);
  if (ofpNearest === null) return take(reserveNearest);
  if (input.mode === 'any') {
    return take(reserveNearest.nm < ofpNearest.nm ? reserveNearest : ofpNearest);
  }
  return take(
    ofpNearest.nm > DIVERT_RESERVE_NM && reserveNearest.nm < ofpNearest.nm
      ? reserveNearest
      : ofpNearest,
  );
}

/**
 * Position of an airport the core knows: the OFP's, a reserve one or one the pilot named and the
 * app looked up (`places`, T51); null for any other.
 */
export function airportPlace(
  ofp: Ofp,
  reserve: readonly DivertAirport[] | undefined,
  icao: string,
  places?: Readonly<Record<string, Place | null>>,
): (Place & { readonly icao: string }) | null {
  const o = [ofp.origin, ofp.destination, ...ofp.alternates].find((a) => a.icao === icao);
  if (o !== undefined) return o;
  const r = (reserve ?? []).find((a) => a.icao === icao);
  if (r !== undefined) return r;
  const p = places?.[icao];
  return p == null ? null : { icao, lat: p.lat, lon: p.lon };
}

/** The runway need of an aircraft type (ICAO designator), undefined when the table has none. */
export function runwayNeedFor(aircraftIcao: string | null | undefined): RunwayNeed | undefined {
  const family = aircraftInfo(aircraftIcao)?.family;
  return family === undefined ? undefined : RUNWAY_NEEDS[family];
}
