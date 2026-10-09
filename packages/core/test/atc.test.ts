import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AcarsCore,
  atcUnitName,
  type CenterStation,
  type CoreEvent,
  CPDLC_PROFILE,
  cpdlcPacket,
  DEFAULT_PROFILE,
  type FirArea,
  FirMap,
  formatCpdlc,
  formatMessage,
  generateSyntheticFlight,
  type OutboundMessage,
  type PilotMessage,
  parseCpdlc,
  parseSimbriefOfp,
  ROPS_ID,
  ropsStation,
} from '../src/index.js';

/** T23: CPDLC packets, FIR lookup and the ROPS station. */

const ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'ofp', 'rctp-rjbb-a35k-kgs.json'), 'utf8'),
  ),
);
const flight = generateSyntheticFlight({ ofp });

describe('CPDLC packets', () => {
  it('parses downlinks seen from real aircraft (docs/06: A350/A380 via Hoppie)', () => {
    expect(parseCpdlc('/data2/0//Y/REQUEST LOGON')).toEqual({
      min: 0,
      mrn: null,
      ra: 'Y',
      text: 'REQUEST LOGON',
    });
    expect(parseCpdlc('/data2/1//Y/LOGOFF')).toMatchObject({ min: 1, text: 'LOGOFF' });
    // A WILCO to message 42 (format of the X-Plane Hoppie client tests).
    expect(parseCpdlc('/data2/43/42/N/WILCO')).toEqual({
      min: 43,
      mrn: 42,
      ra: 'N',
      text: 'WILCO',
    });
    // Markers and separators are dropped, a `/` inside the text is kept.
    expect(parseCpdlc('/DATA2/5//WU/CURRENT ATC UNIT@_@EDGG@_@LANGEN CTL')?.text).toBe(
      'CURRENT ATC UNIT EDGG LANGEN CTL',
    );
    expect(parseCpdlc('/data2/7//N/REQUEST DIRECT TO ABC/DEF')?.text).toBe(
      'REQUEST DIRECT TO ABC/DEF',
    );
  });

  it('rejects what is not a /data2/ packet', () => {
    for (const bad of ['REQUEST LOGON', '/data1/1//Y/X', '/data2/x//Y/X', '/data2/1//ZZ/X', '']) {
      expect(parseCpdlc(bad)).toBeNull();
    }
  });

  it('builds uplinks like real Hoppie stations: LOGON ACCEPTED, CURRENT ATC UNIT, HANDOVER', () => {
    expect(cpdlcPacket({ min: 1, mrn: 0, ra: 'NE' }, formatCpdlc('LOGON ACCEPTED'))).toBe(
      '/data2/1/0/NE/LOGON ACCEPTED',
    );
    expect(
      cpdlcPacket(
        { min: 2, mrn: null, ra: 'NE' },
        formatCpdlc('CURRENT ATC UNIT@_@XDGG@_@LANGEN CTL'),
      ),
    ).toBe('/data2/2//NE/CURRENT ATC UNIT@_@XDGG@_@LANGEN CTL');
    expect(cpdlcPacket({ min: 3, mrn: null, ra: 'NE' }, formatCpdlc('handover @XDMM'))).toBe(
      '/data2/3//NE/HANDOVER @XDMM',
    );
  });

  it('keeps an uplink on one line without `/` and `{}` and accepts only CPDLC-formatted text', () => {
    const long = formatCpdlc(`${'WORD '.repeat(30)}A/B {C}`);
    const packet = cpdlcPacket({ min: 9, mrn: null, ra: 'R' }, long);
    expect(packet.split('/')).toHaveLength(6);
    expect(packet).not.toMatch(/[{}\n]/);
    expect(long.dropped).toEqual(['/']);
    expect(packet.endsWith('AB (C)')).toBe(true);
    expect(CPDLC_PROFILE.allowedChars).toContain('@');
    expect(() =>
      cpdlcPacket({ min: 1, mrn: null, ra: 'R' }, formatMessage('X', DEFAULT_PROFILE)),
    ).toThrow(TypeError);
  });
});

