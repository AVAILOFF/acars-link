import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AcarsCore,
  B77X_PROFILE,
  B78X_PROFILE,
  type CompiledScenario,
  type CoreEvent,
  checkText,
  DEFAULT_PROFILE,
  type DisplayProfile,
  type ExtDataUpdate,
  generateSyntheticFlight,
  MISSING,
  type Ofp,
  type OutboundMessage,
  parseSimbriefOfp,
  type SyntheticFlight,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../src/index.js';

/**
 * T29 special events (`external/*.yaml`, docs/07 T29) on synthetic RCTP–RJBB flights moved in
 * time: the data a group's sources would pass (as the app does: at start and every 10 min), the
 * eclipse, air show and history from the core's own tables. One message of the eight "news"
 * scenarios per flight; space weather and volcanic ash separately.
 */

const dir = join(import.meta.dirname, '..', 'external');
const all = loadScenarios(
  readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(dir, file), 'utf8') })),
);
const NEWS = [
  'aurora_on_route',
  'solar_eclipse',
  'airshow_dest',
  'aviation_history',
  'f1_result',
  'nhl_results',
  'holiday_dest',
  'earthquake_dest',
];
const SAFETY = ['space_weather', 'volcanic_ash'];
const special = all.filter((s) => NEWS.includes(s.id) || SAFETY.includes(s.id));
const byId = (id: string) => special.find((s) => s.id === id) as CompiledScenario;

const base = parseSimbriefOfp(
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../core/test/fixtures/ofp/rctp-rjbb-a35k-kgs.json'),
      'utf8',
    ),
  ),
);

/** The OFP with every time moved so that the scheduled departure is at `outMs`. */
function at(ofp: Ofp, outMs: number, dest?: Partial<Ofp['destination']>): Ofp {
  const d = outMs - ofp.times.schedOutMs;
  const times = Object.fromEntries(
    Object.entries(ofp.times).map(([k, v]) => [
      k,
      k.endsWith('Ms') && typeof v === 'number' ? v + d : v,
    ]),
  ) as unknown as Ofp['times'];
  return { ...ofp, times, destination: { ...ofp.destination, ...dest } };
}

interface Case {
  readonly ofp: Ofp;
  readonly flight: SyntheticFlight;
}
const make = (ofp: Ofp): Case => ({ ofp, flight: generateSyntheticFlight({ ofp }) });

/** A night flight: off-blocks 12:30Z (21:30 in Osaka). */
const night = make(at(base, Date.parse('2026-10-08T12:30:00Z')));

const fix = (c: Case, f: number) =>
  c.ofp.navlog[Math.floor(c.ofp.navlog.length * f)] as { lat: number; lon: number };
const snapT = (c: Case, f: number) =>
  (c.flight.snapshots[Math.floor(c.flight.snapshots.length * f)] as { t: number }).t;
const box = (p: { lat: number; lon: number }, d: number) => [
  { lat: p.lat - d, lon: p.lon - d },
  { lat: p.lat - d, lon: p.lon + d },
  { lat: p.lat + d, lon: p.lon + d },
  { lat: p.lat + d, lon: p.lon - d },
  { lat: p.lat - d, lon: p.lon - d },
];

/** What the special-event sources would pass at `t`. */
function liveData(c: Case, t: number): ExtDataUpdate {
  const first = c.flight.snapshots[0]?.t ?? 0;
  const last = c.flight.snapshots.at(-1)?.t ?? 0;
  const mid = fix(c, 0.5);
  const done = snapT(c, 0.4);
  const arrLocal = new Date(c.ofp.times.schedInMs + 9 * 3_600_000).toISOString().slice(0, 10);
  return {
    t,
    spaceWx: {
      issued: t,
      current: { r: 3, s: 2, g: 0 },
      gForecast: [{ date: '2026-10-08', g: 3 }],
    },
    aurora: {
      forecastTime: t + 3_600_000,
      cells: [{ lat: Math.round(mid.lat), lon: Math.round(mid.lon), prob: 45 }],
    },
    ash: [
      {
        id: 'RJJJ 2',
        fir: 'RJJJ',
        volcano: 'SAKURAJIMA',
        baseFt: 0,
        topFt: 12000,
        validFrom: first,
        validTo: last,
        areas: [box({ lat: fix(c, 0.7).lat + 1, lon: fix(c, 0.7).lon }, 0.2)],
      },
    ],
    quakes: [
      {
        id: 'us7000test',
        mag: 5.6,
        place: '40 KM SW OF KOBE, JAPAN',
        time: first - 2 * 3_600_000,
        lat: 34.4,
        lon: 134.8,
        depthKm: 10,
      },
    ],
    holidays: {
      country: 'JP',
      list: [{ date: arrLocal, name: 'SPORTS DAY', localName: 'SUPOTSU NO HI' }],
    },
    f1: {
      season: '2026',
      round: '17',
      name: 'JAPANESE GRAND PRIX',
      start: done - 5_400_000,
      finish: done,
      podium: [
        { pos: 1, code: 'VER', team: 'RED BULL' },
        { pos: 2, code: 'NOR', team: 'MCLAREN' },
        { pos: 3, code: 'LEC', team: 'FERRARI' },
      ],
    },
    nhl: [
      {
        id: 2026020100,
        start: first,
        state: t < done ? 'LIVE' : 'OFF',
        away: 'SJS',
        home: 'STL',
        awayScore: 3,
        homeScore: 2,
        lastPeriod: t < done ? null : 'OT',
      },
    ],
  };
}

