// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AcarsCore,
  assignable,
  type CoreEvent,
  cpdlcPacket,
  DCL_DELAY_MS,
  DCL_ID,
  type DisplayProfile,
  type ExtDataUpdate,
  generateSyntheticFlight,
  type Ofp,
  type OutboundMessage,
  type PilotMessage,
  parseDclRequest,
  parseSimbriefOfp,
  type SquawkTables,
  squawkPlan,
} from '../src/index.js';

/**
 * T24: departure clearance by data link. Layouts are checked against real clearances decoded
 * from ACARS (plane-watch/acars-parser samples, airframes.io A3) and the AIP samples of Singapore
 * (eSUP 2018/013) and Malaysia (SUP 02/25).
 */

const base = parseSimbriefOfp(
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'ofp', 'rctp-rjbb-a35k-kgs.json'), 'utf8'),
  ),
);
const flight = generateSyntheticFlight({ ofp: base });
const T0 = flight.snapshots[0]?.t as number;
const takeoff = flight.snapshots.findIndex((s) => !s.onGround);

/** A wide display profile: telexes are not wrapped, so lines compare with the samples. */
const WIDE: DisplayProfile = {
  id: 'wide',
  matchIcao: [],
  lineWidth: 80,
  uppercase: true,
  allowedChars: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:;/-+()'?!=%#*&@",
};

const TW_JP: ExtDataUpdate = {
  t: T0,
  airports: {
    RCTP: { fir: 'RCAA', country: 'Taiwan' },
    RJBB: { fir: 'RJTG', country: 'Japan' },
  },
};

const request = (text: string, ofp: Ofp = base, to = 'XCTP'): PilotMessage => ({
  from: ofp.callsign,
  type: 'telex',
  text,
  to,
});
const fbwRequest = (ofp: Ofp = base, atis = 'A') =>
  request(
    `REQUEST PREDEP CLEARANCE \n${ofp.callsign} ${ofp.aircraft.icao} TO ${ofp.destination.icao} \nAT ${ofp.origin.icao} STAND 5 \nATIS ${atis}`,
    ofp,
    `X${ofp.origin.icao.slice(1)}`,
  );

interface Run {
  readonly core: AcarsCore;
  readonly out: OutboundMessage[];
  readonly events: CoreEvent[];
  readonly listen: (readonly string[])[];
}

function fly(
  say: ReadonlyMap<number, readonly PilotMessage[]>,
  o: {
    ofp?: Ofp;
    data?: ExtDataUpdate;
    seed?: string;
    standAside?: boolean;
    profile?: DisplayProfile;
    squawkTables?: SquawkTables;
  } = {},
): Run {
  const ofp = o.ofp ?? base;
  const core = AcarsCore.create({
    ofp,
    scenarios: [],
    seed: o.seed ?? 'dcl',
    profile: o.profile ?? WIDE,
    xatc: {
      enabled: true,
      ...(o.standAside === undefined ? {} : { standAside: o.standAside }),
      ...(o.squawkTables === undefined ? {} : { squawkTables: o.squawkTables }),
    },
  });
  core.startFlight();
  const out: OutboundMessage[] = [];
  const events: CoreEvent[] = [];
  const listen: (readonly string[])[] = [];
  flight.snapshots.forEach((s, i) => {
    const inbound = say.get(i);
    const r = core.tick({
      now: s.t,
      telemetry: s,
      ...(inbound === undefined ? {} : { inbound }),
      ...(i === 0 && o.data !== undefined ? { data: { ...o.data, t: s.t } } : {}),
    });
    out.push(...r.outbound);
    events.push(...r.events);
    listen.push(r.listen);
  });
  return { core, out, events, listen };
}

const dclOut = (r: Run) => r.out.filter((m) => m.scenarioId === DCL_ID);
const packet = (m: OutboundMessage) =>
  m.cpdlc === undefined ? m.message.text : cpdlcPacket(m.cpdlc, m.message);
/** A real clearance as a pattern: digits → `\d`, given words kept. */
const skeleton = (s: string) => s.replaceAll('@', '').replace(/\s+/g, ' ').trim();