const square = (
  id: string,
  [w, s, e, n]: readonly [number, number, number, number],
  extra: Partial<FirArea> = {},
): FirArea => ({
  id,
  name: id,
  oceanic: false,
  polygons: [
    [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ],
  ],
  ...extra,
});

describe('FIR lookup', () => {
  it('finds the FIR of a point; the larger of two overlapping areas wins (TMA inside a FIR)', () => {
    const map = new FirMap([
      square('AAAA', [0, 0, 10, 10]),
      square('BBBB', [10, 0, 20, 10]),
      square('AATM', [2, 2, 4, 4]),
    ]);
    expect(map.locate({ lat: 5, lon: 5 })?.id).toBe('AAAA');
    expect(map.locate({ lat: 3, lon: 3 })?.id).toBe('AAAA');
    expect(map.locate({ lat: 5, lon: 15 })?.id).toBe('BBBB');
    expect(map.locate({ lat: 20, lon: 5 })).toBeNull();
  });

  it('prefers airport FIRs over larger overlays without airports (EGVV/EDXX in VATSpy)', () => {
    const map = new FirMap([
      square('EDGG', [5, 48, 10, 51], { airports: true }),
      square('EDXX', [0, 45, 20, 56], { airports: false }),
    ]);
    expect(map.locate({ lat: 50, lon: 8 })?.id).toBe('EDGG');
    // Outside every airport FIR the overlay is still found (oceanic FIRs have no airports).
    expect(map.locate({ lat: 46, lon: 15 })?.id).toBe('EDXX');
  });

  it('treats a hole as outside', () => {
    const holed: FirArea = {
      ...square('HOLE', [0, 0, 10, 10]),
      polygons: [
        [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0],
          ],
          [
            [4, 4],
            [6, 4],
            [6, 6],
            [4, 6],
            [4, 4],
          ],
        ],
      ],
    };
    const map = new FirMap([holed]);
    expect(map.locate({ lat: 1, lon: 1 })?.id).toBe('HOLE');
    expect(map.locate({ lat: 5, lon: 5 })).toBeNull();
  });

  it('station callsigns: X + FIR (ICAO has no X… indicators)', () => {
    expect(ropsStation('EDGG')).toBe('XDGG');
    expect(ropsStation('KZNY')).toBe('XZNY');
    expect(() => ropsStation('ADR')).toThrow(RangeError);
  });

  it('unit names from VATSpy names, in the forms of real Hoppie stations', () => {
    expect(atcUnitName({ name: 'Langen', oceanic: false })).toBe('LANGEN CTL');
    expect(atcUnitName({ name: 'Shanwick Oceanic', oceanic: false })).toBe('SHANWICK OCA');
    expect(atcUnitName({ name: 'New York', oceanic: true })).toBe('NEW YORK OCA');
    expect(atcUnitName({ name: 'Reykjavik ACC (East) - Reykjavik', oceanic: false })).toBe(
      'REYKJAVIK CTL',
    );
    expect(atcUnitName({ name: 'Mount Pleasant (Monte Agradable)', oceanic: false })).toBe(
      'MOUNT PLEASANT CTL',
    );
    expect(atcUnitName({ name: 'Shannon ACC - Shannon', oceanic: false })).toBe('SHANNON CTL');
    expect(atcUnitName({ name: 'Melbourne (Gundagai) 133.15', oceanic: false })).toBe(
      'MELBOURNE CTL',
    );
  });
});

// The synthetic RCTP → RJBB flight crosses lon 125.5 in cruise: two rectangular FIRs.
const TAIPEI = square('RCAA', [115, 18, 125.5, 30], { name: 'Taipei' });
const FUKUOKA = square('RJJJ', [125.5, 20, 150, 45], { name: 'Fukuoka' });
const T0 = flight.snapshots[0]?.t as number;
const crossing = flight.snapshots.findIndex((s) => s.lon >= 125.5);

const logon = (to: string, min = 0): PilotMessage => ({
  from: ofp.callsign,
  type: 'cpdlc',
  text: `/data2/${min}//Y/REQUEST LOGON`,
  to,
});
const logoff = (to: string, min = 1): PilotMessage => ({
  from: ofp.callsign,
  type: 'cpdlc',
  text: `/data2/${min}//N/LOGOFF`,
  to,
});

