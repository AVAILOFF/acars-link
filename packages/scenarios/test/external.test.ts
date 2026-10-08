import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AcarsCore,
  B77X_PROFILE,
  B78X_PROFILE,
  type CompiledScenario,
  checkText,
  DEFAULT_PROFILE,
  type DisplayProfile,
  type ExtDataUpdate,
  generateSyntheticFlight,
  MISSING,
  type Ofp,
  type OutboundMessage,
  type PhaseEvent,
  type PilotMessage,
  parseSimbriefOfp,
  pickStand,
  type ScenarioEvent,
  type SyntheticFlight,
  stageIndex,
  withGap,
  withPause,
  withSimRate,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../src/index.js';

/**
 * T13: scenarios on external data (`external/*.yaml`, `commands/cmd_req_wx_live.yaml`) and the
 * base set with live data, as the app feeds it: an update at start and every 10 min (weather,
 * VATSIM, EONET; OSM stands once). Each on 3 synthetic flights × 3 profiles with data; without
 * data none of them sends and the OFP-based messages go as before.
 */

const dir = (name: string) => join(import.meta.dirname, '..', name);
const read = (name: string) =>
  readdirSync(dir(name))
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(dir(name), file), 'utf8') }));
const all = loadScenarios([...read('base'), ...read('commands'), ...read('external')]);
const external = loadScenarios(read('external'));
const byId = (id: string) => all.find((s) => s.id === id) as CompiledScenario;

const OFPS = join(import.meta.dirname, '../../core/test/fixtures/ofp');
const ofpOf = (name: string): Ofp =>
  parseSimbriefOfp(JSON.parse(readFileSync(join(OFPS, `${name}.json`), 'utf8')));
const kg = ofpOf('rctp-rjbb-a35k-kgs');
const lbs = ofpOf('rctp-rjbb-a35k-lbs-synthetic');
const normal = generateSyntheticFlight({ ofp: kg });
const goAround = generateSyntheticFlight({ ofp: kg, goAroundAglFt: 400 });
const lbsFlight = generateSyntheticFlight({ ofp: lbs, seed: 'lbs' });

interface Case {
  readonly name: string;
  readonly ofp: Ofp;
  readonly flight: SyntheticFlight;
}
const FLIGHTS: readonly Case[] = [
  { name: 'normal', ofp: kg, flight: normal },
  {
    name: 'go-around, pause, ×4',
    ofp: kg,
    flight: withSimRate(
      withPause(goAround, { atIndex: stageIndex(goAround, 'GATE', 600), durationSec: 300 }),
      {
        fromIndex: stageIndex(goAround, 'CRUISE', 300),
        toIndex: stageIndex(goAround, 'CRUISE', 1500),
        rate: 4,
      },
    ),
  },
  {
    name: 'lbs OFP, telemetry gap',
    ofp: lbs,
    flight: withGap(lbsFlight, { atIndex: stageIndex(lbsFlight, 'CLIMB', 120), durationSec: 90 }),
  },
];

const STANDS = ['11', '12', '13', '14', '15'];

/** What the app would pass: everything at start, weather/VATSIM/EONET again every 10 min. */
function liveData(ofp: Ofp, t: number, first: boolean, atc = true): ExtDataUpdate {
  const mid = ofp.navlog[Math.floor(ofp.navlog.length / 2)] as { lat: number; lon: number };
  const metar = (icao: string, q: number) =>
    `${icao} 080600Z 03008KT 9999 FEW030 22/15 Q${q} NOSIG`;
  return {
    t,
    wx: {
      RCTP: {
        metar: metar('RCTP', 1012),
        taf: 'TAF RCTP 080500Z 0806/0912 06010KT 9999',
        obsTime: t,
      },
      RJBB: {
        metar: metar('RJBB', 1018),
        taf: 'TAF RJBB 080500Z 0806/0912 03010KT 9999',
        obsTime: t,
      },
      RJGG: { metar: metar('RJGG', 1017), taf: null, obsTime: t },
    },
    atc: {
      RCTP: [],
      RJBB: atc
        ? [
            { callsign: 'RJBB_TWR', facility: 'TWR', frequency: '118.200', atisCode: null },
            { callsign: 'KIX_APP', facility: 'APP', frequency: '120.250', atisCode: null },
            { callsign: 'RJBB_ATIS', facility: 'ATIS', frequency: '128.600', atisCode: 'C' },
          ]
        : [],
    },
    events: [
      {
        id: 'EONET_1',
        title: 'TROPICAL STORM TEST',
        category: 'severeStorms',
        lat: mid.lat + 0.4,
        lon: mid.lon,
        date: t,
      },
    ],
    ...(first
      ? { stands: { icao: 'RJBB', list: STANDS.map((ref) => ({ ref, kind: 'stand' as const })) } }
      : {}),
  };
}

interface Run {
  readonly out: OutboundMessage[];
  readonly events: (PhaseEvent | ScenarioEvent)[];
}

function fly(
  c: Case,
  scenarios: readonly CompiledScenario[],
  o: {
    profile?: DisplayProfile;
    data?: boolean;
    atc?: boolean;
    say?: ReadonlyMap<number, readonly PilotMessage[]>;
  } = {},
): Run {
  const core = AcarsCore.create({
    ofp: c.ofp,
    scenarios,
    seed: 'external',
    profile: o.profile ?? DEFAULT_PROFILE,
    dataWaitMs: 60_000,
  });
  core.startFlight();
  const out: OutboundMessage[] = [];
  const events: (PhaseEvent | ScenarioEvent)[] = [];
  c.flight.snapshots.forEach((s, i) => {
    const data =
      o.data === true && i % 600 === 0 ? liveData(c.ofp, s.t, i === 0, o.atc ?? true) : undefined;
    const inbound = o.say?.get(i);
    const r = core.tick({
      now: s.t,
      telemetry: s,
      ...(data === undefined ? {} : { data }),
      ...(inbound === undefined ? {} : { inbound }),
    });
    out.push(...r.outbound);
    events.push(...r.events);
  });
  return { out, events };
}

