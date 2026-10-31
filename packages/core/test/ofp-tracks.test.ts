// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type NatTrack, parseSimbriefOfp } from '../src/index.js';

/**
 * T72: `tracks.nat` of the SimBrief OFP (json=v2). Structure checked on a real KATL–EDDF OFP of
 * 2026-10-31 (anonymized fixture): 12 tracks, A–F westbound (EGGX), U–Z eastbound (CZQX).
 */

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'ofp', name), 'utf8'));
const nat = fixture('katl-eddf-b752-nat-w.json');
const plain = fixture('rctp-rjbb-a35k-kgs.json');

/** The fixture with `tracks.nat` replaced. */
const withNat = (value: unknown) => ({ ...nat, tracks: { nat: value } });
const track = (o: Record<string, unknown>) => ({
  id: 'A',
  group: 'West',
  addr: 'EGGX',
  tmi: '304',
  route: 'SUNOT 58N020W 59N030W 59N040W 58N050W DORYY',
  levels: '340 350 360',
  start: '2026-10-31T11:30:00Z',
  end: '2026-10-31T19:00:00Z',
  ...o,
});
const tracksOf = (json: unknown): readonly NatTrack[] => parseSimbriefOfp(json).natTracks ?? [];

describe('tracks.nat of the OFP (T72)', () => {
  it('reads all 12 tracks of the real OFP', () => {
    const tracks = tracksOf(nat);
    expect(tracks.map((k) => k.ident)).toEqual([...'ABCDEF', ...'UVWXYZ']);
    const w = tracks.find((k) => k.ident === 'W') as NatTrack;
    expect(w).toEqual({
      ident: 'W',
      route: ['SUPRY', '46/50', '49/40', '51/30', '52/20', 'LIMRI', 'XETBO'],
      validFrom: Date.parse('2026-11-01T01:00:00Z'),
      validTo: Date.parse('2026-11-01T08:00:00Z'),
      levelsFt: [34000, 35000, 36000, 37000, 38000, 39000, 40000],
    });
    // Y has levels 340 360 380 400 only.
    expect(tracks.find((k) => k.ident === 'Y')?.levelsFt).toEqual([34000, 36000, 38000, 40000]);
  });

  it('is absent without tracks: `tracks: []`, `{}`, no field', () => {
    expect(parseSimbriefOfp(plain)).not.toHaveProperty('natTracks');
    for (const tracks of [[], {}, { nat: [] }, { nat: {} }]) {
      expect(parseSimbriefOfp({ ...plain, tracks })).not.toHaveProperty('natTracks');
    }
  });

  it('reads a single track given as an object (XML-to-JSON without the array)', () => {
    expect(tracksOf(withNat(track({})))).toHaveLength(1);
  });

  it('writes half-degree latitudes as in the track message', () => {
    const [k] = tracksOf(withNat([track({ route: 'RESNO 5530N02000W 56N030W DOGAL' })]));
    expect(k?.route).toEqual(['RESNO', '5530/20', '56/30', 'DOGAL']);
  });

  it('skips a track that does not read, keeps the others, never refuses the OFP', () => {
    const bad = [
      track({ id: 'a' }), // not a track letter
      track({ id: '' }),
      track({ route: 'SUNOT' }), // a route is two points at least
      track({ route: 'SUNOT 58N020E DORYY' }), // east: not a NAT point
      track({ route: 'SUNOT 5530N02030W DORYY' }), // minutes of longitude
      track({ levels: '' }),
      track({ levels: '34O 350' }),
      track({ start: 'tomorrow' }),
      track({ end: '2026-10-31T11:00:00Z' }), // ends before it starts
      track({ start: undefined }),
      'not an object',
      null,
    ];
    const good = track({ id: 'B' });
    expect(tracksOf(withNat([...bad, good])).map((k) => k.ident)).toEqual(['B']);
  });
});