interface Run {
  readonly core: AcarsCore;
  readonly out: OutboundMessage[];
  readonly events: CoreEvent[];
  readonly listen: (readonly string[])[];
}

function fly(
  say: ReadonlyMap<number, readonly PilotMessage[]>,
  o: {
    centers?: readonly CenterStation[];
    /** Snapshot index of the VATSIM update (default 0). */
    centersAt?: number;
    standAside?: boolean;
    firs?: readonly FirArea[];
  } = {},
): Run {
  const core = AcarsCore.create({
    ofp,
    scenarios: [],
    seed: 'atc',
    rops: { enabled: true, ...(o.standAside === undefined ? {} : { standAside: o.standAside }) },
  });
  core.startFlight();
  const out: OutboundMessage[] = [];
  const events: CoreEvent[] = [];
  const listen: (readonly string[])[] = [];
  flight.snapshots.forEach((s, i) => {
    const inbound = say.get(i);
    const centers = o.centers !== undefined && i === (o.centersAt ?? 0) ? o.centers : undefined;
    const data =
      i === 0 || centers !== undefined
        ? {
            t: s.t,
            ...(i === 0 ? { firs: o.firs ?? [TAIPEI, FUKUOKA] } : {}),
            ...(centers === undefined ? {} : { centers }),
          }
        : undefined;
    const r = core.tick({
      now: s.t,
      telemetry: s,
      ...(inbound === undefined ? {} : { inbound }),
      ...(data === undefined ? {} : { data }),
    });
    out.push(...r.outbound);
    events.push(...r.events);
    listen.push(r.listen);
  });
  return { core, out, events, listen };
}

const packets = (r: Run) =>
  r.out.map(
    (m) => `${m.from} ${cpdlcPacket(m.cpdlc ?? { min: 0, mrn: null, ra: 'NE' }, m.message)}`,
  );
const atcEvents = (r: Run) => r.events.filter((e) => e.type.startsWith('ATC_'));

