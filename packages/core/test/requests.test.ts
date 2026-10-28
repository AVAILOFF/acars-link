// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type AtcEvent,
  aircraftLimits,
  checkLevel,
  cpdlcPacket,
  decide,
  EMPTY_EXT,
  EVEN_LEVELS_FT,
  type FirArea,
  levelRule,
  ODD_LEVELS_FT,
  type Ofp,
  type OutboundMessage,
  type PilotMessage,
  parseRequest,
  parseSimbriefOfp,
  type RequestContext,
  routePosition,
  starEntryIndex,
  type TelemetrySnapshot,
  TRAFFIC_HOLD_MS,
  XatcStation,
} from '../src/index.js';

/** T25: cruising levels, pilot requests and the station's answers. */

const ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'ofp', 'rctp-rjbb-a35k-kgs.json'), 'utf8'),
  ),
);
const at = (ident: string) => ofp.navlog.findIndex((f) => f.ident === ident);
const FL = (fl: number) => fl * 100;

describe('cruising level table (SERA App. 3 / ICAO Annex 2 App. 3)', () => {
  it('odd and even levels with RVSM FL290–410 and 4000 ft above', () => {
    expect(ODD_LEVELS_FT.slice(0, 3)).toEqual([1000, 3000, 5000]);
    expect(ODD_LEVELS_FT.slice(-5)).toEqual([37000, 39000, 41000, 45000, 49000]);
    expect(EVEN_LEVELS_FT.slice(0, 3)).toEqual([2000, 4000, 6000]);
    expect(EVEN_LEVELS_FT.slice(-6)).toEqual([36000, 38000, 40000, 43000, 47000, 51000]);
    expect(ODD_LEVELS_FT).toContain(FL(290));
    expect(EVEN_LEVELS_FT).toContain(FL(280));
    expect(EVEN_LEVELS_FT).toContain(FL(300));
    expect(ODD_LEVELS_FT).not.toContain(FL(430));
    expect(EVEN_LEVELS_FT).not.toContain(FL(420));
  });

  it('ICAO: 000–179 odd, 180–359 even (an odd level westbound is refused "direction")', () => {
    expect(checkLevel(FL(350), 'EDGG', 90, null)).toEqual({ ok: true });
    expect(checkLevel(FL(350), 'EDGG', 179, null)).toEqual({ ok: true });
    expect(checkLevel(FL(350), 'EDGG', 180, null)).toEqual({ ok: false, why: 'direction' });
    expect(checkLevel(FL(360), 'EDGG', 270, null)).toEqual({ ok: true });
    expect(checkLevel(FL(360), 'EDGG', 0, null)).toEqual({ ok: false, why: 'direction' });
    // Italy: ICAO until its ENR 1.7 is read (approved 2026-10-09).
    expect(levelRule('LIRR', FL(370)).id).toBe('ICAO');
  });

  it('Spain and Portugal (AIP ENR 1.7): 090–269 odd, 270–089 even', () => {
    // Madrid → Sevilla, MT ~210: odd (ICAO would give even).
    expect(checkLevel(FL(350), 'LECM', 210, null)).toEqual({ ok: true });
    expect(checkLevel(FL(360), 'LECM', 210, null)).toEqual({ ok: false, why: 'direction' });
    // Barcelona → Paris, MT ~010: even.
    expect(checkLevel(FL(360), 'LECB', 10, null)).toEqual({ ok: true });
    expect(checkLevel(FL(370), 'GCCC', 10, null)).toEqual({ ok: false, why: 'direction' });
    expect(checkLevel(FL(370), 'LPPC', 90, null)).toEqual({ ok: true });
    expect(checkLevel(FL(370), 'LPPC', 269, null)).toEqual({ ok: true });
    expect(checkLevel(FL(370), 'LPPC', 270, null)).toEqual({ ok: false, why: 'direction' });
    expect(levelRule('LPPO', FL(370)).source).toContain('Portugal');
  });

  it('France: the Spanish rule in the UTA only (AIC A 06/20), ICAO below', () => {
    expect(checkLevel(FL(370), 'LFFF', 180, null)).toEqual({ ok: true });
    expect(checkLevel(FL(380), 'LFFF', 180, null)).toEqual({ ok: false, why: 'direction' });
    // FL150 southbound is below the UTA: ICAO, even.
    expect(checkLevel(FL(160), 'LFFF', 180, null)).toEqual({ ok: true });
    expect(checkLevel(FL(150), 'LFFF', 180, null)).toEqual({ ok: false, why: 'direction' });
  });

  it('New Zealand FIR (CAA NZ Part 91): 270–089 odd, 090–269 even', () => {
    expect(checkLevel(FL(370), 'NZZC', 0, null)).toEqual({ ok: true });
    expect(checkLevel(FL(370), 'NZZC', 180, null)).toEqual({ ok: false, why: 'direction' });
    expect(checkLevel(FL(380), 'NZZC', 180, null)).toEqual({ ok: true });
    // Auckland Oceanic is not in Part 91's "New Zealand FIR": ICAO.
    expect(levelRule('NZZO', FL(380)).id).toBe('ICAO');
  });

  it("adds the leg's SimBrief airway limits; ignores them when they share no level with ours", () => {
    const m750 = ofp.navlog[at('MAMOD')]?.validLevelsFt ?? null; // FL270+, odd
    expect(checkLevel(FL(390), 'RJJJ', 56, m750)).toEqual({ ok: true });
    expect(checkLevel(FL(250), 'RJJJ', 56, m750)).toEqual({ ok: false, why: 'airway' });
    // Parity is ours even when SimBrief lists the level for the other direction.
    expect(checkLevel(FL(380), 'RJJJ', 56, [FL(380), FL(400)])).toEqual({
      ok: false,
      why: 'direction',
    });
    expect(checkLevel(FL(350), 'RJJJ', 56, [FL(380), FL(400)])).toEqual({ ok: true });
  });
});