interface Run {
  readonly out: OutboundMessage[];
  readonly events: CoreEvent[];
}

function fly(
  c: Case,
  scenarios: readonly CompiledScenario[],
  o: { profile?: DisplayProfile; data?: boolean; seed?: string } = {},
): Run {
  const core = AcarsCore.create({
    ofp: c.ofp,
    scenarios: scenarios.map((s) => ({ ...s, probability: 1 })),
    seed: o.seed ?? 'special',
    profile: o.profile ?? DEFAULT_PROFILE,
  });
  core.startFlight();
  const out: OutboundMessage[] = [];
  const events: CoreEvent[] = [];
  c.flight.snapshots.forEach((s, i) => {
    const data = o.data === true && i % 600 === 0 ? liveData(c, s.t) : undefined;
    const r = core.tick({ now: s.t, telemetry: s, ...(data === undefined ? {} : { data }) });
    out.push(...r.outbound);
    events.push(...r.events);
  });
  return { out, events };
}

const ids = (r: Run) => r.out.map((m) => m.scenarioId);
const flat = (s: string) => s.replace(/\s+/g, ' ');
const textOf = (r: Run, id: string) =>
  flat(r.out.find((m) => m.scenarioId === id)?.message.text ?? '');
const errors = (r: Run) => r.events.filter((e) => e.type === 'SCENARIO_ERROR');
const missing = new RegExp(`(^|[^-])${MISSING}($|[^-])`, 'm');

function checkFormat(r: Run, profile: DisplayProfile): void {
  expect(errors(r)).toEqual([]);
  for (const m of r.out) {
    expect(checkText(m.message.text, profile)).toEqual([]);
    expect(m.message.text).not.toMatch(missing);
    expect(m.message.lines.every((l) => l.length <= profile.lineWidth)).toBe(true);
    expect(m.message.text).toMatch(/OPS\s*$/);
  }
}

describe('special event files', () => {
  it('ten scenarios; the news ones are one group of 1, the safety ones nothing', () => {
    expect(special.map((s) => s.id).sort()).toEqual([...NEWS, ...SAFETY].sort());
    for (const id of NEWS) {
      expect(byId(id).def.group).toBe('special_news');
      expect(byId(id).groupMax).toBe(1);
      expect(byId(id).def.excludes).toBeUndefined();
    }
    for (const id of SAFETY) {
      expect(byId(id).def.excludes).toBeUndefined();
      expect(byId(id).def.group).toBeUndefined();
    }
  });
});

