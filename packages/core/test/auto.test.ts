import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AcarsCore,
  type CoreEvent,
  cpdlcPacket,
  createRng,
  cruiseSpan,
  DIRECT_MIN_SAVING_NM,
  DIRECT_TOD_MARGIN_NM,
  descentLevel,
  directDecision,
  directExit,
  distanceNm,
  type FirArea,
  generateSyntheticFlight,
  type Ofp,
  type OutboundMessage,
  type PilotMessage,
  parseSimbriefOfp,
  type RoutePosition,
  stepStatus,
} from '../src/index.js';

/** T26: random Direct To, step climbs and the descent clearance. */

const raw = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'ofp', 'rctp-rjbb-a35k-kgs.json'), 'utf8'),
);
const ofp = parseSimbriefOfp(raw);
const withSteps = (steps: string): Ofp =>
  parseSimbriefOfp({ ...raw, general: { ...raw.general, stepclimb_string: steps } });
const at = (ident: string) => ofp.navlog.findIndex((f) => f.ident === ident);
const fix = (ident: string) => {
  const f = ofp.navlog[at(ident)];
  if (f === undefined) throw new Error(ident);
  return f;
};
const onRoute = (ident: string, before = 0): RoutePosition => ({
  next: at(ident),
  alongNm: fix(ident).cumDistNm - before,
  offNm: 0,
});

describe('OFP step climbs (general.stepclimb_string)', () => {
  it('skips the origin pair and malformed tokens', () => {
    expect(ofp.stepClimbs).toEqual([]);
    expect(withSteps('RCTP/0390 MELEN/0410 junk UPGEB/0430').stepClimbs).toEqual([
      { ident: 'MELEN', levelFt: 41000 },
      { ident: 'UPGEB', levelFt: 43000 },
    ]);
  });
});

describe('random Direct To (T38: FIR exit point)', () => {
  const span = cruiseSpan(ofp);
  const firAt = () => null;

  it('decision: 50 % of the FIRs, delay 1–5 min, only from seed and FIR', () => {
    let yes = 0;
    for (let k = 0; k < 400; k++) {
      const d = directDecision(`s${k}`, 'RJJJ');
      if (d.issue) yes++;
      expect(d.delayMs).toBeGreaterThanOrEqual(60_000);
      expect(d.delayMs).toBeLessThanOrEqual(300_000);
    }
    expect(yes).toBeGreaterThan(150);
    expect(yes).toBeLessThan(250);
    expect(directDecision('same', 'RCAA')).toEqual(directDecision('same', 'RCAA'));
  });

  // The synthetic route is straight, so the saving is made by a route position 8 NM short of
  // the aircraft's real one (as after a dogleg of the OFP): MELEN is then 249 NM ahead.
  const pos = fix('MAMOD');
  const r = { next: at('MUMBA'), alongNm: fix('MAMOD').cumDistNm - 8, offNm: 0 };

  it('names the farthest fix of the FIR within 250 NM and TOD − 50 NM, off SID/STAR, saving ≥ 5 NM', () => {
    const e = directExit(ofp, pos, r, 'RJJJ', firAt, -1);
    expect(e?.fix.ident).toBe('MELEN');
    if (e === null) return;
    expect(ofp.navlog[e.idx]).toBe(e.fix);
    const ahead = e.fix.cumDistNm - r.alongNm;
    expect(ahead).toBeLessThanOrEqual(250);
    expect(e.fix.cumDistNm).toBeLessThanOrEqual((span?.tod ?? 0) - DIRECT_TOD_MARGIN_NM);
    expect(ahead - distanceNm(pos, e.fix)).toBeGreaterThanOrEqual(DIRECT_MIN_SAVING_NM);
    // A farther fix of the FIR is out of range (INVAM is 270 NM ahead).
    expect(fix('INVAM').cumDistNm - r.alongNm).toBeGreaterThan(250);
    // Less than 5 NM saved: none.
    expect(directExit(ofp, pos, { ...r, alongNm: r.alongNm + 6 }, 'RJJJ', firAt, -1)).toBeNull();
  });

  it('never the fix already given nor one behind it', () => {
    const first = directExit(ofp, pos, r, 'RJJJ', firAt, -1);
    expect(first?.idx).toBe(at('MELEN'));
    expect(directExit(ofp, pos, r, 'RJJJ', firAt, first?.idx ?? -1)).toBeNull();
    expect(directExit(ofp, pos, r, 'RJJJ', firAt, ofp.navlog.length)).toBeNull();
  });

  it('nothing to cut: the exit is the next fix; a foreign FIR; near TOD', () => {
    expect(directExit(ofp, pos, { ...r, next: at('MELEN') }, 'RJJJ', firAt, -1)).toBeNull();
    expect(directExit(ofp, pos, r, 'RCAA', firAt, -1)).toBeNull();
    expect(directExit(ofp, fix('TOD'), onRoute('TOD'), 'RJJJ', firAt, -1)).toBeNull();
    // The FIR holds one route fix ahead (MUMBA, the next one): no Direct To.
    const one = directExit(ofp, pos, r, 'RJJJ', (p) => (p === fix('MUMBA') ? 'RJJJ' : 'XXXX'), -1);
    expect(one).toBeNull();
  });
});