describe('aircraft limits (EASA TCDS)', () => {
  it('ceilings and VMO/MMO of the listed types; unknown types are not checked', () => {
    expect(aircraftLimits('A20N')).toEqual({ ceilingFt: 39_800, vmoKt: 350, mmo: 0.82 });
    expect(aircraftLimits('a35k')?.ceilingFt).toBe(41_450);
    expect(aircraftLimits('A359')?.ceilingFt).toBe(43_100);
    expect(aircraftLimits('B38M')?.ceilingFt).toBe(41_000);
    expect(aircraftLimits('B77W')?.ceilingFt).toBe(43_100);
    expect(aircraftLimits('B78X')).toEqual({ ceilingFt: 41_100, vmoKt: 350, mmo: 0.9 });
    expect(aircraftLimits('B748')?.mmo).toBe(0.9);
    expect(aircraftLimits('A388')).toBeNull();
    expect(aircraftLimits('C172')).toBeNull();
  });
});

describe('pilot requests (FBW A32NX downlink formats)', () => {
  it('parses level, speed and Direct To requests', () => {
    expect(parseRequest('REQUEST CLIMB TO FL370')).toEqual({
      kind: 'level',
      levelFt: 37000,
      asFl: true,
    });
    expect(parseRequest('REQUEST DESCEND TO 11000FT')).toEqual({
      kind: 'level',
      levelFt: 11000,
      asFl: false,
    });
    expect(parseRequest('REQUEST FL 390')).toMatchObject({ levelFt: 39000 });
    expect(parseRequest('REQUEST CLIMB TO FL390 DUE TO WEATHER')).toMatchObject({ levelFt: 39000 });
    expect(parseRequest('REQUEST M.78')).toEqual({ kind: 'speed', mach: 0.78, kt: null });
    expect(parseRequest('REQUEST .8')).toEqual({ kind: 'speed', mach: 0.8, kt: null });
    expect(parseRequest('REQUEST 280KT')).toEqual({ kind: 'speed', mach: null, kt: 280 });
    expect(parseRequest('REQUEST 250')).toEqual({ kind: 'speed', mach: null, kt: 250 });
    expect(parseRequest('REQUEST DIRECT TO MADOG')).toEqual({ kind: 'direct', fix: 'MADOG' });
    for (const no of ['REQUEST LOGON', 'REQUEST VOICE CONTACT', 'REQUEST CRUISE CLIMB TO FL390']) {
      expect(parseRequest(no)).toBeNull();
    }
  });
});