describe('ROPS station', () => {
  it('is off unless enabled: no listening, no events', () => {
    const core = AcarsCore.create({ ofp, scenarios: [], seed: 'atc' });
    core.startFlight();
    const r = core.tick({
      now: T0,
      telemetry: flight.snapshots[0] ?? null,
      data: { t: T0, firs: [TAIPEI] },
      inbound: [logon('XCAA')],
    });
    expect(r.listen).toEqual([]);
    expect(core.atc).toBeNull();
  });

  it('logon, handover at the FIR boundary, logon to the next station, logoff on block', () => {
    const r = fly(
      new Map([
        [10, [logon('XCAA')]],
        [crossing + 5, [logoff('XCAA', 1), logon('XJJJ', 2)]],
      ]),
    );
    expect(packets(r)).toEqual([
      'XCAA /data2/1/0/NE/LOGON ACCEPTED',
      'XCAA /data2/2//NE/CURRENT ATC UNIT@_@XCAA@_@TAIPEI CTL',
      'XCAA /data2/3//NE/HANDOVER @XJJJ',
      'XJJJ /data2/1/2/NE/LOGON ACCEPTED',
      'XJJJ /data2/2//NE/CURRENT ATC UNIT@_@XJJJ@_@FUKUOKA CTL',
      // T26: a random Direct To (seed "atc") and the descent clearance before TOD.
      'XJJJ /data2/3//WU/PROCEED DIRECT TO @UPGEB@',
      'XJJJ /data2/4//WU/DESCEND TO @FL250@',
      'XJJJ /data2/5//NE/LOGOFF',
    ]);
    expect(r.out.every((m) => m.kind === 'cpdlc' && m.scenarioId === ROPS_ID && m.toPilot)).toBe(
      true,
    );
    expect(r.out[2]?.t).toBe(flight.snapshots[crossing]?.t);
    expect(atcEvents(r).map((e) => e.type)).toEqual([
      'ATC_STATION',
      'ATC_LOGON',
      'ATC_STATION',
      'ATC_HANDOVER',
      'ATC_LOGOFF',
      'ATC_LOGON',
      'ATC_AUTO',
      'ATC_AUTO',
      'ATC_LOGOFF',
    ]);
    // Polled: the FIR's station (and the DCL station on the ground, T24); during the handover
    // also the old one; nothing on block.
    expect(r.listen[0]).toEqual(['XCAA', 'XCTP']);
    expect(r.listen[crossing]).toEqual(['XCAA', 'XJJJ']);
    expect(r.listen[crossing + 5]).toEqual(['XJJJ']);
    expect(r.listen.at(-1)).toEqual([]);
    expect(r.core.atc).toEqual({ station: null, connected: null, dcl: null });
  });

  it('ignores unpolled stations, refuses a logon to the old station, "not supported" for the rest', () => {
    const r = fly(
      new Map([
        [
          10,
          [
            // XJJJ is not polled yet (the aircraft is in RCAA): never answered.
            logon('XJJJ'),
            logon('XCAA', 1),
            {
              from: ofp.callsign,
              type: 'cpdlc',
              text: '/data2/2//Y/REQUEST VOICE CONTACT',
              to: 'XCAA',
            },
            // Answers and other senders need nothing.
            { from: ofp.callsign, type: 'cpdlc', text: '/data2/3/2/N/WILCO', to: 'XCAA' },
            { from: 'OTHER1', type: 'cpdlc', text: '/data2/0//Y/REQUEST LOGON', to: 'XCAA' },
          ],
        ],
        // After the handover the old station still listens: a logon there is redirected.
        [crossing + 5, [logon('XCAA', 4)]],
      ]),
    );
    expect(packets(r)).toEqual([
      'XCAA /data2/1/1/NE/LOGON ACCEPTED',
      'XCAA /data2/2//NE/CURRENT ATC UNIT@_@XCAA@_@TAIPEI CTL',
      'XCAA /data2/3/2/NE/MESSAGE NOT SUPPORTED BY THIS ATS UNIT',
      'XCAA /data2/4//NE/HANDOVER @XJJJ',
      'XCAA /data2/5/4/NE/UNABLE@_@LOGON TO @XJJJ@',
    ]);
    expect(atcEvents(r).find((e) => e.type === 'ATC_UNSUPPORTED')).toMatchObject({
      text: 'REQUEST VOICE CONTACT',
    });
    expect(atcEvents(r).find((e) => e.type === 'ATC_LOGON' && !e.accepted)).toMatchObject({
      station: 'XCAA',
      reason: 'wrong_station',
    });
  });

  it('steps aside for a live VATSIM centre: notice + LOGOFF instead of a handover', () => {
    const live: CenterStation = { callsign: 'RJJJ_CTR', frequency: '133.600', firs: ['RJJJ'] };
    const r = fly(
      new Map([
        [10, [logon('XCAA')]],
        [crossing + 5, [logon('XJJJ', 2)]],
      ]),
      {
        centers: [live],
        centersAt: crossing - 60,
      },
    );
    expect(packets(r)).toEqual([
      'XCAA /data2/1/0/NE/LOGON ACCEPTED',
      'XCAA /data2/2//NE/CURRENT ATC UNIT@_@XCAA@_@TAIPEI CTL',
      'XCAA /data2/3//NE/VATSIM ATC ONLINE@_@CONTACT RJJJ_CTR @133.600@',
      'XCAA /data2/4//NE/LOGOFF',
      'XJJJ /data2/1/2/NE/UNABLE@_@VATSIM ATC ONLINE@_@CONTACT RJJJ_CTR @133.600@',
    ]);
    expect(atcEvents(r).filter((e) => e.type === 'ATC_LIVE')).toHaveLength(1);
  });

  it('ignores VATSIM data older than 20 min, and everything with the setting off', () => {
    const live: CenterStation = { callsign: 'RJJJ_CTR', frequency: '133.600', firs: ['RJJJ'] };
    const say = new Map([[10, [logon('XCAA')]]]);
    expect(crossing).toBeGreaterThan(20 * 60);
    const stale = fly(say, { centers: [live], centersAt: 0 });
    expect(packets(stale)).toContain('XCAA /data2/3//NE/HANDOVER @XJJJ');
    const off = fly(say, { centers: [live], centersAt: crossing - 60, standAside: false });
    expect(packets(off)).toContain('XCAA /data2/3//NE/HANDOVER @XJJJ');
  });

  it('steps aside when the centre of the current FIR comes online while connected', () => {
    const core = AcarsCore.create({ ofp, scenarios: [], seed: 'atc', rops: { enabled: true } });
    core.startFlight();
    const s0 = flight.snapshots[0] as (typeof flight.snapshots)[number];
    core.tick({ now: s0.t, telemetry: s0, data: { t: s0.t, firs: [TAIPEI, FUKUOKA] } });
    core.tick({ now: s0.t + 1000, telemetry: null, inbound: [logon('XCAA')] });
    const r = core.tick({
      now: s0.t + 2000,
      telemetry: null,
      data: {
        t: s0.t + 2000,
        centers: [{ callsign: 'RCAA_CTR', frequency: '125.500', firs: ['RCAA'] }],
      },
    });
    expect(r.outbound.map((m) => m.message.text)).toEqual([
      'VATSIM ATC ONLINE@_@CONTACT RCAA_CTR @125.500@',
      'LOGOFF',
    ]);
    // Once is enough; when the controller leaves, logons are accepted again.
    expect(core.tick({ now: s0.t + 3000, telemetry: null }).outbound).toEqual([]);
    core.tick({ now: s0.t + 4000, telemetry: null, data: { t: s0.t + 4000, centers: [] } });
    const again = core.tick({ now: s0.t + 5000, telemetry: null, inbound: [logon('XCAA', 5)] });
    expect(again.outbound[0]?.message.text).toBe('LOGON ACCEPTED');
  });

  it('does nothing without FIR data and before the origin is in a known FIR', () => {
    const r = fly(new Map(), { firs: [FUKUOKA] });
    // The origin is outside every known FIR: no FIR station until the aircraft enters RJJJ
    // (the DCL station of the origin listens on the ground anyway).
    expect(r.listen[0]).toEqual(['XCTP']);
    expect(r.listen[crossing]).toEqual(['XJJJ']);
    expect(r.out).toEqual([]);
  });

  it('messages to the airline station still go to the scenarios', () => {
    const core = AcarsCore.create({ ofp, scenarios: [], seed: 'atc', rops: { enabled: true } });
    core.startFlight();
    const s0 = flight.snapshots[0] as (typeof flight.snapshots)[number];
    const station = `OPS${ofp.flightNumber ?? ofp.callsign}`;
    const r = core.tick({
      now: s0.t,
      telemetry: s0,
      inbound: [{ from: ofp.callsign, type: 'telex', text: 'HELP', to: station }],
    });
    expect(r.events.find((e) => e.type === 'PILOT_MESSAGE')).toMatchObject({ result: 'command' });
  });

  it('continues from a saved state with the same output (replay determinism)', () => {
    const say = new Map([
      [10, [logon('XCAA')]],
      [crossing + 5, [logon('XJJJ', 2)]],
    ]);
    const whole = fly(say);
    const cut = crossing - 3;
    const core = AcarsCore.create({ ofp, scenarios: [], seed: 'atc', rops: { enabled: true } });
    core.startFlight();
    const out: OutboundMessage[] = [];
    let restored: AcarsCore | null = null;
    flight.snapshots.forEach((s, i) => {
      const c = restored ?? core;
      const inbound = say.get(i);
      const r = c.tick({
        now: s.t,
        telemetry: s,
        ...(inbound === undefined ? {} : { inbound }),
        ...(i === 0 ? { data: { t: T0, firs: [TAIPEI, FUKUOKA] } } : {}),
      });
      out.push(...r.outbound);
      if (i === cut) {
        restored = AcarsCore.fromState(JSON.parse(JSON.stringify(core.getState())), {
          ofp,
          scenarios: [],
          seed: 'atc',
          rops: { enabled: true },
        });
      }
    });
    expect(out.map((m) => m.message.text)).toEqual(whole.out.map((m) => m.message.text));
  });
});
