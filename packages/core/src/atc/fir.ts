import type { FirArea } from '../ext/data.js';
import type { LatLon } from '../geo/geo.js';

/**
 * FIR lookup for the ROPS station (T23). Boundaries come as external data (`CoreInput.data`,
 * VATSpy `Boundaries.geojson`, docs/06 "Границы FIR"): GeoJSON order `[lon, lat]`, polygons
 * already split at the antimeridian, so a planar even-odd test on lon/lat is enough.
 *
 * Approved assumption (docs/07 T23, 2026-10-09): FIRs only — no UIRs or sectors. VATSpy also
 * has a few 4-letter areas inside a FIR (London TMA `EGTL` inside `EGTT`); where areas
 * overlap, the largest one wins, which is the FIR.
 */

interface Indexed {
  readonly area: FirArea;
  /** Planar area in square degrees (outer rings minus holes), for overlaps. */
  readonly size: number;
  readonly boxes: readonly (readonly [number, number, number, number])[];
}

export class FirMap {
  private readonly list: readonly Indexed[];

  constructor(areas: readonly FirArea[]) {
    this.list = areas.map((area) => ({
      area,
      size: area.polygons.reduce(
        (sum, rings) => sum + rings.reduce((s, r, i) => s + (i === 0 ? 1 : -1) * ringArea(r), 0),
        0,
      ),
      boxes: area.polygons.map((rings) => bbox(rings[0] ?? [])),
    }));
  }

  get size(): number {
    return this.list.length;
  }

  has(id: string): boolean {
    return this.list.some((x) => x.area.id === id);
  }

  get(id: string): FirArea | null {
    return this.list.find((x) => x.area.id === id)?.area ?? null;
  }

  /** The FIR containing `p`, or null (outside every known area). */
  locate(p: LatLon): FirArea | null {
    let best: Indexed | null = null;
    for (const x of this.list) {
      if (!contains(x, p)) continue;
      if (
        best === null ||
        x.size > best.size ||
        (x.size === best.size && x.area.id < best.area.id)
      ) {
        best = x;
      }
    }
    return best?.area ?? null;
  }
}

function contains(x: Indexed, p: LatLon): boolean {
  return x.area.polygons.some((rings, i) => {
    const b = x.boxes[i] as readonly [number, number, number, number];
    if (p.lon < b[0] || p.lon > b[2] || p.lat < b[1] || p.lat > b[3]) return false;
    // Even-odd over all rings: a point in a hole is outside.
    let inside = false;
    for (const ring of rings) if (inRing(ring, p.lon, p.lat)) inside = !inside;
    return inside;
  });
}

function inRing(ring: readonly (readonly [number, number])[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as readonly [number, number];
    const [xj, yj] = ring[j] as readonly [number, number];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function ringArea(ring: readonly (readonly [number, number])[]): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as readonly [number, number];
    const [xj, yj] = ring[j] as readonly [number, number];
    s += xj * yi - xi * yj;
  }
  return Math.abs(s) / 2;
}

function bbox(ring: readonly (readonly [number, number])[]): [number, number, number, number] {
  let [minX, minY, maxX, maxY] = [180, 90, -180, -90];
  for (const [x, y] of ring) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return [minX, minY, maxX, maxY];
}

/**
 * Hoppie callsign of the simulated station of a FIR: `X` + the last three letters
 * (`EDGG` → `XDGG`). ICAO assigns no location indicators starting with `X`, so the code
 * cannot be a real unit's and does not catch other pilots' logons (approved 2026-10-09).
 */
export function ropsStation(firId: string): string {
  if (!/^[A-Z]{4}$/.test(firId)) throw new RangeError(`not a FIR id: ${firId}`);
  return `X${firId.slice(1)}`;
}

/**
 * Unit name for `CURRENT ATC UNIT`: the VATSpy name without parts in brackets, the text after
 * ` - ` and words like ACC/RADAR, plus `CTL` (control) or `OCA` (oceanic) — the forms seen in
 * packets of real Hoppie stations ("LANGEN CTL", "REYKJAVIK OCA", docs/06).
 */
export function atcUnitName(area: Pick<FirArea, 'name' | 'oceanic'>): string {
  const oceanic = area.oceanic || /\boceanic\b/i.test(area.name);
  const base = (area.name.split(' - ')[0] as string)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(ACC|FIR|UIR|CENTER|CENTRE|CONTROL|RADAR|OCEANIC|OCA|CTA)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${base === '' ? 'ATC' : base.toUpperCase()} ${oceanic ? 'OCA' : 'CTL'}`;
}