describe('decisions', () => {
  const ctx = (o: Partial<RequestContext> & { next: string; alt: number }): RequestContext => ({
    ofp: o.ofp ?? ofp,
    altFt: o.alt,
    route: { next: at(o.next), alongNm: 0, offNm: 0 },
    fir: o.fir === undefined ? null : o.fir,
    firAt: o.firAt ?? (() => null),
  });
  const level = (fl: number) => ({ kind: 'level', levelFt: FL(fl), asFl: true }) as const;

  it('clears a level that fits the table, the airway and the aircraft (WU)', () => {
    // On M750 (MT 056) in RJJJ at FL370.
    const c = ctx({ next: 'MELEN', alt: 37000, fir: 'RJJJ' });
    expect(decide(level(390), c)).toEqual({
      approved: true,
      text: 'CLIMB TO @FL390@',
      ra: 'WU',
      why: null,
    });
    expect(decide(level(350), c)).toMatchObject({ text: 'DESCEND TO @FL350@', ra: 'WU' });
    expect(decide(level(370), c)).toMatchObject({ text: 'MAINTAIN @FL370@' });
  });

  it('refuses with the right reason: direction, airway, ceiling, RVSM, MORA', () => {
    const c = ctx({ next: 'MELEN', alt: 37000, fir: 'RJJJ' });
    // An even level eastbound: the reason is the airspace (direction of flight).
    expect(decide(level(380), c)).toEqual({
      approved: false,
      text: 'UNABLE@_@DUE TO AIRSPACE RESTRICTION',
      ra: 'N',
      why: 'direction',
    });
    expect(decide(level(250), c)).toMatchObject({ why: 'airway' });
    // A350-1000: 41 450 ft.
    expect(decide(level(450), c)).toMatchObject({ text: 'UNABLE', why: 'ceiling' });
    const noRvsm: Ofp = { ...ofp, aircraft: { ...ofp.aircraft, equip: 'SDFGRY' } };
    expect(decide(level(370), ctx({ ofp: noRvsm, next: 'MELEN', alt: 27000 }))).toMatchObject({
      why: 'rvsm',
    });
    expect(decide(level(270), ctx({ ofp: noRvsm, next: 'MELEN', alt: 25000 }))).toMatchObject({
      approved: true,
    });
    // BB651: MT 321 (even), MORA 6200 ft.
    const low = ctx({ next: 'BB651', alt: 15000 });
    const ft = (n: number) => ({ kind: 'level', levelFt: n, asFl: false }) as const;
    expect(decide(ft(6000), low)).toMatchObject({ text: 'UNABLE', why: 'mora' });
    expect(decide(ft(8000), low)).toMatchObject({ text: 'DESCEND TO @8000FT@', approved: true });
  });

  it('speeds: 250 kt below FL100, VMO/MMO from the TCDS', () => {
    const kt = (n: number) => ({ kind: 'speed', mach: null, kt: n }) as const;
    const mach = (m: number) => ({ kind: 'speed', mach: m, kt: null }) as const;
    const low = ctx({ next: 'BB651', alt: 8000 });
    expect(decide(kt(280), low)).toMatchObject({ approved: false, why: 'speed_limit' });
    expect(decide(kt(250), low)).toMatchObject({ text: 'MAINTAIN @250KT@', ra: 'WU' });
    const high = ctx({ next: 'MELEN', alt: 37000 });
    expect(decide(kt(320), high)).toMatchObject({ approved: true });
    expect(decide(mach(0.85), high)).toMatchObject({ text: 'MAINTAIN @M.85@' });
    const a320: Ofp = { ...ofp, aircraft: { ...ofp.aircraft, icao: 'A320' } };
    expect(decide(mach(0.84), ctx({ ofp: a320, next: 'MELEN', alt: 37000 }))).toMatchObject({
      why: 'mmo',
    });
    expect(decide(kt(360), ctx({ ofp: a320, next: 'MELEN', alt: 30000 }))).toMatchObject({
      why: 'vmo',
    });
  });

  it('Direct To: a fix ahead, in the FIR, up to the STAR entry', () => {
    expect(starEntryIndex(ofp.navlog)).toBe(at('NIXOV'));
    const direct = (fix: string) => ({ kind: 'direct', fix }) as const;
    const c = ctx({ next: 'MELEN', alt: 37000, fir: 'RJJJ' });
    expect(decide(direct('MADOG'), c)).toEqual({
      approved: true,
      text: 'PROCEED DIRECT TO @MADOG@',
      ra: 'WU',
      why: null,
    });
    expect(decide(direct('NIXOV'), c)).toMatchObject({ approved: true });
    expect(decide(direct('BIKLO'), c)).toMatchObject({ why: 'beyond_star' });
    expect(decide(direct('MOLKA'), c)).toMatchObject({ why: 'not_ahead' });
    expect(decide(direct('LOGAN'), c)).toMatchObject({ why: 'not_ahead' });
    expect(decide(direct('TOD'), c)).toMatchObject({ why: 'not_ahead' });
    // In Taipei FIR the Fukuoka fixes are another unit's.
    const taipei = ctx({ next: 'KIKIT', alt: 30000, fir: 'RCAA' });
    expect(decide(direct('MOLKA'), taipei)).toMatchObject({ approved: true });
    expect(decide(direct('MUMBA'), taipei)).toMatchObject({ why: 'other_fir' });
  });

  it('finds the leg the aircraft is on', () => {
    const melen = ofp.navlog[at('MELEN')];
    const mumba = ofp.navlog[at('MUMBA')];
    if (melen === undefined || mumba === undefined) throw new Error('fixture');
    const mid = { lat: (melen.lat + mumba.lat) / 2, lon: (melen.lon + mumba.lon) / 2 };
    const r = routePosition(ofp, mid);
    expect(r.next).toBe(at('MELEN'));
    expect(r.offNm).toBeLessThan(1);
    expect(r.alongNm).toBeGreaterThan(mumba.cumDistNm);
    expect(r.alongNm).toBeLessThan(melen.cumDistNm);
    expect(routePosition(ofp, ofp.origin).next).toBe(0);
  });
});

