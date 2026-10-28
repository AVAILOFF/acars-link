// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type AtcEvent,
  cpdlcPacket,
  DIVERT_DESCENT_FT,
  DIVERT_DESCENT_MARGIN_NM,
  distanceNm,
  EMPTY_EXT,
  type FirArea,
  type LatLon,
  type Ofp,
  type OutboundMessage,
  type PilotMessage,
  parseSimbriefOfp,
  type TelemetrySnapshot,
  XatcStation,
} from '../src/index.js';

/** T48: the airline's diversion and holding reach the aircraft through the XATC station. */

const ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'ofp', 'rctp-rjbb-a35k-kgs.json'), 'utf8'),
  ),
);
const at = (ident: string) => ofp.navlog.findIndex((f) => f.ident === ident);
const WORLD: FirArea = {
  id: 'RJJJ',
  name: 'Fukuoka',
  oceanic: false,
  polygons: [
    [
      [
        [100, 0],
        [170, 0],
        [170, 60],
        [100, 60],
        [100, 0],
      ],
    ],
  ],
};
const ext = { ...EMPTY_EXT, firs: [WORLD] };
const melen = ofp.navlog[at('MELEN')];
const mumba = ofp.navlog[at('MUMBA')];
if (melen === undefined || mumba === undefined) throw new Error('fixture');
const pos = { lat: (melen.lat + mumba.lat) / 2, lon: (melen.lon + mumba.lon) / 2 };
const T0 = Date.UTC(2026, 9, 8, 8, 30);
const STEP = 5000;
const OPTIONS = { enabled: true, randomDirects: false } as const;
const altn = ofp.alternates[0];
if (altn === undefined) throw new Error('fixture: no alternate');

const tm = (t: number, altFt: number, at: LatLon = pos): TelemetrySnapshot => ({
  v: 1,
  t,
  lat: at.lat,
  lon: at.lon,
  altFt,
  aglFt: altFt,
  iasKt: 260,
  gsKt: 480,
  vsFpm: 0,
  hdgTrue: 60,
  onGround: false,
  parkingBrake: false,
  beacon: true,
  engRunning: [true, true],
  engN2: [90, 90],
  fuelKg: 15000,
  gearDown: false,
  flapsIdx: 0,
  doorsOpen: [],
  xpdrState: 4,
  simRate: 1,
  paused: false,
  aircraftTitle: 'A350',
});

const logon: PilotMessage = {
  from: ofp.callsign,
  type: 'cpdlc',
  text: '/data2/0//Y/REQUEST LOGON',
  to: 'XJJJ',
};

interface Link {
  readonly divert?: string | null;
  readonly hold?: { readonly since: number; readonly min: number } | null;
}

function run(
  ticks: number,
  altFt: number | ((i: number) => number),
  link: (i: number) => Link,
  o: {
    logon?: boolean;
    resumeAt?: number;
    seed?: string;
    say?: ReadonlyMap<number, readonly PilotMessage[]>;
    ofp?: Ofp;
    at?: (i: number) => LatLon;
  } = {},
) {
  const seed = o.seed ?? 'link';
  const plan = o.ofp ?? ofp;
  let st = new XatcStation(plan, OPTIONS, { seed });
  const out: OutboundMessage[] = [];
  const events: AtcEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    if (i === o.resumeAt) st = new XatcStation(plan, OPTIONS, { seed }, st.getState());
    const now = T0 + i * STEP;
    const r = st.tick({
      now,
      phase: 'CRUISE',
      telemetry: tm(now, typeof altFt === 'number' ? altFt : altFt(i), o.at?.(i)),
      inbound: [...(i === 1 && o.logon !== false ? [logon] : []), ...(o.say?.get(i) ?? [])],
      ext,
      ...link(i),
    });
    out.push(...r.outbound);
    events.push(...r.events);
  }
  return { out, events };
}
const packets = (out: readonly OutboundMessage[]) =>
  out.map((m) => cpdlcPacket(m.cpdlc ?? { min: 0, mrn: null, ra: 'NE' }, m.message));
const autos = (events: readonly AtcEvent[]) =>
  events.filter((e): e is Extract<AtcEvent, { type: 'ATC_AUTO' }> => e.type === 'ATC_AUTO');

const distToAltn = distanceNm(pos, altn);
/** An altitude whose descent distance just covers the distance to the alternate. */
const NEAR_FT = DIVERT_DESCENT_FT + ((distToAltn - DIVERT_DESCENT_MARGIN_NM) / 3) * 1000 + 2000;

