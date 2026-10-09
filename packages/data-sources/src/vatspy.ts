import {
  type CenterStation,
  distanceNm,
  type FirArea,
  FirMap,
  interpolate,
  type LatLon,
  type Ofp,
} from '@acars/core';
import {
  DataSourceError,
  expectOk,
  type FetchContext,
  ICAO_RE,
  isObj,
  parseJson,
  request,
} from './common.js';

/**
 * FIR boundaries for the ROPS station (T23, docs/06 "Границы FIR"): VATSpy Data Project,
 * `https://github.com/vatsimnetwork/vatspy-data-project` (licence CC BY-SA 4.0, checked
 * 2026-10-09, release v2610.1). Approved as an approximation of the real FIRs (docs/07 T23):
 * downloaded and cached by the app, not stored in the repository.
 *
 * - `Boundaries.geojson` (RFC 7946, ~2.2 MB): one MultiPolygon feature per area, properties
 *   `id` (`EDGG`, sectors `EDGG-N`), `oceanic` (`"0"`/`"1"`), `label_lon`/`label_lat`,
 *   `region`, `division`. Polygons are split at the antimeridian. Some ids appear twice
 *   (`KZNY` land and oceanic): merged. Only 4-letter ids are FIRs (approved: no sectors).
 * - `VATSpy.dat` (~0.9 MB, text): `[FIRs]` lines `ICAO|NAME|CALLSIGN PREFIX|FIR BOUNDARY`
 *   (empty prefix = the ICAO code), `[UIRs]` lines `ID|NAME|FIR,FIR,…`, `[Airports]` lines
 *   `ICAO|NAME|LAT|LON|IATA/LID|FIR|IsPseudo`. Used for the unit names, to find which FIR an
 *   online VATSIM centre covers and which areas are FIRs of airports: VATSpy also has overlay
 *   areas without airports (`EGVV` Swanwick Military over the UK, `EDXX` FIS only over
 *   Germany) that must not win over the FIR (`FirArea.airports`, `FirMap`).
 */

const BASE = 'https://raw.githubusercontent.com/vatsimnetwork/vatspy-data-project/master';
export const VATSPY_BOUNDARIES_URL = `${BASE}/Boundaries.geojson`;
export const VATSPY_DAT_URL = `${BASE}/VATSpy.dat`;

/** Everything the app keeps from VATSpy (cached as JSON). */
export interface VatspyData {
  /** All FIRs, by id. */
  readonly firs: readonly FirArea[];
  /** VATSIM callsign prefix (`EDGG`, `EDGG_DKB`, `LON`) → FIR ids it covers. */
  readonly prefixes: Readonly<Record<string, readonly string[]>>;
  /** Airport ICAO → its FIR (`[Airports]`, pseudo entries left out). */
  readonly airports: Readonly<Record<string, string>>;
}

/** Coordinates are kept to 5 decimals (~1 m): smaller cache and recordings. */
const round = (x: number) => Math.round(x * 1e5) / 1e5;

export async function fetchVatspy(ctx: FetchContext): Promise<VatspyData> {
  const geo = await request(ctx, VATSPY_BOUNDARIES_URL);
  expectOk(geo, 'VATSpy boundaries');
  const dat = await request(ctx, VATSPY_DAT_URL);
  expectOk(dat, 'VATSpy.dat');
  return buildVatspy(parseJson(geo.body, 'VATSpy boundaries'), dat.body);
}

export function buildVatspy(geojson: unknown, dat: string): VatspyData {
  const areas = parseBoundaries(geojson);
  const { names, prefixes, airports } = parseVatspyDat(dat);
  const withAirports = new Set(Object.values(airports));
  const firs = [...areas.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, a]) => ({
      id,
      name: names[id] ?? id,
      oceanic: a.oceanic,
      airports: withAirports.has(id),
      polygons: a.polygons,
    }));
  if (firs.length === 0) throw new DataSourceError('VATSpy: no FIR boundaries');
  return { firs, prefixes, airports };
}

type Polygons = FirArea['polygons'];

export function parseBoundaries(
  json: unknown,
): Map<string, { oceanic: boolean; polygons: Polygons }> {
  if (!isObj(json) || !Array.isArray(json['features'])) {
    throw new DataSourceError('VATSpy boundaries: no features[]');
  }
  const out = new Map<string, { oceanic: boolean; polygons: Polygons }>();
  for (const f of json['features'] as unknown[]) {
    if (!isObj(f) || !isObj(f['properties']) || !isObj(f['geometry'])) continue;
    const id = f['properties']['id'];
    if (typeof id !== 'string' || !ICAO_RE.test(id)) continue;
    const g = f['geometry'];
    const coords =
      g['type'] === 'MultiPolygon'
        ? g['coordinates']
        : g['type'] === 'Polygon'
          ? [g['coordinates']]
          : null;
    const polygons = toPolygons(coords);
    if (polygons.length === 0) continue;
    const prev = out.get(id);
    out.set(id, {
      oceanic: (prev?.oceanic ?? false) || f['properties']['oceanic'] === '1',
      polygons: [...(prev?.polygons ?? []), ...polygons],
    });
  }
  return out;
}

