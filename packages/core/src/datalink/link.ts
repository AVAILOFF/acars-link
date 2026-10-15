import { distanceNm, type LatLon } from '../geo/geo.js';
import { createRng, type Rng, type RngState, rngFromState } from '../random/rng.js';
import type { OutboundMessage } from '../scenario/engine.js';

/**
 * The data link between the aircraft and the ground (T31): a VHF station in line of sight, or an
 * Inmarsat satellite, and the delivery delay of every message through it.
 *
 * Assumptions approved by the user on 2026-10-15 (docs/07 T31, A1–A3, A5, A8):
 * - A1/A2: there is no open list of real SITA/ARINC stations. The "station" is the nearest
 *   airport of the route corridor (OurAirports) that is within the radio horizon
 *   `1.23·√h` NM (h = altitude in feet), at most {@link VHF_MAX_RANGE_NM}. The pilot sees it
 *   as a conditional station, never as a real one. On the ground the range is
 *   {@link VHF_GROUND_RANGE_NM} (the horizon formula gives 0 at sea level; clarification of A2).
 * - A3: the Inmarsat satellite with the highest elevation above {@link MIN_ELEVATION_DEG}; the
 *   real network assigns stations by its own plan (no coverage tables found).
 * - A5: the delays are constants without a source ({@link DELAY_MS}), with a deterministic
 *   jitter from the seeded Rng.
 * No Iridium (A4/A6/A10: a separate card).
 */

/** An airport used as a conditional VHF station (OurAirports, T31). */
export interface VhfStation {
  readonly icao: string;
  readonly lat: number;
  readonly lon: number;
}

/** Geostationary Inmarsat satellites by sub-satellite longitude (docs/07 T31, A3). */
export interface InmarsatSatellite {
  readonly id: string;
  /** Degrees east, negative = west. */
  readonly lon: number;
}

/**
 * Ocean-region and I-4 positions (FCC question pool, hamstudy, FAA 2009; checked 2026-10-15).
 * Slots move over the years: `[ПРОВЕРИТЬ]` against the operator before a public release.
 */
export const INMARSAT_SATELLITES: readonly InmarsatSatellite[] = [
  { id: 'AOR-W', lon: -54 },
  { id: 'AOR-E', lon: -15.5 },
  { id: 'IOR', lon: 64.5 },
  { id: 'POR', lon: 178 },
  { id: 'AMER', lon: -98 },
  { id: 'EMEA', lon: 25 },
  { id: 'APAC', lon: 143.5 },
];

export const VHF_MAX_RANGE_NM = 200;
export const VHF_GROUND_RANGE_NM = 20;
/** Stations farther than this from the planned route are not used (and not recorded). */
export const VHF_CORRIDOR_NM = 300;
export const MIN_ELEVATION_DEG = 5;

/** Delivery delay range per link, ms (A5: no source, configurable constants). */
export const DELAY_MS = {
  vhf: { min: 2_000, max: 10_000 },
  satcom: { min: 5_000, max: 30_000 },
} as const;

export type LinkKind = 'vhf' | 'satcom';

/** Where the aircraft is, for choosing a link. */
export interface LinkPosition extends LatLon {
  readonly altFt: number;
  readonly onGround: boolean;
}

/** The link in use. */
export interface LinkChoice {
  readonly kind: LinkKind;
  /** ICAO of the conditional station (`vhf`) or the satellite id (`satcom`). */
  readonly station: string;
  /** Distance to the station, NM (`vhf`). */
  readonly distNm: number | null;
  /** Elevation of the satellite, degrees (`satcom`). */
  readonly elevDeg: number | null;
}

/** Radio horizon to a station on the ground for an aircraft at `altFt`, NM (A2). */
export function vhfRangeNm(altFt: number, onGround: boolean): number {
  if (onGround) return VHF_GROUND_RANGE_NM;
  return Math.min(VHF_MAX_RANGE_NM, 1.23 * Math.sqrt(Math.max(0, altFt)));
}

const EARTH_RADIUS_KM = 6378.137;
const GEO_RADIUS_KM = 42164.17;
const RAD = Math.PI / 180;

/** Elevation of a geostationary satellite at `satLon` seen from `pos`, degrees (negative = below the horizon). */
export function geoElevationDeg(pos: LatLon, satLon: number): number {
  const cosGamma = Math.cos(pos.lat * RAD) * Math.cos((satLon - pos.lon) * RAD);
  const sinGamma = Math.sqrt(Math.max(0, 1 - cosGamma * cosGamma));
  return Math.atan2(cosGamma - EARTH_RADIUS_KM / GEO_RADIUS_KM, sinGamma) / RAD;
}

/**
 * The link for `pos`: VHF first (the nearest station inside its range, ties to the earlier
 * ICAO), then, with SATCOM, the satellite with the highest elevation; null = no link.
 */