describe('each data scenario alone on the night flight, 3 displays', () => {
  const cases: readonly [string, RegExp][] = [
    [
      'space_weather',
      /R3 STRONG RADIO BLACKOUT .*G3 STRONG GEOMAGNETIC STORM FORECAST .*SOURCE NOAA SWPC/,
    ],
    [
      'volcanic_ash',
      /VOLCANIC ASH SIGMET RJJJ VOLCANO SAKURAJIMA ASH CLOUD SFC\/FL120 \d+ NM AHEAD \/ \d+ NM FROM ROUTE VALID UNTIL \d{4}Z/,
    ],
    ['aurora_on_route', /PROBABILITY 45 PCT NEAR \d\dN \d{3}E IN ABOUT \d+ MIN/],
    [
      'f1_result',
      /F1 JAPANESE GRAND PRIX RESULT 1 VER RED BULL 2 NOR MCLAREN 3 LEC FERRARI FINISHED \d{4}Z SOURCE JOLPICA/,
    ],
    ['nhl_results', /NHL FINAL SCORES SJS 3 AT STL 2 OT SOURCE NHL.COM/],
    [
      'holiday_dest',
      /PUBLIC HOLIDAY AT DESTINATION SPORTS DAY \(SUPOTSU NO HI, JP\) EXPECT HOLIDAY SCHEDULES AT RJBB/,
    ],
    [
      'earthquake_dest',
      /EARTHQUAKE NEAR RJBB M5\.6 AT \d{4}Z 0[78]OCT 40 KM SW OF KOBE, JAPAN \d+ KM FROM AIRPORT DEPTH 10 KM/,
    ],
  ];
  it.each(cases)('%s', (id, text) => {
    for (const profile of [DEFAULT_PROFILE, B77X_PROFILE, B78X_PROFILE]) {
      const r = fly(night, [byId(id)], { profile, data: true });
      checkFormat(r, profile);
      expect(ids(r), `${id} on ${profile.id}`).toEqual([id]);
      expect(textOf(r, id)).toMatch(text);
      // Without data: silent.
      expect(ids(fly(night, [byId(id)], { profile }))).toEqual([]);
    }
  });

  it('space weather: no radiation line on a route below 60°', () => {
    const r = fly(night, [byId('space_weather')], { data: true });
    expect(textOf(r, 'space_weather')).not.toContain('RADIATION');
  });
});

describe('one news message per flight', () => {
  it('the first news to start wins; space weather and ash come as well', () => {
    const r = fly(night, special, { data: true });
    expect(errors(r)).toEqual([]);
    const news = ids(r).filter((id) => NEWS.includes(id));
    expect(news).toHaveLength(1);
    expect(ids(r)).toContain('space_weather');
    expect(ids(r)).toContain('volcanic_ash');
  });

  it('without data only the core tables can speak (eclipse, air show, history)', () => {
    const r = fly(night, special);
    expect(
      ids(r).every((id) => ['solar_eclipse', 'airshow_dest', 'aviation_history'].includes(id)),
    ).toBe(true);
  });
});

describe('core tables', () => {
  it('solar eclipse of 2035-09-02 seen from the route Taipei–Osaka', () => {
    const c = make(at(base, Date.parse('2035-09-02T00:00:00Z')));
    const r = fly(c, [byId('solar_eclipse')]);
    checkFormat(r, DEFAULT_PROFILE);
    expect(ids(r)).toEqual(['solar_eclipse']);
    expect(textOf(r, 'solar_eclipse')).toMatch(
      /SOLAR ECLIPSE ON YOUR ROUTE (PARTIAL|TOTAL) MAGNITUDE [01]\.\d\d AT \d{4}Z NEAR \d\dN \d{3}E \d+ NM AHEAD SUN \d+ DEG HIGH/,
    );
    // The same route a day later: nothing.
    const later = make(at(base, Date.parse('2035-09-03T00:00:00Z')));
    expect(ids(fly(later, [byId('solar_eclipse')]))).toEqual([]);
  });

  it('air show at the destination on the arrival date (Airshow China, Zhuhai)', () => {
    const zhuhai = { icao: 'ZGSD', lat: 22.0064, lon: 113.376, utcOffsetH: 8 };
    const c = make(at(base, Date.parse('2026-12-08T03:00:00Z'), zhuhai));
    const r = fly(c, [byId('airshow_dest')]);
    checkFormat(r, DEFAULT_PROFILE);
    expect(textOf(r, 'airshow_dest')).toContain('AIRSHOW CHINA (ZHUHAI) ZHUHAI JINWAN 07-13DEC');
    const after = make(at(base, Date.parse('2026-12-15T03:00:00Z'), zhuhai));
    expect(ids(fly(after, [byId('airshow_dest')]))).toEqual([]);
  });

  it('on this day: 17 December has two facts, the seed picks one', () => {
    const c = make(at(base, Date.parse('2026-12-17T03:00:00Z')));
    const texts = new Set(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((seed) =>
        textOf(fly(c, [byId('aviation_history')], { seed }), 'aviation_history'),
      ),
    );
    for (const t of texts) {
      expect(t).toMatch(/ON THIS DAY IN (1903 WRIGHT FLYER|1935 FIRST FLIGHT OF THE DOUGLAS DC-3)/);
    }
    expect(texts.size).toBe(2);
    // A day without a fact: nothing.
    const none = make(at(base, Date.parse('2026-12-18T03:00:00Z')));
    expect(ids(fly(none, [byId('aviation_history')]))).toEqual([]);
  });
});
