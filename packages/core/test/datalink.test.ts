// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AcarsCore,
  checkExtDataUpdate,
  chooseLink,
  compileScenario,
  DELAY_MS,
  type ExtDataUpdate,
  generateSyntheticFlight,
  geoElevationDeg,
  INMARSAT_SATELLITES,
  LinkChannel,
  type LinkPosition,
  MIN_ELEVATION_DEG,
  type OutboundMessage,
  parseSimbriefOfp,
  type ScenarioDef,
  VHF_GROUND_RANGE_NM,
  VHF_MAX_RANGE_NM,
  type VhfStation,
  vhfRangeNm,
} from '../src/index.js';

/** T31: the data link — VHF station in reach or Inmarsat satellite, and the delivery delay. */

const ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'ofp', 'rctp-rjbb-a35k-kgs.json'), 'utf8'),
  ),
);
const flight = generateSyntheticFlight({ ofp });

const pos = (lat: number, lon: number, altFt: number, onGround = false): LinkPosition => ({
  lat,
  lon,
  altFt,
  onGround,
});
const EDDF: VhfStation = { icao: 'EDDF', lat: 50.0267, lon: 8.5584 };
const EDDM: VhfStation = { icao: 'EDDM', lat: 48.3538, lon: 11.7861 };

describe('radio horizon and satellite geometry (A2, A3)', () => {
  it('1.23·√h NM, at most 200, on the ground a fixed 20', () => {
    expect(vhfRangeNm(10_000, false)).toBeCloseTo(123, 0);
    expect(vhfRangeNm(1_000, false)).toBeCloseTo(38.9, 1);
    expect(vhfRangeNm(35_000, false)).toBe(VHF_MAX_RANGE_NM);
    expect(vhfRangeNm(-50, false)).toBe(0);
    expect(vhfRangeNm(0, true)).toBe(VHF_GROUND_RANGE_NM);
  });

  it('elevation of a geostationary satellite', () => {
    expect(geoElevationDeg({ lat: 0, lon: 25 }, 25)).toBeCloseTo(90, 5);
    // Frankfurt to the EMEA satellite (25°E): about 31°.
    expect(geoElevationDeg({ lat: 50, lon: 8.5 }, 25)).toBeCloseTo(30.6, 0);
    // The far side of the Earth does not see it.
    expect(geoElevationDeg({ lat: 0, lon: -155 }, 25)).toBeLessThan(0);
  });
});

describe('chooseLink', () => {
  it('VHF: the nearest station inside the horizon', () => {
    const c = chooseLink(pos(49.5, 9.5, 30_000), [EDDM, EDDF], false);
    expect(c).toMatchObject({ kind: 'vhf', station: 'EDDF', elevDeg: null });
    expect(c?.distNm).toBeGreaterThan(40);
  });

  it('a station beyond the horizon does not count; the ground uses 20 NM', () => {
    expect(chooseLink(pos(50.0267, 14, 3_000), [EDDF], false)).toBeNull();
    expect(chooseLink(pos(50.05, 8.58, 364, true), [EDDF], false)).toMatchObject({
      kind: 'vhf',
      station: 'EDDF',
    });
    expect(chooseLink(pos(50.0267, 10.5, 0, true), [EDDF], false)).toBeNull();
  });

  it('VHF is preferred over SATCOM; without a station SATCOM picks the highest satellite', () => {
    expect(chooseLink(pos(50, 9, 35_000), [EDDF], true)?.kind).toBe('vhf');
    // Mid North Atlantic: AOR-E (15.5°W) is the highest of those above the horizon.
    expect(chooseLink(pos(50, -30, 37_000), [], true)).toMatchObject({
      kind: 'satcom',
      station: 'AOR-E',
    });
    expect(chooseLink(pos(50, -30, 37_000), [], false)).toBeNull();
  });

  it('near the pole no satellite is above the minimum elevation', () => {
    for (const s of INMARSAT_SATELLITES) {
      expect(geoElevationDeg({ lat: 85, lon: 0 }, s.lon)).toBeLessThan(MIN_ELEVATION_DEG);
    }
    expect(chooseLink(pos(85, 0, 37_000), [], true)).toBeNull();
  });
});

const msg = (text: string): OutboundMessage =>
  ({
    scenarioId: 'x',
    from: 'OPS',
    to: 'SJX822',
    kind: 'telex',
    message: { text, pages: [text] },
    t: 0,
    toPilot: false,
  }) as unknown as OutboundMessage;

