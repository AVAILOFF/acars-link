import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type AtcEvent,
  CLA_TIMEOUT_MS,
  CLX_DELAY_S,
  DEFAULT_PROFILE,
  distanceNm,
  EMPTY_EXT,
  type FirArea,
  interpolate,
  type NatTrack,
  type OclContext,
  type OclEvent,
  OclService,
  type Ofp,
  type OfpFix,
  type OutboundMessage,
  type PilotMessage,
  parseRcl,
  parseSimbriefOfp,
  pointText,
  type TelemetrySnapshot,
  trackPoint,
  XatcStation,
} from '../src/index.js';

/**
 * T27: oceanic clearance in the NAT. Synthetic EGLL–KJFK OFP on track E of the real natTrak
 * answer of 2026-10-09 (`SUNOT 58/20 60/30 60/40 59/50 AVUTI`, FL340–400, valid
 * 11:30–19:00Z). Only the lat/long points are from the track message; the named fixes'
 * positions and the FIRs of the fixes are made up for the test.
 */

const kg = parseSimbriefOfp(
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'ofp', 'rctp-rjbb-a35k-kgs.json'), 'utf8'),
  ),
);

type FixSpec = readonly [string, string, number, number, string, number | null];

function navlog(specs: readonly FixSpec[], origin: { lat: number; lon: number }): OfpFix[] {
  let prev = origin;
  let cum = 0;
  return specs.map(([ident, type, lat, lon, fir, trackMag], i) => {
    const leg = distanceNm(prev, { lat, lon });
    cum += leg;
    prev = { lat, lon };
    return {
      ident,
      type,
      stage: i < 2 ? 'CLB' : ident === 'TOD' ? 'DSC' : 'CRZ',
      lat,
      lon,
      viaAirway: null,
      isSidStar: false,
      altitudeFt: i < 1 ? 20_000 : 36_000,
      legDistNm: Math.round(leg),
      cumDistNm: Math.round(cum),
      trackMag,
      moraFt: null,
      fir,
      validLevelsFt: null,
    };
  });
}

const EGLL = { lat: 51.4706, lon: -0.4619 };
const ROUTE: readonly FixSpec[] = [
  ['BPK', 'vor', 51.75, -0.1, 'EGTT', 30],
  ['TOC', 'ltlg', 52.4, -1.3, 'EGTT', 320],
  ['SUNOT', 'wpt', 58.0, -15.0, 'EGPX', 315],
  ['58N020W', 'ltlg', 58, -20, 'EGGX', 285],
  ['60N030W', 'ltlg', 60, -30, 'EGGX', 290],
  ['60N040W', 'ltlg', 60, -40, 'CZQX', 285],
  ['59N050W', 'ltlg', 59, -50, 'CZQX', 270],
  ['AVUTI', 'wpt', 58.2, -60.0, 'CZQX', 265],
  ['TOD', 'ltlg', 42.1, -70.6, 'KZBW', 230],
];

/** The synthetic OFP; `fir` = SimBrief FIR of the first lat/long point (the oceanic area). */
function natOfp(fir = 'EGGX'): Ofp {
  const fixes = ROUTE.map(
    (f): FixSpec => (f[0] === '58N020W' ? [f[0], f[1], f[2], f[3], fir, f[5]] : f),
  );
  return {
    ...kg,
    callsign: 'BAW117',
    origin: { ...kg.origin, icao: 'EGLL', iata: 'LHR', ...EGLL },
    destination: { ...kg.destination, icao: 'KJFK', iata: 'JFK', lat: 40.6398, lon: -73.7789 },
    alternates: [],
    route: 'BPK SUNOT 58N020W 60N030W 60N040W 59N050W AVUTI',
    times: { ...kg.times, estTimeEnrouteSec: 7 * 3600 },
    navlog: navlog(fixes, EGLL),
    stepClimbs: [],
  };
}

const TRACK_E: NatTrack = {
  ident: 'E',
  route: ['SUNOT', '58/20', '60/30', '60/40', '59/50', 'AVUTI'],
  validFrom: Date.parse('2026-10-09T11:30:00Z'),
  validTo: Date.parse('2026-10-09T19:00:00Z'),
  levelsFt: [34000, 35000, 36000, 37000, 38000, 39000, 40000],
};
const T0 = Date.parse('2026-10-09T12:00:00Z');
/** Slow, so that 100 min before SUNOT is still on the TOC–SUNOT leg. */
const GS = 300;