function toPolygons(x: unknown): Polygons {
  if (!Array.isArray(x)) return [];
  const out: [number, number][][][] = [];
  for (const poly of x) {
    if (!Array.isArray(poly)) continue;
    const rings: [number, number][][] = [];
    for (const ring of poly) {
      if (!Array.isArray(ring)) continue;
      const pts: [number, number][] = [];
      for (const p of ring) {
        if (!Array.isArray(p) || typeof p[0] !== 'number' || typeof p[1] !== 'number') continue;
        if (!(Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90)) continue;
        pts.push([round(p[0]), round(p[1])]);
      }
      if (pts.length >= 4) rings.push(pts);
    }
    if (rings.length > 0) out.push(rings);
  }
  return out;
}

export function parseVatspyDat(text: string): {
  names: Record<string, string>;
  prefixes: Record<string, string[]>;
  airports: Record<string, string>;
} {
  const names: Record<string, string> = {};
  const airports: Record<string, string> = {};
  const exact: Record<string, string> = {};
  const prefixes: Record<string, string[]> = {};
  const add = (prefix: string, firs: readonly string[]) => {
    const list = prefixes[prefix] ?? [];
    for (const f of firs) if (!list.includes(f)) list.push(f);
    prefixes[prefix] = list;
  };
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith(';')) continue;
    const head = /^\[(.+)\]$/.exec(line);
    if (head !== null) {
      section = head[1] as string;
      continue;
    }
    const cols = line.split('|');
    if (section === 'Airports' && cols.length >= 7) {
      const icao = (cols[0] as string).trim().toUpperCase();
      const fir = (cols[5] as string).trim().toUpperCase();
      if ((cols[6] as string).trim() === '0' && ICAO_RE.test(icao) && ICAO_RE.test(fir)) {
        airports[icao] ??= fir;
      }
    } else if (section === 'FIRs' && cols.length >= 4) {
      const [icao, name, prefix, boundary] = cols.map((c) => c.trim()) as [
        string,
        string,
        string,
        string,
      ];
      const fir = boundary.split('-')[0] as string;
      if (!ICAO_RE.test(fir)) continue;
      // The name of a FIR: its own line (ICAO = boundary), the one without a prefix first.
      if (icao === fir && boundary === fir && name !== '') {
        if (prefix === '' || exact[fir] === undefined) exact[fir] = name;
      }
      if (icao === fir) names[fir] ??= name;
      add((prefix === '' ? icao : prefix).toUpperCase(), [fir]);
    } else if (section === 'UIRs' && cols.length >= 3) {
      // UIR members may be FIR sectors (`EDGG-BAD`): the station covers (part of) that FIR.
      const id = (cols[0] as string).trim().toUpperCase();
      const firs = (cols[2] as string)
        .split(',')
        .map((f) => f.trim().toUpperCase().split('-')[0] as string)
        .filter((f) => ICAO_RE.test(f));
      // VATSIM callsigns have `_` where VATSpy ids have `-` (`EUC-ME` → `EUC_ME_CTR`).
      if (id !== '' && firs.length > 0) add(id.replaceAll('-', '_'), firs);
    }
  }
  return { names: { ...names, ...exact }, prefixes, airports };
}

/**
 * FIRs the route passes (origin, navlog fixes, destination; legs sampled every ≤ 10 NM),
 * in route order. Only these go to the core and the recording.
 */
export function routeFirs(data: VatspyData, ofp: Ofp): FirArea[] {
  const map = new FirMap(data.firs);
  const pts: LatLon[] = [ofp.origin, ...ofp.navlog, ofp.destination];
  const seen = new Set<string>();
  const out: FirArea[] = [];
  const visit = (p: LatLon) => {
    const a = map.locate(p);
    if (a !== null && !seen.has(a.id)) {
      seen.add(a.id);
      out.push(a);
    }
  };
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i] as LatLon;
    visit(a);
    const b = pts[i + 1];
    if (b === undefined) break;
    const n = Math.floor(distanceNm(a, b) / 10);
    for (let k = 1; k < n; k++) visit(interpolate(a, b, k / n));
  }
  return out;
}

/** A VATSIM centre (CTR) or FSS of the feed. */
export interface VatsimCenter {
  readonly callsign: string;
  readonly frequency: string;
}

/**
 * Online centres covering the given FIRs. The FIR of a callsign: the longest VATSpy prefix
 * among its `_` parts before the suffix (`EDGG_DKB_CTR` → `EDGG_DKB` → EDGG; `LON_S_CTR` →
 * `LON` → EGTT; a UIR prefix → all its FIRs).
 */
export function centersFor(
  centers: readonly VatsimCenter[],
  data: Pick<VatspyData, 'prefixes'>,
  firs: ReadonlySet<string>,
): CenterStation[] {
  const out: CenterStation[] = [];
  for (const c of centers) {
    const parts = c.callsign.split('_').slice(0, -1);
    let covered: readonly string[] = [];
    for (let n = parts.length; n > 0 && covered.length === 0; n--) {
      covered = data.prefixes[parts.slice(0, n).join('_')] ?? [];
    }
    const mine = covered.filter((f) => firs.has(f));
    if (mine.length > 0) out.push({ callsign: c.callsign, frequency: c.frequency, firs: mine });
  }
  return out.sort((a, b) => (a.callsign < b.callsign ? -1 : a.callsign > b.callsign ? 1 : 0));
}
