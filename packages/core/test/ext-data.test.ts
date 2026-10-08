import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AcarsCore,
  applyExtData,
  checkExtDataUpdate,
  compileScenario,
  compileTemplate,
  createRng,
  EMPTY_EXT,
  ExtDataError,
  type ExtDataUpdate,
  generateSyntheticFlight,
  metarQnh,
  type OutboundMessage,
  type PhaseEvent,
  type PilotMessage,
  parseSimbriefOfp,
  pickStand,
  RoutePolyline,
  type ScenarioDef,
  type ScenarioEvent,
} from '../src/index.js';

/** T13: external data in the core — `wx.*`, `ext.*`, OSM gate, `REQ WX` waiting for data. */

const ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'ofp', 'rctp-rjbb-a35k-kgs.json'), 'utf8'),
  ),
);
const flight = generateSyntheticFlight({ ofp });
const MIN = 60_000;

const def = (d: Partial<ScenarioDef> & Pick<ScenarioDef, 'id' | 'trigger'>): ScenarioDef => ({
  version: 1,
  category: 'ops',
  title: d.id,
  enabled_by_default: true,
  steps: [{ send: { body: d.id.toUpperCase() } }],
  ...d,
});

const RJBB_METAR = 'RJBB 080600Z 03008KT 9999 FEW030 22/15 Q1018 NOSIG';
const wxUpdate = (t: number, obs = t - 10 * MIN): ExtDataUpdate => ({
  t,
  wx: {
    RJBB: {
      metar: RJBB_METAR,
      taf: 'TAF RJBB 080500Z 0806/0912 03010KT 9999 FEW030',
      obsTime: obs,
    },
    RCTP: null,
  },
});

interface Run {
  readonly core: AcarsCore;
  readonly out: OutboundMessage[];
  readonly events: (PhaseEvent | ScenarioEvent)[];
}

/** Flies the synthetic flight; `data`/`say` by snapshot index; optional state round trip. */
function fly(
  scenarios: readonly ScenarioDef[],
  opts: {
    data?: ReadonlyMap<number, ExtDataUpdate>;
    say?: ReadonlyMap<number, readonly PilotMessage[]>;
    dataWaitMs?: number;
    until?: number;
    resumeAt?: number;
  } = {},
): Run {
  const compiled = scenarios.map(compileScenario);
  const options = {
    ofp,
    scenarios: compiled,
    seed: 'ext',
    ...(opts.dataWaitMs === undefined ? {} : { dataWaitMs: opts.dataWaitMs }),
  };
  let core = AcarsCore.create(options);
  core.startFlight();
  const out: OutboundMessage[] = [];
  const events: (PhaseEvent | ScenarioEvent)[] = [];
  const end = opts.until ?? flight.snapshots.length;
  for (let i = 0; i < end; i++) {
    const s = flight.snapshots[i] as (typeof flight.snapshots)[number];
    if (i === opts.resumeAt) {
      core = AcarsCore.fromState(JSON.parse(JSON.stringify(core.getState())), options);
    }
    const data = opts.data?.get(i);
    const inbound = opts.say?.get(i);
    const r = core.tick({
      now: s.t,
      telemetry: s,
      ...(data === undefined ? {} : { data }),
      ...(inbound === undefined ? {} : { inbound }),
    });
    out.push(...r.outbound);
    events.push(...r.events);
  }
  return { core, out, events };
}

const texts = (r: Run, id?: string) =>
  r.out
    .filter((m) => id === undefined || m.scenarioId === id)
    .map((m) => m.message.text.replaceAll('\n', ' '));

function phaseIndex(phase: string): number {
  const core = AcarsCore.create({ ofp, scenarios: [], seed: 'x' });
  core.startFlight();
  const i = flight.snapshots.findIndex(
    (s) => core.tick({ now: s.t, telemetry: s }).phase === phase,
  );
  if (i < 0) throw new Error(`no ${phase}`);
  return i;
}
const CRUISE = phaseIndex('CRUISE');
const tAt = (i: number) => (flight.snapshots[i] as { t: number }).t;
const pilot = (text: string): PilotMessage => ({ from: ofp.callsign, type: 'telex', text });