describe('LinkChannel', () => {
  const T = 1_000_000;

  it('delays by the range of the link, in order, stamping the release time', () => {
    const ch = new LinkChannel(true, 's');
    const here = pos(49.5, 9.5, 30_000);
    expect(ch.process(T, here, [EDDF], [msg('A'), msg('B')])).toEqual([]);
    expect(ch.view).toMatchObject({ held: 0, inFlight: 2 });
    const out: OutboundMessage[] = [];
    for (let s = 1; s <= 12 && out.length < 2; s++) {
      out.push(...ch.process(T + s * 1000, here, [EDDF], []));
    }
    expect(out.map((m) => m.message.text)).toEqual(['A', 'B']);
    for (const m of out) {
      expect(m.link).toMatchObject({ kind: 'vhf', station: 'EDDF', waitedMs: 0 });
      expect(m.link?.delayMs).toBeGreaterThanOrEqual(DELAY_MS.vhf.min);
    }
    expect((out[1] as OutboundMessage).link?.delayMs).toBeGreaterThanOrEqual(
      (out[0] as OutboundMessage).link?.delayMs ?? 0,
    );
    expect((out[0] as OutboundMessage).t).toBeGreaterThan(T);
  });

  it('SATCOM delay is longer; the whole range is respected', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const ch = new LinkChannel(true, seed);
      const there = pos(50, -30, 37_000);
      ch.process(T, there, [], [msg('A')]);
      let m: OutboundMessage | undefined;
      for (let s = 1; m === undefined && s <= 40; s++) {
        m = ch.process(T + s * 1000, there, [], [])[0];
      }
      expect(m?.link?.kind).toBe('satcom');
      expect(m?.link?.delayMs).toBeGreaterThanOrEqual(DELAY_MS.satcom.min);
      expect(m?.link?.delayMs).toBeLessThanOrEqual(DELAY_MS.satcom.max);
    }
  });

  it('no link: the message waits and leaves after the link returns', () => {
    const ch = new LinkChannel(false, 's');
    const ocean = pos(50, -30, 37_000);
    expect(ch.process(T, ocean, [EDDF], [msg('A')])).toEqual([]);
    expect(ch.process(T + 600_000, ocean, [EDDF], [])).toEqual([]);
    expect(ch.view).toMatchObject({ link: null, held: 1, inFlight: 0 });
    const land = pos(50.1, 9, 8_000);
    const back = T + 1_200_000;
    ch.process(back, land, [EDDF], []);
    let m: OutboundMessage | undefined;
    for (let s = 1; m === undefined && s <= 12; s++) {
      m = ch.process(back + s * 1000, land, [EDDF], [])[0];
    }
    expect(m?.link).toMatchObject({ kind: 'vhf', waitedMs: 1_200_000 });
  });

  it('without a position messages pass untouched', () => {
    const ch = new LinkChannel(true, 's');
    const out = ch.process(T, null, [], [msg('A')]);
    expect(out.map((m) => m.message.text)).toEqual(['A']);
    expect(out[0]?.link).toBeUndefined();
  });

  it('is deterministic and survives a state round trip', () => {
    const run = (cut: boolean) => {
      let ch = new LinkChannel(true, 'seed');
      const here = pos(49.5, 9.5, 30_000);
      const got: number[] = [];
      ch.process(T, here, [EDDF], [msg('A'), msg('B'), msg('C')]);
      for (let s = 1; s <= 40; s++) {
        if (cut && s === 2) {
          ch = new LinkChannel(true, 'seed', JSON.parse(JSON.stringify(ch.getState())));
        }
        for (const m of ch.process(T + s * 1000, here, [EDDF], [])) got.push(m.link?.delayMs ?? -1);
      }
      return got;
    };
    expect(run(false)).toHaveLength(3);
    expect(run(true)).toEqual(run(false));
  });
});

describe('core with the link simulation', () => {
  const def: ScenarioDef = {
    id: 'ping',
    version: 1,
    category: 'irregular',
    title: 'ping',
    enabled_by_default: true,
    trigger: { on: 'phase_enter', phase: 'CRUISE' },
    steps: [{ send: { body: 'PING' } }],
  };
  const stations: VhfStation[] = [
    { icao: ofp.origin.icao, lat: ofp.origin.lat, lon: ofp.origin.lon },
    { icao: ofp.destination.icao, lat: ofp.destination.lat, lon: ofp.destination.lon },
  ];

  function fly(datalink: boolean, resumeAt?: number) {
    const options = {
      ofp,
      scenarios: [compileScenario(def)],
      seed: 'link',
      ...(datalink ? { datalink: { satcom: true } } : {}),
    };
    let core = AcarsCore.create(options);
    core.startFlight();
    const out: OutboundMessage[] = [];
    flight.snapshots.forEach((s, i) => {
      if (i === resumeAt) {
        core = AcarsCore.fromState(JSON.parse(JSON.stringify(core.getState())), options);
      }
      const data: ExtDataUpdate | undefined = i === 0 ? { t: s.t, vhf: stations } : undefined;
      out.push(...core.tick({ now: s.t, telemetry: s, ...(data ? { data } : {}) }).outbound);
    });
    return { core, out };
  }

  it('is off by default: the message leaves at once, without link info', () => {
    const r = fly(false);
    expect(r.out).toHaveLength(1);
    expect(r.out[0]?.link).toBeUndefined();
    expect(r.core.linkView).toBeNull();
  });

  it('on: the message leaves later by the link delay, with the link recorded', () => {
    const plain = fly(false);
    const r = fly(true);
    expect(r.out).toHaveLength(1);
    const m = r.out[0] as OutboundMessage;
    expect(m.link?.kind).toMatch(/vhf|satcom/);
    const delay = m.t - (plain.out[0] as OutboundMessage).t;
    expect(delay).toBeGreaterThanOrEqual(DELAY_MS.vhf.min);
    expect(delay).toBeLessThanOrEqual(DELAY_MS.satcom.max + 1000);
    expect(r.core.linkView).not.toBeNull();
  });

  it('is deterministic and resumes from a saved state', () => {
    const a = fly(true);
    expect(fly(true).out.map((m) => m.t)).toEqual(a.out.map((m) => m.t));
    const cutAt = Math.floor(flight.snapshots.length / 2);
    expect(fly(true, cutAt).out.map((m) => m.t)).toEqual(a.out.map((m) => m.t));
  });

  it('checks the stations in an update', () => {
    expect(() => checkExtDataUpdate({ t: 1, vhf: stations })).not.toThrow();
    expect(() => checkExtDataUpdate({ t: 1, vhf: [{ icao: 'EDDF', lat: 91, lon: 0 }] })).toThrow();
    expect(() => checkExtDataUpdate({ t: 1, vhf: [{ icao: 'e', lat: 1, lon: 0 }] })).toThrow();
    expect(() => checkExtDataUpdate({ t: 1, vhf: 'x' })).toThrow();
  });
});
