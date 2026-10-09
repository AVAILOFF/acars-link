import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AcarsCore,
  AUTO_DIRECTS_MAX,
  type CoreEvent,
  cpdlcPacket,
  createRng,
  cruiseSpan,
  DIRECT_TOD_MARGIN_NM,
  descentLevel,
  directCandidate,
  directTriggers,
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

describe('random Direct To', () => {
  const span = cruiseSpan(ofp);

  it('0–3 points per flight between TOC and TOD − 50 NM, from the seed', () => {
    expect(span).not.toBeNull();
    const counts = new Set<number>();
    for (let k = 0; k < 100; k++) {
      const t = directTriggers(ofp, `s${k}`);
      counts.add(t.length);
      expect(t.length).toBeLessThanOrEqual(AUTO_DIRECTS_MAX);
      expect([...t].sort((a, b) => a - b)).toEqual(t);
      for (const x of t) {
        expect(x).toBeGreaterThanOrEqual(span?.toc ?? 0);
        expect(x).toBeLessThanOrEqual((span?.tod ?? 0) - DIRECT_TOD_MARGIN_NM);
      }
    }
    expect([...counts].sort()).toEqual([0, 1, 2, 3]);
    expect(directTriggers(ofp, 'same')).toEqual(directTriggers(ofp, 'same'));
  });

  it('picks a fix of the FIR 50–250 NM ahead, off SID/STAR, that saves ≥ 2 NM', () => {
    // At MIDAI: M750 bends to Y53 at MADOG, so SUC … NIXOV save 2–3 NM, MADOG only 0.1.
    const r = onRoute('MADOG', 61);
    const pos = fix('MIDAI');
    const seen = new Set<string>();
    for (let k = 0; k < 50; k++) {
      const f = directCandidate(ofp, pos, r, 'RJJJ', () => null, createRng(`d${k}`));
      expect(f).not.toBeNull();
      if (f === null) continue;
      seen.add(f.ident);
      const ahead = f.cumDistNm - r.alongNm;
      expect(ahead).toBeGreaterThanOrEqual(50);
      expect(ahead).toBeLessThanOrEqual(250);
      expect(ahead - distanceNm(pos, f)).toBeGreaterThanOrEqual(2);
      expect(f.isSidStar || f.type === 'ltlg').toBe(false);
      expect(f.fir).toBe('RJJJ');
    }
    expect([...seen].sort()).toEqual(['ENKOV', 'NIXOV', 'OLBUG', 'SUC', 'UPGEB']);
    // In Taipei FIR the Fukuoka fixes are not ours.
    expect(directCandidate(ofp, pos, r, 'RCAA', () => null, createRng('x'))).toBeNull();
    // Near TOD only STAR fixes are 50 NM ahead: none.
    expect(
      directCandidate(ofp, fix('TOD'), onRoute('TOD'), 'RJJJ', () => null, createRng('y')),
    ).toBeNull();
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

  function fly(o: Ofp, seed: string, say: (i: number, s: { lon: number }) => PilotMessage[]) {
    const flight = generateSyntheticFlight({ ofp: o });
    const core = AcarsCore.create({ ofp: o, scenarios: [], seed, rops: { enabled: true } });
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