const errors = (r: Run) => r.events.filter((e) => e.type === 'SCENARIO_ERROR');
const ids = (r: Run) => r.out.map((m) => m.scenarioId);
const textOf = (r: Run, id: string) => r.out.find((m) => m.scenarioId === id)?.message.text ?? '';
const missing = new RegExp(`(^|[^-])${MISSING}($|[^-])`, 'm');

describe('external scenario files', () => {
  it('are the live-data scenarios, file name = id', () => {
    expect(external.map((s) => s.id)).toEqual([
      'dest_weather_live',
      'natural_event',
      'vatsim_atc',
      'vatsim_atc_none',
    ]);
  });
});

describe.each(FLIGHTS)('each live-data scenario alone on $name', (c) => {
  const cases = [...external, byId('cmd_req_wx_live')].map((s) => [s.id, s] as const);
  it.each(cases)('%s', (id, s) => {
    const cruise = c.flight.snapshots.findIndex((x) => x.altFt > 30_000);
    const say = new Map(
      id === 'cmd_req_wx_live'
        ? [[cruise, [{ from: c.ofp.callsign, type: 'telex', text: 'REQ WX RJGG' }]]]
        : [],
    );
    for (const profile of [DEFAULT_PROFILE, B77X_PROFILE, B78X_PROFILE]) {
      const r = fly(c, [{ ...s, probability: 1 }], {
        profile,
        data: true,
        atc: id !== 'vatsim_atc_none',
        say,
      });
      expect(errors(r)).toEqual([]);
      expect(ids(r), `${id} on ${profile.id}`).toEqual([id]);
      for (const m of r.out) {
        expect(checkText(m.message.text, profile)).toEqual([]);
        expect(m.message.text).not.toMatch(missing);
        expect(m.message.lines.every((l) => l.length <= profile.lineWidth)).toBe(true);
      }
      // Without data: silent.
      // Without data: silent (a REQ WX gets the core's RCVD: its live handler did not match).
      const off = ids(fly(c, [{ ...s, probability: 1 }], { profile, say }));
      expect(off.filter((x) => x !== '#ops')).toEqual([]);
    }
  });
});

describe('the whole set with live data on the normal flight', () => {
  const c = FLIGHTS[0] as Case;
  const set = all.map((s) => ({ ...s, probability: 1 }));
  const gateAsk = c.flight.snapshots.findIndex((x) => x.altFt > 30_000);
  const say = new Map([
    [gateAsk, [{ from: kg.callsign, type: 'telex', text: 'REQ GATE' }]],
    [gateAsk + 60, [{ from: kg.callsign, type: 'telex', text: 'REQ WX EDDF' }]],
  ]);
  const live = fly(c, set, { data: true, say });
  const offline = fly(c, set, { say });

  it('sends the live variants and the external messages, no errors', () => {
    expect(errors(live)).toEqual([]);
    expect(ids(live)).toContain('dest_weather_live');
    expect(ids(live)).not.toContain('dest_weather');
    expect(ids(live)).toContain('vatsim_atc');
    expect(ids(live)).toContain('natural_event');
    expect(textOf(live, 'dest_weather_live')).toContain('Q1018');
    expect(textOf(live, 'takeoff_data')).toContain('RCTP 080600Z');
    expect(textOf(live, 'natural_event')).toContain('TROPICAL STORM TEST');
    expect(textOf(live, 'vatsim_atc')).toContain('RJBB-TWR 118.200');
  });

  it('without data: the OFP variants, no external messages', () => {
    expect(errors(offline)).toEqual([]);
    expect(ids(offline)).toContain('dest_weather');
    for (const id of ['dest_weather_live', 'vatsim_atc', 'vatsim_atc_none', 'natural_event'])
      expect(ids(offline)).not.toContain(id);
  });

  it('every gate message names the same OSM stand', () => {
    const gate = pickStand(
      STANDS.map((ref) => ({ ref, kind: 'stand' })),
      'external',
    );
    expect(textOf(live, 'gate_assignment')).toContain(`EXPECTED GATE ${gate}`);
    expect(textOf(live, 'cmd_req_gate')).toContain(`EXPECTED GATE ${gate}`);
    expect(textOf(live, 'arrival_info')).toContain(`GATE ${gate} CONFIRMED`);
  });

  it('REQ WX for an airport outside the OFP waits for the fetch, then answers "no data"', () => {
    // The test feeds no EDDF weather: after a minute the core answers with what it has.
    const req = live.events.find((e) => e.type === 'DATA_REQUEST');
    expect(req).toMatchObject({ kind: 'wx', icao: 'EDDF' });
    const answer = live.out.find((m) => m.message.text.includes('NO WX AVBL FOR EDDF'));
    expect((answer?.t ?? 0) - (req?.t ?? 0)).toBe(60_000);
  });

  it('snapshot', () => {
    expect(
      live.out
        .filter((m) =>
          ['dest_weather_live', 'vatsim_atc', 'natural_event', 'takeoff_data'].includes(
            m.scenarioId,
          ),
        )
        .map((m) => `${new Date(m.t).toISOString()} ${m.scenarioId}\n${m.message.text}`),
    ).toMatchSnapshot();
  });
});
