import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type AtcEvent,
  cpdlcPacket,
  DEVIATION_MAX_NM,
  EMPTY_EXT,
  type FirArea,
  LEVEL_CHECK_MIN,
  type OutboundMessage,
  type PilotMessage,
  parseRequest,
  parseSimbriefOfp,
  RopsStation,
  type TelemetrySnapshot,
} from '../src/index.js';

/** T47: level watch, weather deviation, MAYDAY / PAN. */

const ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'ofp', 'rctp-rjbb-a35k-kgs.json'), 'utf8'),
  ),
);
const at = (ident: string) => ofp.navlog.findIndex((f) => f.ident === ident);
const FUKUOKA: FirArea = {
  id: 'RJJJ',
  name: 'Fukuoka',
  oceanic: false,
  polygons: [
    [
      [
        [120, 20],
        [150, 20],
        [150, 45],
        [120, 45],
        [120, 20],
      ],
    ],
  ],
};
const ext = { ...EMPTY_EXT, firs: [FUKUOKA] };
const melen = ofp.navlog[at('MELEN')];
const mumba = ofp.navlog[at('MUMBA')];
if (melen === undefined || mumba === undefined) throw new Error('fixture');
const T0 = Date.UTC(2026, 9, 8, 8, 30);
const STEP = 5000;
const OPTIONS = { enabled: true, randomDirects: false } as const;

const tm = (t: number, altFt: number): TelemetrySnapshot => ({
  v: 1,
  t,
  lat: (melen.lat + mumba.lat) / 2,
  lon: (melen.lon + mumba.lon) / 2,
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

const down = (min: number, text: string, mrn: number | null = null): PilotMessage => ({
  from: ofp.callsign,
  type: 'cpdlc',
  text: `/data2/${min}/${mrn ?? ''}/${mrn === null ? 'Y' : 'N'}/${text}`,
  to: 'XJJJ',
});

type Say = ReadonlyMap<number, readonly PilotMessage[]>;

function run(say: Say, ticks: number, altAt: (i: number) => number, seed: string, resumeAt = -1) {
  let st = new RopsStation(ofp, OPTIONS, { seed });
  const out: OutboundMessage[] = [];
  const events: AtcEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    // A state round trip in the middle (the app saves the flight state).
    if (i === resumeAt) st = new RopsStation(ofp, OPTIONS, { seed }, st.getState());
    const now = T0 + i * STEP;
    const r = st.tick({
      now,
      phase: 'CRUISE',
      telemetry: tm(now, altAt(i)),
      inbound: say.get(i) ?? [],
      ext,
    });
    out.push(...r.outbound);
    events.push(...r.events);
  }
  return { st, out, events };
}
const packets = (out: readonly OutboundMessage[]) =>
  out.map((m) => cpdlcPacket(m.cpdlc ?? { min: 0, mrn: null, ra: 'NE' }, m.message));

/** A seed whose climb request is cleared (10 % are refused due to traffic). */
function clearedSeed(): string {
  for (let k = 0; k < 100; k++) {
    const seed = `ctl-${k}`;
    const r = run(
      new Map([
        [1, [down(0, 'REQUEST LOGON')]],
        [2, [down(1, 'REQUEST CLIMB TO FL390')]],
      ]),
      20,
      () => 37000,
      seed,
    );
    if (packets(r.out).includes('/data2/3/1/WU/CLIMB TO @FL390@')) return seed;
  }
  throw new Error('no seed');
}
const SEED = clearedSeed();
const WILCO_AT = 30;
const base = (): Map<number, PilotMessage[]> =>
  new Map([
    [1, [down(0, 'REQUEST LOGON')]],
    [2, [down(1, 'REQUEST CLIMB TO FL390')]],
    [WILCO_AT, [down(20, 'WILCO', 3)]],
  ]);
const checks = (events: readonly AtcEvent[]) =>
  events.filter(
    (e): e is Extract<AtcEvent, { type: 'ATC_LEVEL_CHECK' }> => e.type === 'ATC_LEVEL_CHECK',
  );
const after = (min: number) => WILCO_AT + (min * 60_000) / STEP;

describe('level watch after a WILCO (T47)', () => {
  it('no climb 5 min after the WILCO: CONFIRM ASSIGNED ALTITUDE, once', () => {
    const r = run(base(), after(LEVEL_CHECK_MIN) + 120, () => 37000, SEED);
    const c = checks(r.events);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ station: 'XJJJ', levelFt: 39000, why: 'not_started' });
    expect(c[0]?.t).toBeGreaterThanOrEqual(T0 + WILCO_AT * STEP + LEVEL_CHECK_MIN * 60_000);
    const p = packets(r.out);
    expect(p.at(-1)).toMatch(/^\/data2\/4\/\/Y\/CONFIRM ASSIGNED ALTITUDE$/);
    expect(p.filter((x) => x.includes('CONFIRM'))).toHaveLength(1);
  });

  it('not before the 5 min are over', () => {
    const r = run(base(), after(LEVEL_CHECK_MIN) - 4, () => 37000, SEED);
    expect(checks(r.events)).toEqual([]);
  });

  it('a climb that began, then reached the level and stayed: no question', () => {
    const alt = (i: number) => Math.min(39000, 37000 + Math.max(0, i - WILCO_AT) * 100);
    const r = run(base(), after(20), alt, SEED);
    expect(checks(r.events)).toEqual([]);
  });

  it('left the assigned level after reaching it: asked once', () => {
    const alt = (i: number) => (i < WILCO_AT + 2 ? 37000 : i < WILCO_AT + 40 ? 39000 : 38000);
    const r = run(base(), after(10), alt, SEED);
    const c = checks(r.events);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ levelFt: 39000, why: 'departed' });
  });

  it('no WILCO (or UNABLE): nothing to watch', () => {
    const say = base();
    say.set(WILCO_AT, [down(20, 'UNABLE', 3)]);
    expect(checks(run(say, after(10), () => 37000, SEED).events)).toEqual([]);
    say.delete(WILCO_AT);
    expect(checks(run(say, after(10), () => 37000, SEED).events)).toEqual([]);
  });

  it('a WILCO to another message does not start the watch', () => {
    const say = base();
    say.set(WILCO_AT, [down(20, 'WILCO', 2)]);
    expect(checks(run(say, after(10), () => 37000, SEED).events)).toEqual([]);
  });

  it('survives a state round trip mid-watch', () => {
    const whole = run(base(), after(8), () => 37000, SEED);
    const split = run(base(), after(8), () => 37000, SEED, after(2));
    expect(checks(split.events)).toEqual(checks(whole.events));
    expect(checks(whole.events)).toHaveLength(1);
  });
});