describe('XATC station answers requests (T25)', () => {
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
  const tm = (t: number): TelemetrySnapshot => ({
    v: 1,
    t,
    lat: (melen.lat + mumba.lat) / 2,
    lon: (melen.lon + mumba.lon) / 2,
    altFt: 37000,
    aglFt: 37000,
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
  const cpdlc = (min: number, text: string): PilotMessage => ({
    from: ofp.callsign,
    type: 'cpdlc',
    text: `/data2/${min}//Y/${text}`,
    to: 'XJJJ',
  });

  /** Ticks every 5 s; `say` maps a tick index to the aircraft's messages. */
  function run(say: ReadonlyMap<number, readonly PilotMessage[]>, ticks: number, seed = 'req') {
    const st = new XatcStation(ofp, { enabled: true }, { seed });
    const out: OutboundMessage[] = [];
    const events: AtcEvent[] = [];
    for (let i = 0; i < ticks; i++) {
      const now = T0 + i * 5000;
      const r = st.tick({
        now,
        phase: 'CRUISE',
        telemetry: tm(now),
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

  it('answers after 20–60 s with the request as mrn; WILCO needs nothing', () => {
    const r = run(
      new Map([
        [1, [cpdlc(0, 'REQUEST LOGON')]],
        [2, [cpdlc(1, 'REQUEST CLIMB TO FL390')]],
        [30, [{ ...cpdlc(2, 'WILCO'), text: '/data2/2/3/N/WILCO' }]],
      ]),
      40,
    );
    const p = packets(r.out);
    expect(p.slice(0, 2)).toEqual([
      '/data2/1/0/NE/LOGON ACCEPTED',
      '/data2/2//NE/CURRENT ATC UNIT@_@XJJJ@_@FUKUOKA CTL',
    ]);
    expect(p).toHaveLength(3);
    expect(['/data2/3/1/WU/CLIMB TO @FL390@', '/data2/3/1/N/UNABLE@_@DUE TO TRAFFIC']).toContain(
      p[2],
    );
    const sent = r.out[2]?.t as number;
    const asked = T0 + 2 * 5000;
    expect(sent - asked).toBeGreaterThanOrEqual(20_000);
    expect(sent - asked).toBeLessThanOrEqual(65_000);
    expect(r.events.find((e) => e.type === 'ATC_REQUEST')).toMatchObject({
      station: 'XJJJ',
      request: 'REQUEST CLIMB TO FL390',
    });
  });

  it('requests need a logon: otherwise "not supported", as before T25', () => {
    const r = run(new Map([[1, [cpdlc(0, 'REQUEST CLIMB TO FL390')]]]), 20);
    expect(packets(r.out)).toEqual(['/data2/1/0/NE/MESSAGE NOT SUPPORTED BY THIS ATS UNIT']);
  });

  it('traffic refusals: ~10 % of allowed level requests, never twice in a row, held 5 min', () => {
    // 200 flights × one allowed request each, then a run of alternating requests.
    let refused = 0;
    for (let k = 0; k < 200; k++) {
      const r = run(
        new Map([
          [1, [cpdlc(0, 'REQUEST LOGON')]],
          [2, [cpdlc(1, 'REQUEST CLIMB TO FL390')]],
        ]),
        16,
        `seed-${k}`,
      );
      const e = r.events.find((x) => x.type === 'ATC_REQUEST');
      if (e?.type === 'ATC_REQUEST' && e.why === 'traffic') refused += 1;
    }
    expect(refused).toBeGreaterThan(5);
    expect(refused).toBeLessThan(40);

    const say = new Map<number, PilotMessage[]>([[1, [cpdlc(0, 'REQUEST LOGON')]]]);
    for (let i = 1; i <= 60; i++) {
      say.set(i * 20, [cpdlc(i, `REQUEST CLIMB TO FL${i % 2 === 0 ? 390 : 410}`)]);
    }
    const r = run(say, 61 * 20);
    const answers = r.events.filter(
      (e): e is Extract<AtcEvent, { type: 'ATC_REQUEST' }> => e.type === 'ATC_REQUEST',
    );
    expect(answers).toHaveLength(60);
    const traffic = answers.map((e) => e.why === 'traffic');
    expect(traffic.some(Boolean)).toBe(true);
    for (let i = 1; i < traffic.length; i++) expect(traffic[i - 1] && traffic[i]).toBe(false);
  });

  it('the same level again within 5 min is refused again, later it is cleared', () => {
    // Find a seed whose first request is refused due to traffic.
    let seed = '';
    for (let k = 0; k < 500 && seed === ''; k++) {
      const r = run(
        new Map([
          [1, [cpdlc(0, 'REQUEST LOGON')]],
          [2, [cpdlc(1, 'REQUEST CLIMB TO FL390')]],
        ]),
        16,
        `hold-${k}`,
      );
      const e = r.events.find((x) => x.type === 'ATC_REQUEST');
      if (e?.type === 'ATC_REQUEST' && e.why === 'traffic') seed = `hold-${k}`;
    }
    expect(seed).not.toBe('');
    const later = 2 + TRAFFIC_HOLD_MS / 5000 + 1;
    const r = run(
      new Map([
        [1, [cpdlc(0, 'REQUEST LOGON')]],
        [2, [cpdlc(1, 'REQUEST CLIMB TO FL390')]],
        [20, [cpdlc(2, 'REQUEST CLIMB TO FL390')]],
        [later, [cpdlc(3, 'REQUEST CLIMB TO FL390')]],
      ]),
      later + 20,
      seed,
    );
    const why = r.events.flatMap((e) => (e.type === 'ATC_REQUEST' ? [e.why] : []));
    expect(why).toEqual(['traffic', 'traffic', null]);
  });

  it('is deterministic and survives a state round trip with replies pending', () => {
    const say = new Map([
      [1, [cpdlc(0, 'REQUEST LOGON')]],
      [2, [cpdlc(1, 'REQUEST M.85'), cpdlc(2, 'REQUEST DIRECT TO MADOG')]],
    ]);
    const a = run(say, 20);
    const b = run(say, 20);
    expect(packets(a.out)).toEqual(packets(b.out));
    // Each reply has its own delay: here the second request is answered first.
    expect(packets(a.out).slice(2)).toEqual([
      '/data2/3/2/WU/PROCEED DIRECT TO @MADOG@',
      '/data2/4/1/WU/MAINTAIN @M.85@',
    ]);

    const first = new XatcStation(ofp, { enabled: true }, { seed: 'req' });
    for (let i = 0; i < 4; i++) {
      const now = T0 + i * 5000;
      first.tick({ now, phase: 'CRUISE', telemetry: tm(now), inbound: say.get(i) ?? [], ext });
    }
    expect(first.getState().req?.pending).toHaveLength(2);
    const second = new XatcStation(ofp, { enabled: true }, { seed: 'req' }, first.getState());
    const out: OutboundMessage[] = [];
    for (let i = 4; i < 20; i++) {
      const now = T0 + i * 5000;
      out.push(
        ...second.tick({ now, phase: 'CRUISE', telemetry: tm(now), inbound: [], ext }).outbound,
      );
    }
    expect(packets(out)).toEqual(packets(a.out).slice(2));
  });
});