describe('data update shape', () => {
  it('accepts a full update and rejects bad ones', () => {
    const ok: ExtDataUpdate = {
      t: 1,
      wx: { RJBB: { metar: 'X', taf: null, obsTime: null }, RCTP: null },
      atc: {
        RJBB: [{ callsign: 'RJBB_TWR', facility: 'TWR', frequency: '118.200', atisCode: null }],
      },
      events: [{ id: 'E1', title: 'T', category: 'wildfires', lat: 1, lon: 2, date: 3 }],
      stands: { icao: 'RJBB', list: [{ ref: 'A1', kind: 'gate' }] },
    };
    expect(checkExtDataUpdate(ok)).toBe(ok);
    for (const bad of [
      null,
      {},
      { t: 1, wx: { 'not icao': null } },
      { t: 1, wx: { RJBB: { metar: 1, taf: null, obsTime: null } } },
      { t: 1, atc: { RJBB: [{ callsign: 'X', facility: 'CTR', frequency: '1', atisCode: null }] } },
      { t: 1, events: [{ id: 'E1' }] },
      { t: 1, stands: { icao: 'RJBB', list: [{ ref: 'A 1', kind: 'gate' }] } },
    ]) {
      expect(() => checkExtDataUpdate(bad)).toThrow(ExtDataError);
    }
  });
});

describe('weather variables', () => {
  const metarMsg = def({
    id: 'wx',
    trigger: { on: 'phase_enter', phase: 'CRUISE' },
    steps: [
      {
        send: {
          body: '{wx.dest_metar}\nLIVE {wx.dest_live} OBS {wx.dest_obs|hhmm} QNH {wx.dest_metar|qnh}\n{wx.dest_taf|or:NO TAF}\nORIG LIVE {wx.orig_live}',
        },
      },
    ],
  });

  it('use the live METAR when there is one, the OFP one otherwise', () => {
    const live = fly([metarMsg], { data: new Map([[5, wxUpdate(tAt(5))]]) });
    const [text] = texts(live, 'wx');
    expect(text).toContain(RJBB_METAR);
    expect(text).toContain('LIVE TRUE');
    expect(text).toContain('QNH Q1018');
    expect(text).toContain('TAF RJBB');
    // RCTP answered "no report": the OFP METAR, not live.
    expect(text).toContain('ORIG LIVE FALSE');

    const none = fly([metarMsg]);
    const [plain] = texts(none, 'wx');
    expect(plain).toContain(ofp.destination.metar as string);
    expect(plain).toContain('LIVE FALSE OBS ----');
    expect(plain).toContain('NO TAF');
  });

  it('a METAR older than 3 h is not live', () => {
    const old = fly([metarMsg], { data: new Map([[5, wxUpdate(tAt(5), tAt(5) - 4 * 60 * MIN)]]) });
    expect(texts(old, 'wx')[0]).toContain('LIVE FALSE');
  });

  it('qnh reads Q and A groups before the remarks', () => {
    expect(metarQnh('EDDF 081350Z 32012KT 9999 16/09 Q1013 NOSIG')).toBe('Q1013');
    expect(metarQnh('KJFK 081351Z 27011KT 10SM 18/13 A2986 RMK AO2 SLP111')).toBe('A2986');
    expect(metarQnh('XXXX 081351Z RMK Q1000')).toBeNull();
    const t = compileTemplate('{a.x|qnh}');
    expect(t.render(() => null, createRng(1))).toBe('----');
  });
});

describe('VATSIM variables', () => {
  const atcMsg = def({
    id: 'atc',
    trigger: { on: 'phase_enter', phase: 'CRUISE' },
    steps: [
      {
        send: { body: 'N {ext.dest_atc_count}\n{ext.dest_atc|or:NONE}\nATIS {ext.dest_atis|or:-}' },
      },
    ],
  });
  const atc: ExtDataUpdate = {
    t: 0,
    atc: {
      RJBB: [
        { callsign: 'RJBB_TWR', facility: 'TWR', frequency: '118.200', atisCode: null },
        { callsign: 'KIX_APP', facility: 'APP', frequency: '120.250', atisCode: null },
        { callsign: 'RJBB_ATIS', facility: 'ATIS', frequency: '128.600', atisCode: 'C' },
      ],
      RCTP: [],
    },
  };

  it('list stations ATIS first, tower before approach', () => {
    const r = fly([atcMsg], { data: new Map([[CRUISE - 60, { ...atc, t: tAt(CRUISE - 60) }]]) });
    expect(r.out[0]?.message.lines).toEqual([
      'N 3',
      'RJBB-ATIS 128.600',
      'RJBB-TWR 118.200',
      'KIX-APP 120.250',
      'ATIS C',
    ]);
  });

  it('are null without data or with data older than 20 min', () => {
    expect(texts(fly([atcMsg]), 'atc')).toEqual(['N ---- NONE ATIS -']);
    const old = fly([atcMsg], {
      data: new Map([[CRUISE - 60, { ...atc, t: tAt(CRUISE) - 30 * MIN }]]),
    });
    expect(texts(old, 'atc')).toEqual(['N ---- NONE ATIS -']);
  });
});