/** The aircraft `minutes` before SUNOT at 300 kt, on the TOC–SUNOT leg. */
function before(ofp: Ofp, minutes: number, t: number): TelemetrySnapshot {
  const toc = ofp.navlog[1] as OfpFix;
  const sunot = ofp.navlog[2] as OfpFix;
  const leg = sunot.cumDistNm - toc.cumDistNm;
  const p = interpolate(toc, sunot, Math.max(0, 1 - (minutes / 60) * (GS / leg)));
  return {
    v: 1,
    t,
    lat: p.lat,
    lon: p.lon,
    altFt: 36000,
    aglFt: 36000,
    iasKt: 260,
    gsKt: GS,
    vsFpm: 0,
    hdgTrue: 315,
    onGround: false,
    parkingBrake: false,
    beacon: true,
    engRunning: [true, true],
    engN2: [90, 90],
    fuelKg: 60000,
    gearDown: false,
    flapsIdx: 0,
    doorsOpen: [],
    xpdrState: 4,
    simRate: 1,
    paused: false,
    aircraftTitle: 'A320',
  };
}

/** The FlyByWire RCL (`OclMessage.serialize`), free text last. */
const RCL = (more = 'MAX F380', cs = 'BAW117', oep = 'SUNOT', req = 'M.85 FL360') =>
  `OCEANIC REQUEST\n${cs} \nENTRY POINT:${oep}\nAT:1348Z \nREQ:${req}\n${more}`;

/** A wide display, so the CLX keeps its lines as written. */
const WIDE = { ...DEFAULT_PROFILE, id: 'wide', lineWidth: 60 };

interface Sent {
  readonly from: string;
  readonly text: string;
  readonly t: number;
}

/** Drives an OclService: the RCL `minutes` before the OEP at T0, then 5 s ticks. */
function exchange(
  o: {
    ofp?: Ofp;
    minutes?: number;
    rcl?: string;
    tracks?: readonly NatTrack[];
    /** ROGER this long after the CLX; null = never. */
    rogerAfterMs?: number | null;
    runMs?: number;
    svc?: OclService;
  } = {},
) {
  const ofp = o.ofp ?? natOfp();
  const svc = o.svc ?? new OclService(ofp, 'ocl', WIDE);
  const out: Sent[] = [];
  const events: OclEvent[] = [];
  const minutes = o.minutes ?? 60;
  const ctx = (now: number): OclContext => ({
    now,
    telemetry: before(ofp, minutes - (now - T0) / 60_000, now),
    natTracks: o.tracks ?? [TRACK_E],
    firAt: () => null,
    sendTelex: (from, m) => out.push({ from, text: m.text, t: now }),
    events,
  });
  const rcl = parseRcl(o.rcl ?? RCL());
  const handled = rcl !== null && svc.receive(rcl, 'XGPX', ctx(T0));
  const end = T0 + (o.runMs ?? 15 * 60_000);
  const roger = o.rogerAfterMs === undefined ? 60_000 : o.rogerAfterMs;
  let clxAt: number | null = null;
  for (let now = T0 + 5000; now <= end; now += 5000) {
    svc.tick(ctx(now));
    if (clxAt === null && out.some((m) => m.text.startsWith('CLX'))) clxAt = now;
    if (clxAt !== null && roger !== null && now === clxAt + roger) svc.acknowledge(ctx(now));
  }
  return { ofp, svc, out, events, handled, texts: out.map((m) => m.text) };
}

const flat = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ');

describe('RCL parsing (FlyByWire OclMessage layout)', () => {
  it('reads callsign, OEP, ETO, Mach, level and MAX from the free text', () => {
    expect(parseRcl(RCL())).toEqual({
      callsign: 'BAW117',
      oep: 'SUNOT',
      eto: '1348',
      mach: 85,
      levelFt: 36000,
      maxFt: 38000,
    });
    // `M.8` is M.80; `MAX FL360`; Hoppie text collapsed to one line.
    expect(
      parseRcl('OCEANIC REQUEST BAW117 ENTRY POINT:SUNOT AT:1348Z REQ:M.8 FL360 MAX FL360'),
    ).toMatchObject({ mach: 80, maxFt: 36000 });
    expect(parseRcl(RCL('', 'BAW117', 'SUNOT', 'FL360'))).toMatchObject({
      mach: null,
      levelFt: null,
      maxFt: null,
    });
    expect(parseRcl('REQUEST CLIMB TO FL360')).toBeNull();
  });

  it('writes lat/long points as in an ICAO flight plan, reads track message points', () => {
    const p = (lat: number, lon: number) => pointText({ ident: 'X', type: 'ltlg', lat, lon });
    expect([p(58, -20), p(55.5, -20), p(-5, 10)]).toEqual(['58N020W', '5530N02000W', '05S010E']);
    expect(pointText({ ident: 'SUNOT', type: 'wpt', lat: 58, lon: -15 })).toBe('SUNOT');
    expect(trackPoint('58/20')).toEqual({ lat: 58, lon: -20 });
    expect(trackPoint('5530/20')).toEqual({ lat: 55.5, lon: -20 });
    expect(trackPoint('SUNOT')).toBeNull();
  });
});