describe('the request telex', () => {
  it('reads the FlyByWire / Hoppie format, letters or phonetic words for the ATIS', () => {
    expect(
      parseDclRequest('REQUEST PREDEP CLEARANCE \nABC123 A320 TO ESSA \nAT EFHK STAND 22 \nATIS A'),
    ).toEqual({ callsign: 'ABC123', destination: 'ESSA', origin: 'EFHK', atis: 'A' });
    // TopSky manual example: "ATIS PAPA".
    expect(
      parseDclRequest('REQUEST PREDEP CLEARANCE ABC123 A320 TO ESSA AT EFHK STAND 22 ATIS PAPA')
        ?.atis,
    ).toBe('P');
    expect(
      parseDclRequest('request predep clearance abc123 a320 to essa at efhk')?.atis,
    ).toBeNull();
    expect(parseDclRequest('REQ GATE')).toBeNull();
  });
});

describe('ARINC 623 DCL (Europe, Asia)', () => {
  const at = 30;

  it('FSM at once, CLD after 60–180 s, WILCO → CDA RECEIVED; the station closes', () => {
    const first = fly(new Map([[at, [fbwRequest()]]]), { data: TW_JP });
    const cld = dclOut(first)[1] as OutboundMessage;
    const wilco: PilotMessage = {
      from: base.callsign,
      type: 'cpdlc',
      text: `/data2/7/${cld.cpdlc?.min}/N/WILCO`,
      to: 'XCTP',
    };
    const cldAt = flight.snapshots.findIndex((s) => s.t === cld.t);
    const r = fly(
      new Map([
        [at, [fbwRequest()]],
        [cldAt + 5, [wilco]],
      ]),
      { data: TW_JP },
    );
    const msgs = dclOut(r);
    expect(msgs.map((m) => [m.kind, m.cpdlc?.ra])).toEqual([
      ['cpdlc', 'NE'],
      ['cpdlc', 'WU'],
      ['cpdlc', 'NE'],
    ]);
    const [fsm, clearance, confirmed] = msgs.map(packet);
    expect(fsm).toMatch(
      /^\/data2\/1\/\/NE\/FSM \d{4} \d{6} RCTP @SJX822@ RCD RECEIVED @REQUEST BEING PROCESSED @STANDBY$/,
    );
    expect(clearance).toMatch(
      /^\/data2\/2\/\/WU\/CLD \d{4} \d{6} RCTP PDC \d{3} @SJX822@ CLRD TO @RJBB@ OFF @05R@ VIA @MOLK1A@ SQUAWK @[0-7]{4}@ ATIS @A@$/,
    );
    expect(confirmed).toMatch(
      /^\/data2\/3\/\/NE\/FSM \d{4} \d{6} RCTP @SJX822@ CDA RECEIVED @CLEARANCE CONFIRMED$/,
    );
    const t0 = flight.snapshots[at]?.t as number;
    const [min, max] = DCL_DELAY_MS;
    expect(cld.t - t0).toBeGreaterThanOrEqual(min);
    expect(cld.t - t0).toBeLessThanOrEqual(max + 1000);
    // Squawk: Taipei FIR international blocks (ICAO APAC table).
    const squawk = /SQUAWK @(\d{4})@/.exec(clearance as string)?.[1] as string;
    const plan = squawkPlan({
      origin: 'RCTP',
      destination: 'RJBB',
      originFir: 'RCAA',
      destinationFir: 'RJTG',
      routeFirs: [],
      originCountry: 'Taiwan',
      destinationCountry: 'Japan',
    });
    expect(plan.rule).toBe('TAIBEI international');
    expect(plan.codes).toContain(squawk);
    expect(r.events.filter((e) => e.type.startsWith('ATC_DCL')).map((e) => e.type)).toEqual([
      'ATC_DCL',
      'ATC_DCL_CLEARANCE',
      'ATC_DCL',
    ]);
    // Listened to on the ground until the exchange is over.
    expect(r.listen[at]).toContain('XCTP');
    expect(r.listen[cldAt + 5]).not.toContain('XCTP');
  });

  it('public tables (T72): the APAC table is not used, the code is random', () => {
    const r = fly(new Map([[30, [fbwRequest()]]]), { data: TW_JP, squawkTables: 'public' });
    const clearance = r.events.find((e) => e.type === 'ATC_DCL_CLEARANCE');
    expect(clearance).toMatchObject({ squawkSource: 'random' });
    const code = /SQUAWK @(\d{4})@/.exec(packet(dclOut(r)[1] as OutboundMessage))?.[1] as string;
    expect(assignable(code)).toBe(true);
  });

  it('has the layout of real DCLs (WSSS, VHHH, EFHK, EDDF) and of the AIP samples', () => {
    const data: ExtDataUpdate = {
      ...TW_JP,
      atc: {
        RCTP: [{ callsign: 'RCTP_DEL', facility: 'DEL', frequency: '121.650', atisCode: null }],
      },
    };
    const r = fly(new Map([[at, [fbwRequest(base, 'K')]]]), { data, standAside: false });
    const ours = skeleton((dclOut(r)[1] as OutboundMessage).message.lines.join(' '));
    // Real: "CLD 0909 230201 WSSS PDC 001 / SIA964 CLRD TO WIII OFF 02R VIA CHANGI1C /
    // SQUAWK 2214 NEXT FREQ 121.650 ATIS K" (2023-02-01).
    const shape = (s: string) =>
      s
        .replace(/^CLD \d{4} \d{6} [A-Z]{4} PDC \d{3} /, 'CLD T D APT PDC N ')
        .replace(/ \S+ CLRD TO [A-Z]{4} OFF \S+ VIA \S+ /, ' CS CLRD TO DEST OFF RWY VIA SID ')
        .replace(/SQUAWK [0-7]{4}/, 'SQUAWK S')
        .replace(/NEXT FREQ \d{3}\.\d{3}/, 'NEXT FREQ F')
        .replace(/ATIS [A-Z]$/, 'ATIS L');
    expect(shape(ours)).toBe(
      shape(
        'CLD 0909 230201 WSSS PDC 001 SIA964 CLRD TO WIII OFF 02R VIA CHANGI1C SQUAWK 2214 NEXT FREQ 121.650 ATIS K',
      ),
    );
    expect(ours).toMatch(/NEXT FREQ 121\.650 ATIS K$/);
    // The same skeleton as EFHK (2025-12-29) and EDDF (2023-02-01) minus their local extras.
    for (const real of [
      'CLD 1832 251229 EFHK PDC 728 FIN5LA CLRD TO ESSA OFF 04R VIA ADIVO5C SQUAWK 0437 NEXT FREQ 121.800',
      'CLD 0839 230201 EDDF PDC 881 DLA15 CLRD TO KATL OFF 25C VIA OBOKA2G SQUAWK 0122 NEXT FREQ 121.905 ATIS R',
      // AIP Malaysia SUP 02/25 without its "IL 5000 FT" (no initial level in the OFP).
      'CLD 1035 230101 WMKK PDC 150 ABC0123 CLRD TO WSSS OFF 32R VIA RUSBU1D SQUAWK 7031 NEXT FREQ 121.900 ATIS W',
    ]) {
      expect(shape(ours).startsWith(shape(real).replace(/ ATIS L$/, ''))).toBe(true);
    }
  });

  it('NEXT FREQ from OurAirports when VATSIM has no delivery/ground; none without data', () => {
    const data: ExtDataUpdate = {
      ...TW_JP,
      freqs: {
        icao: 'RCTP',
        list: [
          { type: 'TWR', mhz: '118.7' },
          { type: 'GND', mhz: '121.8' },
        ],
      },
    };
    const r = fly(new Map([[at, [fbwRequest()]]]), { data });
    expect((dclOut(r)[1] as OutboundMessage).message.text).toContain('NEXT FREQ @121.800@');
  });

  it('rejects a wrong request, a live VATSIM controller (stand aside) and an OFP without SID', () => {
    const wrong = fly(
      new Map([[at, [request('REQUEST PREDEP CLEARANCE XYZ1 A320 TO RJBB AT RCTP ATIS A')]]]),
      {
        data: TW_JP,
      },
    );
    const live: ExtDataUpdate = {
      ...TW_JP,
      atc: {
        RCTP: [{ callsign: 'RCTP_TWR', facility: 'TWR', frequency: '118.700', atisCode: null }],
      },
    };
    const busy = fly(new Map([[at, [fbwRequest()]]]), { data: live });
    const noSid = fly(new Map([[at, [fbwRequest({ ...base, sid: null })]]]), {
      ofp: { ...base, sid: null },
      data: TW_JP,
    });
    for (const [r, reason] of [
      [wrong, 'bad_request'],
      [busy, 'live_atc'],
      [noSid, 'no_sid'],
    ] as const) {
      const msgs = dclOut(r).map(packet);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatch(
        /\/NE\/FSM \d{4} \d{6} RCTP @SJX822@ RCD REJECTED @REVERT TO VOICE PROCEDURES$/,
      );
      expect(r.events.find((e) => e.type === 'ATC_DCL_REJECTED')).toMatchObject({ reason });
    }
    expect(busy.events.find((e) => e.type === 'ATC_DCL_REJECTED')).toMatchObject({
      detail: 'RCTP_TWR 118.700',
    });
  });

  it('is not listened to after take-off; the same seed gives the same clearance', () => {
    const r = fly(new Map(), { data: TW_JP });
    expect(r.listen[takeoff + 30]).not.toContain('XCTP');
    const a = fly(new Map([[at, [fbwRequest()]]]), { data: TW_JP, seed: 's1' });
    const b = fly(new Map([[at, [fbwRequest()]]]), { data: TW_JP, seed: 's1' });
    expect(dclOut(a).map(packet)).toEqual(dclOut(b).map(packet));
    expect(dclOut(a).map((m) => m.t)).toEqual(dclOut(b).map((m) => m.t));
  });
});

