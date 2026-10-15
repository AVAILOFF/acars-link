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
 * Runway needs by aircraft family: the landing distance at maximum landing weight, sea level, of
 * the manufacturers' airport-planning documents (Airbus AC, Boeing D6-58326-x), and the width the
 * documents give for the type's code letter.
 *
 * `[ПРОВЕРИТЬ]` EMPTY on purpose (2026-10-15): the figures are read from charts of those PDFs and
 * were not checked yet — none is written from memory. A family without an entry gets no reserve
 * airport: the OFP's airports only, as before T50. Add `family: { lengthM, widthM }` here with the
 * document, revision and date next to each.
 */
export const RUNWAY_NEEDS: Readonly<Partial<Record<AircraftFamily, RunwayNeed>>> = {};

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

/** Position of an airport the core knows: the OFP's or a reserve one; null for any other. */
export function airportPlace(
  ofp: Ofp,
  reserve: readonly DivertAirport[] | undefined,
  icao: string,
): (Place & { readonly icao: string }) | null {
  const o = [ofp.origin, ofp.destination, ...ofp.alternates].find((a) => a.icao === icao);
  if (o !== undefined) return o;
  return (reserve ?? []).find((a) => a.icao === icao) ?? null;
}

/** The runway need of an aircraft type (ICAO designator), undefined when the table has none. */
export function runwayNeedFor(aircraftIcao: string | null | undefined): RunwayNeed | undefined {
  const family = aircraftInfo(aircraftIcao)?.family;
  return family === undefined ? undefined : RUNWAY_NEEDS[family];
}
