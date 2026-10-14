import type { ExtDataUpdate, Ofp } from '@acars/core';

/**
 * OSM-like stands of the destination for tests (T43: the engine invents no gates, so the tests
 * that need one feed real-looking stands, like the app does once Overpass answers).
 */
export const TEST_GATES = ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3'] as const;

export function standsFor(ofp: Ofp, t: number): ExtDataUpdate {
  return {
    t,
    stands: {
      icao: ofp.destination.icao,
      list: TEST_GATES.map((ref) => ({ ref, kind: 'gate' as const })),
    },
  };
}