describe('US PDC (airline host, telex)', () => {
  // The real Delta PDC of 2025-12-29: DAL2699 KMSP → KRDU.
  const msp: Ofp = {
    ...base,
    callsign: 'DAL2699',
    airlineIcao: 'DAL',
    flightNumber: '2699',
    initialAltitudeFt: 35000,
    route: 'ZMBRO7 ODI JVL CGT BONNT DQN HNN FRIKY ALDAN4',
    sid: 'ZMBRO7',
    origin: { ...base.origin, icao: 'KMSP', iata: 'MSP', planRwy: '30L' },
    destination: { ...base.destination, icao: 'KRDU', iata: 'RDU' },
    aircraft: { ...base.aircraft, icao: 'A320' },
    times: { ...base.times, schedOutMs: Date.UTC(2025, 11, 29, 18, 57) },
  };
  const data: ExtDataUpdate = {
    t: T0,
    airports: { KMSP: { fir: 'KZMP', country: 'USA' }, KRDU: { fir: 'KZDC', country: 'USA' } },
    freqs: { icao: 'KMSP', list: [{ type: 'APP', mhz: '124.7' }] },
  };

  it('one telex after 60–180 s, laid out like the real PDC; ZMP external code', () => {
    const r = fly(new Map([[30, [fbwRequest(msp)]]]), { ofp: msp, data });
    const msgs = dclOut(r);
    expect(msgs).toHaveLength(1);
    const pdc = msgs[0] as OutboundMessage;
    expect(pdc.kind).toBe('telex');
    expect(pdc.from).toBe('XMSP');
    const squawk = /TRANSPONDER (\d{4})/.exec(pdc.message.text)?.[1] as string;
    expect(pdc.message.lines).toEqual([
      'PDC 2699 MSP RDU',
      '**** PREDEPARTURE  CLEARANCE ****',
      `DAL2699 DEPARTING KMSP  TRANSPONDER ${squawk}`,
      'SKED DEP TIME 1857   EQUIP  A320',
      'FILED FLT LEVEL 350',
      '-CLEARED AS FILED-',
      'KMSP ZMBRO7 ODI JVL CGT BONNT DQN HNN FRIKY ALDAN4 KRDU',
      'CLEARED ZMBRO7 DEPARTURE ODI TRSN',
      'CLB VIA SID',
      'EXP 350 10 MIN AFT DP,DPFRQ 124.7',
      'XPCT RWY 30L',
    ]);
    // The real one: TRANSPONDER 3631 — the same ZMP external primary blocks.
    const plan = squawkPlan({
      origin: 'KMSP',
      destination: 'KRDU',
      originFir: 'KZMP',
      destinationFir: 'KZDC',
      routeFirs: [],
      originCountry: 'USA',
      destinationCountry: 'USA',
    });
    expect(plan.codes).toContain('3631');
    expect(plan.codes).toContain(squawk);
    expect(r.events.find((e) => e.type === 'ATC_DCL_CLEARANCE')).toMatchObject({
      format: 'us_pdc',
      squawkSource: 'faa-nbcap',
    });
    // No pilot answer for a PDC: the station closes.
    expect(r.listen.at(takeoff - 5)).not.toContain('XMSP');
  });

  it('without a SID: "UNABLE REVERT TO VOICE"', () => {
    const ofp = { ...msp, sid: null };
    const r = fly(new Map([[30, [fbwRequest(ofp)]]]), { ofp, data });
    expect(dclOut(r).map((m) => m.message.text)).toEqual(['UNABLE REVERT TO VOICE']);
  });
});