describe('diversion through the station (T48)', () => {
  const divertAt = 10;

  it('PROCEED DIRECT TO the airport 20–60 s after, once; the old route clearances stop', () => {
    const r = run(120, 37000, (i) => (i >= divertAt ? { divert: altn.icao } : {}));
    const direct = packets(r.out).filter((p) => p.includes(`PROCEED DIRECT TO @${altn.icao}@`));
    expect(direct).toHaveLength(1);
    const a = autos(r.events);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: 'divert', station: 'XJJJ' });
    const delay = (a[0]?.t as number) - (T0 + divertAt * STEP);
    expect(delay).toBeGreaterThanOrEqual(20_000);
    expect(delay).toBeLessThanOrEqual(65_000);
    // Far from the airport at FL370: no descent yet.
    expect(packets(r.out).some((p) => p.includes('DESCEND'))).toBe(false);
  });

  it('descends to 10000 ft once the airport is within the descent distance', () => {
    const r = run(120, NEAR_FT, (i) => (i >= divertAt ? { divert: altn.icao } : {}));
    const p = packets(r.out);
    const iDirect = p.findIndex((x) => x.includes('PROCEED DIRECT TO'));
    const iDescent = p.findIndex((x) => x.includes(`DESCEND TO @${DIVERT_DESCENT_FT}FT@`));
    expect(iDirect).toBeGreaterThan(-1);
    expect(iDescent).toBeGreaterThan(iDirect);
    expect(p.filter((x) => x.includes('DESCEND'))).toHaveLength(1);
  });

  it('without a logon only the airline speaks; an unknown airport gets a direct, no descent', () => {
    const none = run(120, NEAR_FT, (i) => (i >= divertAt ? { divert: altn.icao } : {}), {
      logon: false,
    });
    expect(none.out).toEqual([]);
    const unknown = run(120, NEAR_FT, (i) => (i >= divertAt ? { divert: 'ZZZZ' } : {}));
    const p = packets(unknown.out);
    expect(p.some((x) => x.includes('PROCEED DIRECT TO @ZZZZ@'))).toBe(true);
    expect(p.some((x) => x.includes('DESCEND'))).toBe(false);
  });

  it('the descent is named by the transition of the diversion airport', () => {
    // Without a transition in the OFP, outside North America: always a flight level.
    const noTl: Ofp = {
      ...ofp,
      alternates: [{ ...altn, transAltFt: null, transLevelFt: null }],
    };
    const r = run(120, NEAR_FT, (i) => (i >= divertAt ? { divert: altn.icao } : {}), {
      ofp: noTl,
    });
    expect(packets(r.out).some((x) => x.includes('DESCEND TO @FL100@'))).toBe(true);
  });

  it('is deterministic and survives a state round trip', () => {
    const link = (i: number): Link => (i >= divertAt ? { divert: altn.icao } : {});
    const whole = run(120, NEAR_FT, link);
    const split = run(120, NEAR_FT, link, { resumeAt: divertAt + 2 });
    expect(packets(split.out)).toEqual(packets(whole.out));
    expect(packets(run(120, NEAR_FT, link).out)).toEqual(packets(whole.out));
  });
});

describe('holding through the station (T48)', () => {
  const since = T0 + 10 * STEP;
  const holdOn = (i: number): Link => (i >= 10 && i < 60 ? { hold: { since, min: 15 } } : {});

  it('HOLD AT a fix ahead with the expected further clearance, then a direct to the next fix', () => {
    const r = run(100, 11000, holdOn);
    const p = packets(r.out);
    const iHold = p.findIndex((x) => x.includes('HOLD AT @'));
    expect(iHold).toBeGreaterThan(-1);
    expect(p[iHold]).toMatch(
      /\/data2\/\d+\/\/WU\/HOLD AT @[A-Z0-9]+@ AS PUBLISHED MAINTAIN @11000FT@/,
    );
    const efc = new Date(T0 + 10 * STEP + 15 * 60_000);
    const hhmm = `${String(efc.getUTCHours()).padStart(2, '0')}${String(efc.getUTCMinutes()).padStart(2, '0')}`;
    expect(p[iHold + 1]).toContain(`EXPECT FURTHER CLEARANCE AT @${hhmm}@`);
    const fix = /HOLD AT @([A-Z0-9]+)@/.exec(p[iHold] as string)?.[1] as string;
    const idx = ofp.navlog.findIndex((f) => f.ident === fix);
    expect(idx).toBeGreaterThanOrEqual(0);
    // The end: a direct to the fix after the one held at.
    const next = ofp.navlog.find((f, i) => i > idx && f.type !== 'ltlg');
    expect(p.at(-1)).toContain(`PROCEED DIRECT TO @${next?.ident}@`);
    expect(autos(r.events).map((e) => e.kind)).toEqual(['hold', 'hold', 'hold']);
  });

  it('no logon: nothing; flight levels above FL180 are named FL', () => {
    expect(run(100, 11000, holdOn, { logon: false }).out).toEqual([]);
    const hi = run(100, 24000, holdOn);
    expect(packets(hi.out).some((x) => x.includes('MAINTAIN @FL240@'))).toBe(true);
  });

  it('the holding level is named by the destination transition (RJBB: 14000 ft)', () => {
    expect(ofp.destination.transLevelFt).toBe(14000);
    const p = packets(run(100, 16000, holdOn).out);
    expect(p.some((x) => x.includes('MAINTAIN @FL160@'))).toBe(true);
  });

  it('survives a state round trip mid-hold', () => {
    const whole = run(100, 11000, holdOn);
    const split = run(100, 11000, holdOn, { resumeAt: 30 });
    expect(packets(split.out)).toEqual(packets(whole.out));
  });
});