describe('step climbs', () => {
  const step = { ident: 'MADOG', levelFt: 41000 };

  it('due 2 min before the fix, dropped long after it', () => {
    expect(stepStatus(ofp, step, onRoute('MADOG', 100), 480, 'RJJJ')).toBe('wait');
    expect(stepStatus(ofp, step, onRoute('MADOG', 15), 480, 'RJJJ')).toBe('due');
    expect(stepStatus(ofp, step, onRoute('MADOG', -10), 480, 'RJJJ')).toBe('due');
    expect(stepStatus(ofp, step, onRoute('MADOG', -25), 480, 'RJJJ')).toBe('skip');
    expect(stepStatus(ofp, { ident: 'NOWHERE', levelFt: 41000 }, onRoute('MADOG'), 480, null)).toBe(
      'skip',
    );
  });

  it('skips a level that is not a cruising level after the fix (MT 046 east: odd only)', () => {
    expect(
      stepStatus(ofp, { ident: 'MADOG', levelFt: 40000 }, onRoute('MADOG', 5), 480, 'RJJJ'),
    ).toBe('skip');
  });
});

describe('descent clearance level', () => {
  it('the OFP altitude at the STAR entry, rounded up; FL at or above the transition level', () => {
    // NIXOV (STAR NIXOVB entry) at 24 800 ft in the OFP → FL250; RJBB TL 14 000 ft.
    expect(descentLevel(ofp, onRoute('UPGEB'))).toEqual({ levelFt: 25000, text: 'FL250' });
  });

  it('without a STAR: remaining MORA + 1000 ft, in feet below the transition level', () => {
    const noStar: Ofp = { ...ofp, navlog: ofp.navlog.map((f) => ({ ...f, isSidStar: false })) };
    // Max MORA after BB651: 6200 ft → 7200 → 8000 ft.
    expect(descentLevel(noStar, onRoute('BB651'))).toEqual({ levelFt: 8000, text: '8000FT' });
  });

  it('without transition data: 18 000 ft in the US and Canada, elsewhere a flight level', () => {
    const noStar: Ofp = { ...ofp, navlog: ofp.navlog.map((f) => ({ ...f, isSidStar: false })) };
    const noTl = (icao: string): Ofp => ({
      ...noStar,
      destination: { ...noStar.destination, icao, transLevelFt: null, transAltFt: null },
    });
    expect(descentLevel(noTl('RJBB'), onRoute('BB651'))?.text).toBe('FL080');
    expect(descentLevel(noTl('KJFK'), onRoute('BB651'))?.text).toBe('8000FT');
    expect(descentLevel(noTl('PHNL'), onRoute('BB651'))?.text).toBe('8000FT');
    expect(descentLevel(noTl('CYYZ'), onRoute('BB651'))?.text).toBe('8000FT');
    const withStar: Ofp = {
      ...ofp,
      destination: { ...ofp.destination, icao: 'KJFK', transLevelFt: null, transAltFt: null },
    };
    expect(descentLevel(withStar, onRoute('UPGEB'))?.text).toBe('FL250');
  });
});