export function chooseLink(
  pos: LinkPosition,
  stations: readonly VhfStation[],
  satcom: boolean,
): LinkChoice | null {
  const range = vhfRangeNm(pos.altFt, pos.onGround);
  let best: { s: VhfStation; d: number } | null = null;
  for (const s of stations) {
    const d = distanceNm(pos, s);
    if (d > range) continue;
    if (best === null || d < best.d || (d === best.d && s.icao < best.s.icao)) best = { s, d };
  }
  if (best !== null) {
    return { kind: 'vhf', station: best.s.icao, distNm: Math.round(best.d), elevDeg: null };
  }
  if (!satcom) return null;
  let sat: { id: string; elev: number } | null = null;
  for (const s of INMARSAT_SATELLITES) {
    const elev = geoElevationDeg(pos, s.lon);
    if (elev >= MIN_ELEVATION_DEG && (sat === null || elev > sat.elev)) sat = { id: s.id, elev };
  }
  return sat === null
    ? null
    : { kind: 'satcom', station: sat.id, distNm: null, elevDeg: Math.round(sat.elev) };
}

/** How a message went through the link (on `OutboundMessage.link`). */
export interface DeliveryInfo {
  readonly kind: LinkKind;
  readonly station: string;
  /** Delay added by the link, ms. */
  readonly delayMs: number;
  /** Time the message waited for any link at all, ms (0 = a link was there). */
  readonly waitedMs: number;
}

/** What the window of the app shows (T32): the link now and the messages on it. */
export interface LinkView {
  readonly link: LinkChoice | null;
  /** Waiting for a link. */
  readonly held: number;
  /** On the way (delay not over). */
  readonly inFlight: number;
}

interface Held {
  readonly msg: OutboundMessage;
  readonly since: number;
}

interface Flying {
  readonly msg: OutboundMessage;
  readonly due: number;
  readonly info: DeliveryInfo;
}

export interface DatalinkState {
  readonly held: readonly Held[];
  readonly flying: readonly Flying[];
  readonly rng: RngState;
  readonly lastDue: number;
  readonly choice: LinkChoice | null;
}

/**
 * Holds the messages of the core back for the delay of the link. FIFO: a message never arrives
 * before the one sent earlier. No link (no station in range, no SATCOM or no satellite) = the
 * message waits in the queue, as ACARS holds uplink/downlink traffic. Without a known position
 * (no telemetry yet) messages pass untouched.
 */
export class LinkChannel {
  private held: Held[] = [];
  private flying: Flying[] = [];
  private lastDue = 0;
  private choice: LinkChoice | null = null;
  private readonly rng: Rng;

  constructor(
    private readonly satcom: boolean,
    seed: number | string,
    state?: DatalinkState,
  ) {
    this.rng = state === undefined ? createRng(`${seed}/#link`) : rngFromState(state.rng);
    if (state !== undefined) {
      const copy = JSON.parse(JSON.stringify(state)) as DatalinkState;
      this.held = [...copy.held];
      this.flying = [...copy.flying];
      this.lastDue = copy.lastDue;
      this.choice = copy.choice;
    }
  }

  get view(): LinkView {
    return { link: this.choice, held: this.held.length, inFlight: this.flying.length };
  }

  getState(): DatalinkState {
    return JSON.parse(
      JSON.stringify({
        held: this.held,
        flying: this.flying,
        rng: this.rng.getState(),
        lastDue: this.lastDue,
        choice: this.choice,
      }),
    ) as DatalinkState;
  }

  /** One tick: takes the fresh messages, returns those whose delay is over (stamped `now`). */
  process(
    now: number,
    pos: LinkPosition | null,
    stations: readonly VhfStation[],
    fresh: readonly OutboundMessage[],
  ): OutboundMessage[] {
    if (pos === null) {
      this.choice = null;
      // No position yet: nothing to simulate. Whatever waits goes out with the fresh ones.
      const all = [...this.held.map((h) => h.msg), ...fresh];
      this.held = [];
      return all;
    }
    this.choice = chooseLink(pos, stations, this.satcom);
    for (const msg of fresh) this.held.push({ msg, since: now });
    const choice = this.choice;
    if (choice !== null) {
      for (const h of this.held) {
        const r = DELAY_MS[choice.kind];
        const delayMs = this.rng.int(r.min, r.max);
        const due = Math.max(now + delayMs, this.lastDue);
        this.lastDue = due;
        this.flying.push({
          msg: h.msg,
          due,
          info: {
            kind: choice.kind,
            station: choice.station,
            delayMs: due - now,
            waitedMs: now - h.since,
          },
        });
      }
      this.held = [];
    }
    const out: OutboundMessage[] = [];
    while (this.flying.length > 0 && (this.flying[0] as Flying).due <= now) {
      const f = this.flying.shift() as Flying;
      out.push({ ...f.msg, t: now, link: f.info });
    }
    return out;
  }
}