describe('Shanwick: RCL, CLX, CLA (NAT OPS Bulletin 2020_001 §12)', () => {
  it('on track E: RCL RECEIVED at once, the CLX after 2–10 min, CLA RECEIVED on ROGER', () => {
    const r = exchange();
    expect(r.handled).toBe(true);
    expect(r.out.every((m) => m.from === 'XGPX')).toBe(true);
    expect(flat(r.texts[0])).toBe(
      'RCL RECEIVED IF NO CLEARANCE WITHIN 15 MINUTES CONTACT SHANWICK BY VOICE',
    );
    expect(r.out[0]?.t).toBe(T0);
    const clx = r.out[1] as Sent;
    expect(clx.t - T0).toBeGreaterThanOrEqual(CLX_DELAY_S[0] * 1000);
    expect(clx.t - T0).toBeLessThanOrEqual(CLX_DELAY_S[1] * 1000);
    const iso = new Date(clx.t).toISOString();
    const hhmm = iso.slice(11, 13) + iso.slice(14, 16);
    const lines = clx.text.split('\n');
    expect(lines[0]).toMatch(new RegExp(`^CLX ${hhmm} 261009 EGGX CLRNCE \\d{3}$`));
    expect(lines.slice(1)).toEqual([
      'BAW117 CLRD TO KJFK VIA SUNOT',
      'NAT E',
      '58N020W 60N030W 60N040W 59N050W AVUTI',
      'FM SUNOT/1348 MNTN F360 M085',
      'END OF MESSAGE',
    ]);
    expect(r.texts[2]).toBe('CLA RECEIVED\nCLEARANCE CONFIRMED\nEND OF MESSAGE');
    expect(r.events.map((e) => e.what)).toEqual(['received', 'clearance', 'confirmed']);
    expect(r.events[1]?.detail).toBe('NAT E F360 M085');
  });

  it('a level the track does not have: the nearest not above MAX, ATC/ LEVEL CHANGE', () => {
    const r = exchange({ rcl: RCL('MAX F410', 'BAW117', 'SUNOT', 'M.85 FL410') });
    const clx = r.texts.find((t) => t.startsWith('CLX')) ?? '';
    expect(clx).toContain('FM SUNOT/1348 MNTN F400 M085\nATC/ LEVEL CHANGE\nEND OF MESSAGE');
  });

  it('no allowed level at or below MAX: negotiation by voice, no clearance', () => {
    const r = exchange({ rcl: RCL('MAX F330', 'BAW117', 'SUNOT', 'M.85 FL330') });
    expect(r.texts.map(flat)).toEqual([
      'RCL/CLA RECEIVED NEGOTIATION REQUIRED CONTACT SHANWICK BY VOICE',
    ]);
    expect(r.events.map((e) => [e.what, e.detail])).toEqual([['rejected', 'no level']]);
  });

  it('off the tracks: RANDOM ROUTE, levels by the T25 table (westbound: even)', () => {
    const r = exchange({ tracks: [], rcl: RCL('MAX F370', 'BAW117', 'SUNOT', 'M.84 FL350') });
    const clx = (r.texts.find((t) => t.startsWith('CLX')) ?? '').split('\n');
    expect(clx[2]).toBe('RANDOM ROUTE');
    // FL350 is odd; FL340 and FL360 are as near: the lower one.
    expect(clx[4]).toBe('FM SUNOT/1348 MNTN F340 M084');
    expect(clx[5]).toBe('ATC/ LEVEL CHANGE');
  });

  it('a track that is not valid at 30W is a random route', () => {
    const r = exchange({ tracks: [{ ...TRACK_E, validTo: T0 + 30 * 60_000 }] });
    expect(r.texts.find((t) => t.startsWith('CLX'))).toContain('\nRANDOM ROUTE\n');
  });

  it('no CLA within 10 min: CLEARANCE CANCELLED REVERT TO VOICE PROCEDURES', () => {
    const r = exchange({ rogerAfterMs: null, runMs: 25 * 60_000 });
    const clx = r.out.find((m) => m.text.startsWith('CLX')) as Sent;
    const cancel = r.out.at(-1) as Sent;
    expect(flat(cancel.text)).toBe('CLEARANCE CANCELLED REVERT TO VOICE PROCEDURES');
    expect(cancel.t - clx.t).toBe(CLA_TIMEOUT_MS);
    expect(r.events.map((e) => e.what)).toEqual(['received', 'clearance', 'cancelled']);
  });

  it('a second RCL while the first is processed is rejected', () => {
    const ofp = natOfp();
    const first = exchange({ ofp, runMs: 5000 });
    const again = exchange({ ofp, svc: first.svc, runMs: 5000 });
    expect(flat(again.texts[0])).toBe(
      'RCL REJECTED REQUEST BEING PROCESSED AWAIT TRANSACTION COMPLETION',
    );
  });

  it('after a confirmed clearance a new RCL gives a reclearance with the changes', () => {
    const ofp = natOfp();
    const first = exchange({ ofp });
    const second = exchange({
      ofp,
      svc: first.svc,
      rcl: RCL('MAX F380', 'BAW117', 'SUNOT', 'M.84 FL380'),
    });
    const clx = second.texts.find((t) => t.startsWith('CLX')) ?? '';
    expect(clx).toContain('MNTN F380 M084\nATC/ LEVEL CHANGE MACH CHANGE RECLEARANCE 1\n');
  });

  it('the state survives a round trip mid-transaction', () => {
    const ofp = natOfp();
    const a = exchange({ ofp, runMs: 5000 });
    const svc = new OclService(ofp, 'ocl', WIDE, JSON.parse(JSON.stringify(a.svc.getState())));
    const b = exchange({ ofp, svc, rcl: 'NOT AN RCL' });
    const whole = exchange({ ofp });
    expect(b.texts).toEqual(whole.texts.slice(1));
  });
});