describe('weather deviation (T47)', () => {
  it('parses DM27', () => {
    expect(parseRequest('REQUEST WEATHER DEVIATION UP TO 15NM LEFT OF ROUTE')).toEqual({
      kind: 'deviation',
      nm: 15,
      side: 'LEFT',
    });
    expect(
      parseRequest('REQUEST WEATHER DEVIATION UP TO 5 NM RIGHT OF ROUTE DUE TO WEATHER'),
    ).toMatchObject({ nm: 5, side: 'RIGHT' });
    expect(parseRequest('REQUEST WEATHER DEVIATION UP TO LEFT')).toBeNull();
  });

  it('clears up to 10 NM; a larger request is cleared for 10', () => {
    const say = new Map([
      [1, [down(0, 'REQUEST LOGON')]],
      [2, [down(1, 'REQUEST WEATHER DEVIATION UP TO 5NM RIGHT OF ROUTE')]],
      [30, [down(2, 'REQUEST WEATHER DEVIATION UP TO 25NM LEFT OF ROUTE')]],
    ]);
    const r = run(say, 60, () => 37000, 'dev');
    const p = packets(r.out);
    expect(p).toContain('/data2/3/1/WU/CLEARED TO DEVIATE UP TO @5NM@ @RIGHT@ OF ROUTE');
    expect(p).toContain(
      `/data2/4/2/WU/CLEARED TO DEVIATE UP TO @${DEVIATION_MAX_NM}NM@ @LEFT@ OF ROUTE`,
    );
    expect(p.join(' ')).not.toContain('NOT SUPPORTED');
  });
});

describe('MAYDAY and PAN (T47)', () => {
  it('ROGER at once, event for the airline chain', () => {
    const say = new Map([
      [1, [down(0, 'REQUEST LOGON')]],
      [3, [down(1, 'MAYDAY MAYDAY MAYDAY')]],
      [8, [down(2, 'PAN PAN PAN')]],
    ]);
    const r = run(say, 12, () => 37000, 'em');
    const p = packets(r.out);
    expect(p).toContain('/data2/3/1/NE/ROGER MAYDAY');
    expect(p).toContain('/data2/4/2/NE/ROGER PAN');
    expect(r.out.find((m) => m.message.text.includes('ROGER MAYDAY'))?.t).toBe(T0 + 3 * STEP);
    expect(r.events.filter((e) => e.type === 'ATC_EMERGENCY')).toMatchObject([
      { kind: 'MAYDAY', station: 'XJJJ' },
      { kind: 'PAN', station: 'XJJJ' },
    ]);
  });
});