describe('ROPS station sends clearances on its own (T26)', () => {
  const TAIPEI: FirArea = {
    id: 'RCAA',
    name: 'Taipei',
    oceanic: false,
    polygons: [
      [
        [
          [115, 18],
          [125.5, 18],
          [125.5, 30],
          [115, 30],
          [115, 18],
        ],
      ],
    ],
  };
  const FUKUOKA: FirArea = {
    id: 'RJJJ',
    name: 'Fukuoka',
    oceanic: false,
    polygons: [
      [
        [
          [125.5, 20],
          [150, 20],
          [150, 45],
          [125.5, 45],
          [125.5, 20],
        ],
      ],
    ],
  };

  function fly(
    o: Ofp,
    seed: string,
    say: (i: number, s: { lon: number }) => PilotMessage[],
    randomDirects?: boolean,
  ) {
    const flight = generateSyntheticFlight({ ofp: o });
    const rops = { enabled: true, ...(randomDirects === undefined ? {} : { randomDirects }) };
    const core = AcarsCore.create({ ofp: o, scenarios: [], seed, rops });
    core.startFlight();
    const out: OutboundMessage[] = [];
    const events: CoreEvent[] = [];
    let station = 'XCAA';
    let min = 0;
    flight.snapshots.forEach((s, i) => {
      const inbound: PilotMessage[] = [];
      // Log on at the start and to Fukuoka after the boundary (as FBW does on HANDOVER).
      if (i === 10 || (station === 'XCAA' && s.lon >= 125.6)) {
        if (i !== 10) station = 'XJJJ';
        inbound.push({
          from: o.callsign,
          type: 'cpdlc',
          text: `/data2/${min++}//Y/REQUEST LOGON`,
          to: station,
        });
      }
      inbound.push(...say(i, s).map((m) => ({ ...m, text: m.text.replace('#', String(min++)) })));
      const r = core.tick({
        now: s.t,
        telemetry: s,
        ...(inbound.length === 0 ? {} : { inbound }),
        ...(i === 0 ? { data: { t: s.t, firs: [TAIPEI, FUKUOKA] } } : {}),
      });
      out.push(...r.outbound);
      events.push(...r.events);
    });
    return { out, events };
  }
  const autos = (r: { out: OutboundMessage[] }) =>
    r.out
      .filter((m) => m.cpdlc?.mrn === null && m.cpdlc.ra === 'WU')
      .map((m) => cpdlcPacket(m.cpdlc ?? { min: 0, mrn: null, ra: 'WU' }, m.message).split('/')[5]);

  it('step climb at MADOG, at most 3 Direct To, one descent clearance (WU, no mrn)', () => {
    const o = withSteps('RCTP/0390 MADOG/0410');
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const r = fly(o, seed, () => []);
      const texts = autos(r);
      expect(texts.filter((t) => t === 'CLIMB TO @FL410@')).toHaveLength(1);
      expect(texts.filter((t) => t === 'DESCEND TO @FL250@')).toHaveLength(1);
      expect(texts.filter((t) => t?.startsWith('PROCEED DIRECT TO')).length).toBeLessThanOrEqual(3);
      expect(texts.at(-1)).toBe('DESCEND TO @FL250@');
      const ev = r.events.filter((e) => e.type === 'ATC_AUTO');
      expect(ev.map((e) => (e.type === 'ATC_AUTO' ? e.kind : ''))).toContain('step');
    }
    // Deterministic.
    expect(autos(fly(o, 'a', () => []))).toEqual(autos(fly(o, 'a', () => [])));
  });

  // The OFP route is 20 NM longer than its fixes' geometry from MELEN on (as after a dogleg
  // the aircraft cuts), so MELEN, the exit of the Fukuoka stretch in range, saves ≥ 5 NM.
  const bent: Ofp = {
    ...withSteps('RCTP/0390 MADOG/0410'),
    navlog: ofp.navlog.map((f, i) =>
      i >= at('MELEN') ? { ...f, cumDistNm: f.cumDistNm + 20 } : f,
    ),
  };
  const directs = (o: Ofp, seed: string, randomDirects?: boolean) =>
    autos(fly(o, seed, () => [], randomDirects)).filter((t) => t?.startsWith('PROCEED DIRECT TO'));

  it('random Direct To: at most one per FIR, to the exit fix, never the same fix twice', () => {
    const got: Record<string, number> = {};
    for (let k = 0; k < 20; k++) {
      const d = directs(bent, `d${k}`);
      expect(d.length).toBeLessThanOrEqual(2);
      expect(new Set(d).size).toBe(d.length);
      for (const t of d) got[t ?? ''] = (got[t ?? ''] ?? 0) + 1;
    }
    expect(Object.keys(got).length).toBeGreaterThan(0);
    // Deterministic.
    expect(directs(bent, 'd1')).toEqual(directs(bent, 'd1'));
  });

  it('random Direct To can be turned off; step climb and descent stay', () => {
    const seed = Array.from({ length: 20 }, (_, k) => `d${k}`).find(
      (x) => directs(bent, x).length > 0,
    );
    expect(seed).toBeDefined();
    const off = autos(fly(bent, seed ?? '', () => [], false));
    expect(off).toEqual(['CLIMB TO @FL410@', 'DESCEND TO @FL250@']);
  });

  it('no step climb when the pilot already asked for that level', () => {
    const o = withSteps('RCTP/0390 MADOG/0410');
    let asked = false;
    const r = fly(o, 'a', (_i, s) => {
      if (asked || s.lon < 127) return [];
      asked = true;
      return [
        { from: o.callsign, type: 'cpdlc', text: '/data2/#//Y/REQUEST CLIMB TO FL410', to: 'XJJJ' },
      ];
    });
    expect(asked).toBe(true);
    expect(r.events.filter((e) => e.type === 'ATC_AUTO' && e.kind === 'step')).toEqual([]);
  });
});
