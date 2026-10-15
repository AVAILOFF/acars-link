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
  type OutboundMessage,
  type PilotMessage,
  parseSimbriefOfp,
  RopsStation,
  type TelemetrySnapshot,
} from '../src/index.js';

/** T48: the airline's diversion and holding reach the aircraft through the ROPS station. */

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

const tm = (t: number, altFt: number): TelemetrySnapshot => ({
  v: 1,
  t,
  ...pos,
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
  altFt: number,
  link: (i: number) => Link,
  o: { logon?: boolean; resumeAt?: number; seed?: string } = {},
) {
  const seed = o.seed ?? 'link';
  let st = new RopsStation(ofp, OPTIONS, { seed });
  const out: OutboundMessage[] = [];
  const events: AtcEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    if (i === o.resumeAt) st = new RopsStation(ofp, OPTIONS, { seed }, st.getState());
    const now = T0 + i * STEP;
    const r = st.tick({
      now,
      phase: 'CRUISE',
      telemetry: tm(now, altFt),
      inbound: i === 1 && o.logon !== false ? [logon] : [],
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

  it('survives a state round trip mid-hold', () => {
    const whole = run(100, 11000, holdOn);
    const split = run(100, 11000, holdOn, { resumeAt: 30 });
    expect(packets(split.out)).toEqual(packets(whole.out));
  });
});