describe('RCL errors and windows (2020_001 §4.5, §10; 2023_001 rev 6 §2.2)', () => {
  const first = (o: Parameters<typeof exchange>[0]) =>
    flat(exchange({ runMs: 5000, ...o }).texts[0]);

  it('Shanwick: 90–30 min before the OEP', () => {
    expect(first({ minutes: 100 })).toBe('RCL REJECTED RCL SENT TOO EARLY');
    expect(first({ minutes: 20 })).toBe(
      'RCL REJECTED RCL RECEIVED TOO LATE REVERT TO VOICE PROCEDURES',
    );
    expect(first({ minutes: 85 })).toMatch(/^RCL RECEIVED IF NO CLEARANCE/);
    expect(first({ minutes: 35 })).toMatch(/^RCL RECEIVED IF NO CLEARANCE/);
  });

  it('wrong callsign, OEP not on the route ahead, bad Mach or level', () => {
    expect(first({ rcl: RCL('', 'BAW118') })).toBe('RCL REJECTED FLIGHT PLAN NOT HELD');
    expect(first({ rcl: RCL('', 'BAW117', 'RATSU') })).toBe(
      'RCL REJECTED INVALID OEP RESUBMIT YOUR REQUEST',
    );
    expect(first({ rcl: RCL('', 'BAW117', 'SUNOT', 'M.95 FL360') })).toBe(
      'RCL REJECTED INVALID MACH NO RESUBMIT YOUR REQUEST',
    );
    expect(first({ rcl: RCL('', 'BAW117', 'SUNOT', 'M.85 FL365') })).toBe(
      'RCL REJECTED INVALID LEVEL RESUBMIT YOUR REQUEST',
    );
  });

  it('Gander, Santa Maria, Bodø: RCL RECEIVED BY …, no clearance; their windows', () => {
    const at = (fir: string, minutes: number) =>
      exchange({ ofp: natOfp(fir), minutes, runMs: 15 * 60_000 });
    const gander = at('CZQX', 75);
    expect(gander.texts).toEqual(['RCL RECEIVED BY GANDER']);
    expect(gander.events.map((e) => [e.oca, e.what])).toEqual([['CZQX', 'received']]);
    expect(flat(at('CZQX', 50).texts[0])).toMatch(/TOO LATE/);
    expect(at('LPPO', 120).texts).toEqual(['RCL RECEIVED BY SANTA MARIA']);
    expect(flat(at('LPPO', 35).texts[0])).toMatch(/TOO LATE/);
    expect(at('ENOB', 25).texts).toEqual(['RCL RECEIVED BY BODO']);
    // VATSpy's id of Gander Oceanic.
    expect(at('CZQO', 75).texts).toEqual(['RCL RECEIVED BY GANDER']);
  });

  it('Reykjavik and New York need no RCL', () => {
    expect(exchange({ ofp: natOfp('BIRD') }).texts).toEqual(['RCL NOT REQUIRED BY BIRD']);
    expect(exchange({ ofp: natOfp('KZWY') }).texts).toEqual(['RCL NOT REQUIRED BY KZWY']);
  });

  it('a route without a NAT oceanic area is not handled here', () => {
    const oep = (kg.navlog[5] as OfpFix).ident;
    const r = exchange({ ofp: kg, rcl: RCL('', kg.callsign, oep) });
    expect(r.handled).toBe(false);
    expect(r.texts).toEqual([]);
  });
});