describe('a level clearance of the airline link replaces the level watch (T47, T48)', () => {
  const pilot = (min: number, text: string, mrn: number | null = null): PilotMessage => ({
    from: ofp.callsign,
    type: 'cpdlc',
    text: `/data2/${min}/${mrn ?? ''}/${mrn === null ? 'Y' : 'N'}/${text}`,
    to: 'XJJJ',
  });
  const WILCO_AT = 30;
  const DIVERT_AT = 60;
  const DESCEND_FROM = 90;
  /** Climb FL370 → FL390 after the WILCO, then (from `DESCEND_FROM`) down 100 ft a tick. */
  const alt = (bottom: number) => (i: number) =>
    i < DESCEND_FROM
      ? Math.min(39000, 37000 + Math.max(0, i - WILCO_AT) * 100)
      : Math.max(bottom, 39000 - (i - DESCEND_FROM) * 100);
  const climb = (): Map<number, PilotMessage[]> =>
    new Map([
      [2, [pilot(1, 'REQUEST CLIMB TO FL390')]],
      [WILCO_AT, [pilot(2, 'WILCO', 3)]],
    ]);
  /** A seed whose climb request is cleared (10 % are refused due to traffic). */
  const seed = (() => {
    for (let k = 0; k < 100; k++) {
      const s = `lw-${k}`;
      const r = run(20, 37000, () => ({}), { seed: s, say: climb() });
      if (packets(r.out).includes('/data2/3/1/WU/CLIMB TO @FL390@')) return s;
    }
    throw new Error('no seed');
  })();
  const checks = (events: readonly AtcEvent[]) =>
    events.filter((e) => e.type === 'ATC_LEVEL_CHECK');
  const divert = (i: number): Link => (i >= DIVERT_AT ? { divert: altn.icao } : {});

  /** On the route, then (the diversion) about 70 NM north of the alternate: within the
   * descent distance from FL390. */
  const near = (i: number): LatLon =>
    i < DIVERT_AT ? pos : { lat: altn.lat + 70 / 60, lon: altn.lon };

  it('the descent after the diversion DESCEND TO is no departure from the old level', () => {
    const r = run(DESCEND_FROM + 400, alt(DIVERT_DESCENT_FT), divert, {
      seed,
      say: climb(),
      at: near,
    });
    const p = packets(r.out);
    expect(p.findIndex((x) => x.includes('DESCEND TO @10000FT@'))).toBeGreaterThan(-1);
    expect(checks(r.events)).toEqual([]);
  });

  it('the diversion descent is watched after its WILCO; reached, the watch ends', () => {
    const first = run(DIVERT_AT + 20, 39000, divert, { seed, say: climb(), at: near });
    const out = first.out.find((m) => m.message.lines.join(' ').includes('DESCEND TO'));
    const min = out?.cpdlc?.min as number;
    expect(min).toBeGreaterThan(3);
    const say = climb();
    say.set(DIVERT_AT + 25, [pilot(4, 'WILCO', min)]);
    // Not begun 5 min after the WILCO: asked about 10000 ft.
    const stay = run(DIVERT_AT + 25 + 70, (i) => alt(DIVERT_DESCENT_FT)(Math.min(i, 80)), divert, {
      seed,
      say,
      at: near,
    });
    expect(checks(stay.events)).toMatchObject([{ levelFt: DIVERT_DESCENT_FT, why: 'not_started' }]);
    // Down to 10000 ft and below it later (approach control by voice): no question.
    const down = run(DESCEND_FROM + 400, alt(3000), divert, { seed, say, at: near });
    expect(checks(down.events)).toEqual([]);
  });

  it('HOLD … MAINTAIN replaces the watched level', () => {
    const since = T0 + DIVERT_AT * STEP;
    const hold = (i: number): Link =>
      i >= DIVERT_AT && i < DESCEND_FROM ? { hold: { since, min: 15 } } : {};
    const r = run(DESCEND_FROM + 100, alt(30000), hold, { seed, say: climb() });
    expect(packets(r.out).some((x) => x.includes('HOLD AT @'))).toBe(true);
    expect(checks(r.events)).toEqual([]);
  });
});