describe('natural events along the route', () => {
  const mid = ofp.navlog[Math.floor(ofp.navlog.length / 2)] as { lat: number; lon: number };
  const near = { id: 'E1', title: 'TYPHOON TEST', category: 'severeStorms', date: 0 };
  const events: ExtDataUpdate = {
    t: 0,
    events: [
      { ...near, lat: mid.lat + 0.5, lon: mid.lon },
      // Far from the route: dropped.
      { id: 'E2', title: 'FAR FIRE', category: 'wildfires', lat: 0, lon: 0, date: 0 },
    ],
  };

  it('are placed against the route once and the next one ahead is visible', () => {
    const poly = new RoutePolyline(ofp);
    const st = applyExtData(EMPTY_EXT, events, ofp, poly);
    expect(st.events.map((e) => e.id)).toEqual(['E1']);
    expect(st.events[0]?.offNm).toBeGreaterThan(20);
    expect(st.events[0]?.offNm).toBeLessThan(40);

    const msg = def({
      id: 'event',
      trigger: { on: 'phase', phase: 'CRUISE' },
      conditions: ['ext.event_ahead_nm != null', 'ext.event_ahead_nm <= 150'],
      steps: [
        {
          send: {
            body: '{ext.event_category} {ext.event_title}\n{ext.event_off_nm} NM OFF ROUTE\n{ext.event_ahead_nm} NM AHEAD',
          },
        },
      ],
    });
    const r = fly([msg], { data: new Map([[3, { ...events, t: tAt(3) }]]) });
    const [text] = texts(r, 'event');
    expect(text).toMatch(/^SEVERE STORM TYPHOON TEST \d+ NM OFF ROUTE (\d+) NM AHEAD$/);
    expect(Number(/(\d+) NM AHEAD/.exec(text ?? '')?.[1])).toBeLessThanOrEqual(150);
    // Past the event: nothing ahead any more.
    const after = def({
      id: 'after',
      trigger: { on: 'phase_enter', phase: 'DESCENT' },
      steps: [{ send: { body: 'NEXT {ext.event_id|or:NONE}' } }],
    });
    expect(texts(fly([after], { data: new Map([[3, { ...events, t: tAt(3) }]]) }))).toEqual([
      'NEXT NONE',
    ]);
  });
});

describe('arrival gate from OSM stands', () => {
  const stands = (list: string[], kind: 'gate' | 'stand' = 'stand'): ExtDataUpdate => ({
    t: 0,
    stands: { icao: 'RJBB', list: list.map((ref) => ({ ref, kind })) },
  });
  const gateMsg = def({
    id: 'gate',
    trigger: { on: 'phase_enter', phase: 'CRUISE' },
    steps: [{ send: { body: 'GATE {ops.arr_gate}' } }],
  });
  const later = def({
    id: 'later',
    trigger: { on: 'phase_enter', phase: 'DESCENT' },
    steps: [{ send: { body: 'GATE {ops.arr_gate}' } }],
  });

  it('is drawn from the stands, deterministically, gates preferred', () => {
    const list = ['12', '2', '41', '5'];
    const r = fly([gateMsg], { data: new Map([[2, stands(list)]]) });
    const gate = pickStand(stands(list).stands?.list ?? [], 'ext');
    expect(list).toContain(gate);
    expect(texts(r, 'gate')).toEqual([`GATE ${gate}`]);
    // Order of the OSM answer does not matter.
    expect(pickStand(stands([...list].reverse()).stands?.list ?? [], 'ext')).toBe(gate);
    const mixed = [
      ...['A1', 'A2', 'A3'].map((ref) => ({ ref, kind: 'gate' as const })),
      ...['R1', 'R2'].map((ref) => ({ ref, kind: 'stand' as const })),
    ];
    expect(['A1', 'A2', 'A3']).toContain(pickStand(mixed, 'ext'));
  });

  it('ignores stands of another airport and empty lists', () => {
    const r = fly([gateMsg], {
      data: new Map([
        [2, { t: 0, stands: { icao: 'RCTP', list: [{ ref: 'Z9', kind: 'gate' }] } }],
        [3, stands([])],
      ]),
    });
    expect(texts(r, 'gate')[0]).not.toBe('GATE Z9');
    expect(r.core.ext.stands).toBeNull();
  });

  it('never changes once a message showed it', () => {
    const first = fly([gateMsg, later], { data: new Map([[2, stands(['11', '12', '13'])]]) });
    const [g1, g2] = texts(first);
    expect(g1).toBe(g2);
    const changed = fly([gateMsg, later], {
      data: new Map([
        [2, stands(['11', '12', '13'])],
        [CRUISE + 10, stands(['91', '92', '93'])],
      ]),
    });
    expect(texts(changed)).toEqual([g1, g1]);
    expect(changed.core.ext.gateLocked).toBe(true);
  });
});

