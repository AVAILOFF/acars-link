// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CharterType,
  classifyFlight,
  generateSyntheticFlight,
  type Ofp,
  parseSimbriefOfp,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../src/index.js';
import { type Case, errors, fly, ids, read } from './irregular-fixture.js';

/** T107: the type of a charter — a tour charter gets no sports team or VIP messages. */

const all = loadScenarios(['base', 'commands', 'irregular', 'charter'].flatMap(read));
const byId = (id: string, sure = true) => {
  const s = all.find((x) => x.id === id);
  if (s === undefined) throw new Error(`no scenario ${id}`);
  return sure ? { ...s, probability: 1 } : s;
};
const ofp: Ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../core/test/fixtures/ofp/rctp-rjbb-a35k-kgs.json'),
      'utf8',
    ),
  ),
);
const pax: Case = { name: 'pax', ofp, flight: generateSyntheticFlight({ ofp }) };

const CHARTER = [
  'charter_group_lmc',
  'charter_tour_rep',
  'charter_sports_team',
  'charter_vip',
  'charter_transfer',
];
const TOUR = ['charter_group_lmc', 'charter_tour_rep', 'charter_transfer'];

/** A seed whose passenger LMC is not 0, so `charter_group_lmc` can start. */
const seed = (() => {
  for (let i = 0; i < 200; i++) {
    const s = `t107-${i}`;
    const r = fly(pax, [byId('charter_group_lmc')], {
      flightKind: 'charter_pax',
      charter: null,
      seed: s,
    });
    if (ids(r).includes('charter_group_lmc')) return s;
  }
  throw new Error('no seed');
})();

describe('type of charter (T107)', () => {
  it('classifyFlight: the default type is tour, only on a charter and with the type on', () => {
    expect(classifyFlight(ofp, 'charter_pax', null)).toMatchObject({
      charter: 'tour',
      charterOverride: null,
    });
    expect(classifyFlight(ofp, 'charter_pax', 'vip')).toMatchObject({
      charter: 'vip',
      charterOverride: 'vip',
    });
    expect(classifyFlight(ofp, 'sched_pax', 'vip').charter).toBeNull();
    // Without the type (recordings before T107).
    expect(classifyFlight(ofp, 'charter_pax').charter).toBeNull();
  });

  it('the charter scenarios name their types', () => {
    const types = Object.fromEntries(CHARTER.map((id) => [id, byId(id).def.charter]));
    expect(types).toEqual({
      charter_group_lmc: ['tour'],
      charter_tour_rep: ['tour'],
      charter_sports_team: ['sports'],
      charter_vip: ['vip'],
      charter_transfer: ['tour'],
    });
  });

  const run = (charter: CharterType | null | undefined) =>
    fly(
      pax,
      CHARTER.map((id) => byId(id)),
      {
        flightKind: 'charter_pax',
        seed,
        ...(charter === undefined ? {} : { charter }),
      },
    );

  it('a tour charter (the default or chosen) gets no sports team or VIP messages', () => {
    for (const c of [null, 'tour'] as const) {
      const r = run(c);
      expect(errors(r)).toEqual([]);
      const got = ids(r).filter((x) => CHARTER.includes(x));
      expect(got.sort(), String(c)).toEqual([...TOUR].sort());
      for (const m of r.out) expect(m.message.text).not.toMatch(/SPORTS|VIP/);
    }
  });

  it.each([
    ['sports', 'charter_sports_team'],
    ['vip', 'charter_vip'],
  ] as const)('a %s charter gets only its own story, no tour group or transfer', (c, story) => {
    const r = run(c);
    expect(errors(r)).toEqual([]);
    expect(ids(r).filter((x) => CHARTER.includes(x))).toEqual([story]);
    for (const m of r.out) expect(m.message.text).not.toMatch(/TOUR/);
  });

  it('without the type (recordings before T107) nothing changes: all three stories may come', () => {
    const r = run(undefined);
    const got = ids(r).filter((x) => CHARTER.includes(x));
    // One story of the group `charter_story` (T91) besides the tour group and the transfer.
    expect(got.filter((x) => !['charter_group_lmc', 'charter_transfer'].includes(x))).toHaveLength(
      1,
    );
  });

  it('chosen by hand, the story of the type comes every time; the default tour 30 %', () => {
    const N = 10;
    const story = (c: CharterType | null, id: string) => {
      let n = 0;
      for (let i = 0; i < N; i++) {
        const r = fly(pax, [byId(id, false)], {
          flightKind: 'charter_pax',
          charter: c,
          seed: `t107-p-${i}`,
          // The stories come before pushback: no need to fly on.
          until: (r) => r.core.phase !== 'PREFLIGHT' && r.core.phase !== 'BOARDING',
        });
        if (ids(r).includes(id)) n++;
      }
      return n;
    };
    expect(story('sports', 'charter_sports_team')).toBe(N);
    expect(story('vip', 'charter_vip')).toBe(N);
    expect(story('tour', 'charter_tour_rep')).toBe(N);
    const byDefault = story(null, 'charter_tour_rep');
    expect(byDefault).toBeGreaterThan(0);
    expect(byDefault).toBeLessThan(N);
  });
});