describe('through the XATC station (Hoppie packets)', () => {
  const ofp = natOfp();
  const square = (w: number, s: number, e: number, n: number) => [
    [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ] as [number, number][],
    ],
  ];
  const SCOTTISH: FirArea = {
    id: 'EGPX',
    name: 'Scottish',
    oceanic: false,
    airports: true,
    polygons: square(-15, 50, 0, 61),
  };
  const ext = { ...EMPTY_EXT, firs: [SCOTTISH], natTracks: [TRACK_E] };
  const cpdlc = (min: number, text: string, mrn = '', ra = 'N'): PilotMessage => ({
    from: 'BAW117',
    type: 'cpdlc',
    text: `/data2/${min}/${mrn}/${ra}/${text}`,
    to: 'XGPX',
  });

  it('logon, the RCL as a CPDLC packet, telex answers from the station, ROGER = CLA', () => {
    const st = new XatcStation(ofp, { enabled: true, randomDirects: false }, { seed: 'ocl' });
    const out: OutboundMessage[] = [];
    const events: AtcEvent[] = [];
    let clx: number | null = null;
    for (let i = 0; i < 200; i++) {
      const now = T0 + i * 5000;
      let inbound: PilotMessage[] = [];
      if (i === 1) inbound = [cpdlc(1, 'REQUEST LOGON', '', 'Y')];
      if (i === 2) inbound = [cpdlc(2, RCL())];
      if (clx !== null && i === clx + 6) inbound = [cpdlc(3, 'ROGER', '9')];
      const r = st.tick({
        now,
        phase: 'CRUISE',
        telemetry: before(ofp, 60 - (i * 5) / 60, now),
        inbound,
        ext,
      });
      out.push(...r.outbound);
      events.push(...r.events);
      if (clx === null && r.outbound.some((m) => m.message.text.startsWith('CLX'))) clx = i;
    }
    const telex = out.filter((m) => m.kind === 'telex');
    expect(telex.map((m) => [m.from, m.message.text.split('\n')[0]])).toEqual([
      ['XGPX', 'RCL RECEIVED'],
      ['XGPX', expect.stringMatching(/^CLX \d{4} 261009 EGGX$/)],
      ['XGPX', 'CLA RECEIVED'],
    ]);
    expect(telex.every((m) => m.to === 'BAW117' && m.toPilot)).toBe(true);
    // Neither the RCL nor the ROGER is "not supported".
    expect(events.some((e) => e.type === 'ATC_UNSUPPORTED')).toBe(false);
    const ocl = events.filter((e): e is OclEvent => e.type === 'ATC_OCL');
    expect(ocl.map((e) => e.what)).toEqual(['received', 'clearance', 'confirmed']);
    expect(st.getState().ocl?.cleared?.track).toBe('E');
  });

  it('an RCL on a route without a NAT area: MESSAGE NOT SUPPORTED, as before T27', () => {
    const st = new XatcStation(kg, { enabled: true }, { seed: 'ocl' });
    const fukuoka: FirArea = {
      ...SCOTTISH,
      id: 'RJJJ',
      name: 'Fukuoka',
      polygons: square(120, 20, 150, 45),
    };
    const e = { ...EMPTY_EXT, firs: [fukuoka] };
    const mid = kg.navlog[Math.floor(kg.navlog.length / 2)] as OfpFix;
    const tm = { ...before(ofp, 60, T0), lat: mid.lat, lon: mid.lon };
    const say = (min: number, text: string): PilotMessage => ({
      ...cpdlc(min, text),
      from: kg.callsign,
      to: 'XJJJ',
    });
    const tick = (i: number, inbound: PilotMessage[]) =>
      st.tick({ now: T0 + i * 5000, phase: 'CRUISE', telemetry: tm, inbound, ext: e });
    tick(0, []);
    tick(1, [say(1, 'REQUEST LOGON')]);
    const oep = (kg.navlog[5] as OfpFix).ident;
    const r = tick(2, [say(2, RCL('', kg.callsign, oep))]);
    expect(r.outbound.map((m) => m.message.text)).toEqual([
      'MESSAGE NOT SUPPORTED BY THIS ATS UNIT',
    ]);
  });
});