describe('REQ WX waits for fetched weather', () => {
  const req = def({
    id: 'req',
    trigger: { on: 'command', command: 'REQ_WX' },
    steps: [{ send: { body: 'WX {cmd.icao} {cmd.wx_live}\n{cmd.metar|or:NO DATA}' } }],
  });
  const ask = CRUISE + 30;

  it('asks the app (DATA_REQUEST) and answers when the data arrives', () => {
    const r = fly([req], {
      dataWaitMs: 60_000,
      say: new Map([[ask, [pilot('REQ WX EDDF')]]]),
      data: new Map([
        [
          ask + 5,
          {
            t: tAt(ask + 5),
            wx: { EDDF: { metar: 'EDDF 081350Z 32012KT Q1013', taf: null, obsTime: tAt(ask) } },
          },
        ],
      ]),
      until: ask + 120,
    });
    const req1 = r.events.find((e) => e.type === 'DATA_REQUEST');
    expect(req1).toEqual({ type: 'DATA_REQUEST', kind: 'wx', icao: 'EDDF', t: tAt(ask) });
    expect(r.out.map((m) => [m.t, m.message.text.replaceAll('\n', ' ')])).toEqual([
      [tAt(ask + 5), 'WX EDDF TRUE EDDF 081350Z 32012KT Q1013'],
    ]);
  });

  it('answers with what it has after the wait, and at once for fresh data', () => {
    const late = fly([req], {
      dataWaitMs: 60_000,
      say: new Map([[ask, [pilot('REQ WX EDDF')]]]),
      until: ask + 120,
    });
    expect(late.out.map((m) => [m.t - tAt(ask), texts(late)[0]])).toEqual([
      [60_000, 'WX EDDF FALSE NO DATA'],
    ]);
    const fresh = fly([req], {
      dataWaitMs: 60_000,
      data: new Map([[ask - 10, wxUpdate(tAt(ask - 10))]]),
      say: new Map([[ask, [pilot('REQ WX')]]]),
      until: ask + 2,
    });
    expect(fresh.events.some((e) => e.type === 'DATA_REQUEST')).toBe(false);
    expect(texts(fresh)).toEqual([`WX RJBB TRUE ${RJBB_METAR}`]);
  });

  it('without a data source (dataWaitMs 0) answers at once from the OFP', () => {
    const r = fly([req], { say: new Map([[ask, [pilot('REQ WX RJBB')]]]), until: ask + 2 });
    expect(texts(r)).toEqual([`WX RJBB FALSE ${ofp.destination.metar}`]);
  });

  it('survives a state round trip while waiting', () => {
    const r = fly([req], {
      dataWaitMs: 60_000,
      say: new Map([[ask, [pilot('REQ WX EDDF')]]]),
      data: new Map([[ask + 5, { t: tAt(ask + 5), wx: { EDDF: null } }]]),
      resumeAt: ask + 2,
      until: ask + 120,
    });
    expect(texts(r)).toEqual(['WX EDDF FALSE NO DATA']);
    expect(r.out[0]?.t).toBe(tAt(ask + 5));
  });
});

describe('determinism', () => {
  it('same inputs, same messages; state round trip mid-flight changes nothing', () => {
    const all = [
      def({
        id: 'all',
        trigger: { on: 'phase_enter', phase: 'DESCENT' },
        steps: [
          {
            send: {
              body: '{wx.dest_metar} {ext.dest_atc_count} {ops.arr_gate} {ext.event_id|or:NONE}',
            },
          },
        ],
      }),
    ];
    const data = new Map<number, ExtDataUpdate>([
      [2, { ...wxUpdate(tAt(2)), stands: { icao: 'RJBB', list: [{ ref: '7', kind: 'stand' }] } }],
      [CRUISE + 5, { t: tAt(CRUISE + 5), atc: { RJBB: [], RCTP: [] } }],
    ]);
    const a = fly(all, { data });
    const b = fly(all, { data, resumeAt: CRUISE + 50 });
    expect(texts(a)).toEqual(texts(b));
    // ATC data from the climb is stale by the descent (20 min): ----.
    expect(texts(a)[0]).toMatch(/ ---- 7 NONE$/);
  });
});
