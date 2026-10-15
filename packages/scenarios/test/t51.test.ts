import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AcarsCore,
  type AirportPlace,
  type CompiledScenario,
  type CoreEvent,
  type FirArea,
  generateSyntheticFlight,
  type Ofp,
  type OutboundMessage,
  type PilotMessage,
  parseSimbriefOfp,
  stageIndex,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../src/index.js';
import { withHoldMin } from './hold.js';

/**
 * T51: scenarios that start at a random moment of the cruise, and `DIVERT <ICAO>` in a reply — the
 * airport named, when the core knows it (the OFP's, or looked up and passed in as `places`).
 */

const dir = (name: string) => join(import.meta.dirname, '..', name);
const read = (name: string) =>
  readdirSync(dir(name))
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(dir(name), file), 'utf8') }));
const everything = loadScenarios([...read('base'), ...read('irregular'), ...read('commands')]);
const scenario = (id: string): CompiledScenario => {
  const s = everything.find((x) => x.id === id);
  if (s === undefined) throw new Error(`no scenario ${id}`);
  return { ...s, probability: 1 };
};

const ofp: Ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../core/test/fixtures/ofp/rctp-rjbb-a35k-kgs.json'),
      'utf8',
    ),
  ),
);
const flight = generateSyntheticFlight({ ofp });
const WORLD: FirArea = {
  id: 'RCAA',
  name: 'Taipei',
  oceanic: false,
  polygons: [
    [
      [
        [100, 0],
        [160, 0],
        [160, 60],
        [100, 60],
        [100, 0],
      ],
    ],
  ],
};
const telex = (text: string): PilotMessage => ({ from: ofp.callsign, type: 'telex', text });
/** An airport the OFP does not know, east of the route. */
const EGLL: AirportPlace = { lat: 51.4706, lon: -0.461941 };

interface Run {
  readonly out: OutboundMessage[];
  readonly events: CoreEvent[];
  readonly core: AcarsCore;
}

/** Flies; the pilot answers the first question of `id` with `answer` on the next tick. */
function fly(
  scenarios: readonly CompiledScenario[],
  id: string,
  answer: string | null,
  o: {
    places?: Readonly<Record<string, AirportPlace | null>>;
    /** Data that arrives later (tick index → update). */
    later?: Readonly<Record<number, Readonly<Record<string, AirportPlace | null>>>>;
    dataWaitMs?: number;
    rops?: boolean;
    seed?: string;
  } = {},
): Run {
  const core = AcarsCore.create({
    ofp,
    scenarios,
    seed: o.seed ?? 't51',
    ...(o.dataWaitMs === undefined ? {} : { dataWaitMs: o.dataWaitMs }),
    ...(o.rops === true ? { rops: { enabled: true, randomDirects: false } } : {}),
  });
  core.startFlight();
  const out: OutboundMessage[] = [];
  const events: CoreEvent[] = [];
  let pending: PilotMessage[] = [];
  let asked = false;
  let after = 0;
  flight.snapshots.forEach((s, i) => {
    const places = i === 0 ? o.places : asked ? o.later?.[i - after] : undefined;
    const inbound = [...pending, ...(i === 5 && o.rops === true ? [logon] : [])];
    pending = [];
    const r = core.tick({
      now: s.t,
      telemetry: s,
      ...(inbound.length > 0 ? { inbound } : {}),
      ...(i === 0 || places !== undefined
        ? {
            data: {
              t: s.t,
              ...(i === 0 && o.rops === true ? { firs: [WORLD] } : {}),
              ...(places === undefined ? {} : { places }),
            },
          }
        : {}),
    });
    out.push(...r.outbound);
    events.push(...r.events);
    if (!asked && answer !== null && r.events.some((e) => e.type === 'REPLY_EXPECTED')) {
      asked = true;
      after = i + 1;
      pending.push(telex(answer));
    }
  });
  return { out, events, core };
}
const logon: PilotMessage = {
  from: ofp.callsign,
  type: 'cpdlc',
  text: '/data2/0//Y/REQUEST LOGON',
  to: 'XCAA',
};
const texts = (r: Run, id: string) =>
  r.out.filter((m) => m.scenarioId === id).map((m) => m.message.text.replaceAll('\n', ' '));
const divert = (r: Run) => r.core.getState().engine.divert;

describe('DIVERT <ICAO> in a reply (T51)', () => {
  const med = [scenario('medical_onboard')];

  it('an airport the app looked up: that airport, the distance, the rest for CREW INFO', () => {
    const r = fly(med, 'medical_onboard', 'DIVERT EGLL PAX STABLE', { places: { EGLL } });
    expect(divert(r)).toBe('EGLL');
    const t = texts(r, 'medical_onboard')[2] as string;
    expect(t).toContain('ROGER DIVERT EGLL');
    expect(t).toMatch(/\d+ NM FROM PRESENT POS/);
    expect(t).toContain('CREW INFO: PAX STABLE');
    expect(t).not.toContain('UNKNOWN');
  });

  it('an airport of the OFP needs no lookup', () => {
    const r = fly(med, 'medical_onboard', 'DIVERT RJGG');
    expect(divert(r)).toBe('RJGG');
    expect(texts(r, 'medical_onboard')[2]).toContain('CREW INFO: NO ADDL INFO');
  });

  it('a word that is not an airport stays text: the nearest airport, the word in CREW INFO', () => {
    const r = fly(med, 'medical_onboard', 'DIVERT SICK', { places: { SICK: null } });
    expect(['RCTP', 'RJGG']).toContain(divert(r));
    const t = texts(r, 'medical_onboard')[2] as string;
    expect(t).toContain('CREW INFO: SICK');
    expect(t).not.toContain('UNKNOWN');
  });

  it('ZZZZ, the placeholder of an unlisted aerodrome: the default one and a line saying so', () => {
    const r = fly(med, 'medical_onboard', 'DIVERT ZZZZ PAX', { places: { ZZZZ: null } });
    const d = divert(r) as string;
    expect(['RCTP', 'RJGG']).toContain(d);
    const t = texts(r, 'medical_onboard')[2] as string;
    expect(t).toContain(`ZZZZ UNKNOWN, DIVERT ${d}`);
    expect(t).toContain('CREW INFO: PAX');
  });

  it('the destination is no diversion: the default one, the code stays in the text', () => {
    const r = fly(med, 'medical_onboard', 'DIVERT RJBB');
    expect(divert(r)).not.toBe('RJBB');
    expect(texts(r, 'medical_onboard')[2]).toContain('CREW INFO: RJBB');
  });

  it('without an answer or with a plain DIVERT nothing changes', () => {
    const plain = fly(med, 'medical_onboard', 'DIVERT');
    expect(['RCTP', 'RJGG']).toContain(divert(plain));
    expect(texts(plain, 'medical_onboard')[2]).toMatch(/\d+ NM FROM PRESENT POS/);
  });

  it('the other branches: unruly passenger, fire, MAYDAY-type chains, the closures', () => {
    for (const id of ['unruly_passenger', 'ped_fire_cabin']) {
      const r = fly([scenario(id)], id, 'DIVERT EGLL', { places: { EGLL } });
      expect(divert(r), id).toBe('EGLL');
    }
    for (const id of ['drone_activity', 'dest_fire', 'runway_closure_dest']) {
      const r = fly([scenario(id)], id, 'DIVERT EGLL X', { places: { EGLL } });
      expect(divert(r), id).toBe('EGLL');
      expect(texts(r, id).at(-1), id).toContain('DIVERT EGLL NOTED');
    }
  });

  it('the pilot MEDICAL command chain too', () => {
    const core = AcarsCore.create({
      ofp,
      scenarios: [scenario('cmd_medical')],
      seed: 't51',
    });
    core.startFlight();
    let phase = 0;
    const out: OutboundMessage[] = [];
    flight.snapshots.forEach((s, i) => {
      const inbound: PilotMessage[] = [];
      if (i === 0) void 0;
      if (i === stageIndex(flight, 'CRUISE', 300)) inbound.push(telex('MEDICAL PAX UNWELL'));
      if (phase === 1) {
        inbound.push(telex('DIVERT RJGG'));
        phase = 2;
      }
      const r = core.tick({
        now: s.t,
        telemetry: s,
        ...(inbound.length > 0 ? { inbound } : {}),
      });
      out.push(...r.outbound);
      if (phase === 0 && r.events.some((e) => e.type === 'REPLY_EXPECTED')) phase = 1;
    });
    expect(core.getState().engine.divert).toBe('RJGG');
    expect(out.map((m) => m.message.text).join(' ')).toContain('ROGER DIVERT RJGG');
  });
});

describe('looking the airport up', () => {
  const med = [scenario('medical_onboard')];

  it('the core asks, the answer decides', () => {
    const r = fly(med, 'medical_onboard', 'DIVERT EGLL PAX', {
      dataWaitMs: 60_000,
      // The place comes five ticks after the question.
      later: { 5: { EGLL } },
    });
    const req = r.events.filter((e) => e.type === 'DATA_REQUEST');
    expect(req).toEqual([expect.objectContaining({ kind: 'place', icao: 'EGLL' })]);
    expect(divert(r)).toBe('EGLL');
  });

  it('no answer in time: the default airport, the word is text', () => {
    const r = fly(med, 'medical_onboard', 'DIVERT EGLL PAX', { dataWaitMs: 5_000 });
    expect(['RCTP', 'RJGG']).toContain(divert(r));
    expect(texts(r, 'medical_onboard')[2]).toContain('CREW INFO: EGLL PAX');
  });

  it('an airport already known is not asked for', () => {
    const r = fly(med, 'medical_onboard', 'DIVERT RJGG', { dataWaitMs: 60_000 });
    expect(r.events.some((e) => e.type === 'DATA_REQUEST')).toBe(false);
    expect(divert(r)).toBe('RJGG');
  });

  it('other answers are not asked for', () => {
    const r = fly(med, 'medical_onboard', 'CONTINUE ZZZZ', { dataWaitMs: 60_000 });
    expect(r.events.some((e) => e.type === 'DATA_REQUEST')).toBe(false);
  });
});

describe('ROPS follows the named airport', () => {
  it('a direct to an airport the app looked up', () => {
    const near = flight.snapshots[stageIndex(flight, 'CRUISE', 90)] as { lat: number; lon: number };
    const r = fly([scenario('medical_onboard')], 'medical_onboard', 'DIVERT ZZAA', {
      rops: true,
      // A place 8 NM from where the question comes: the descent is computed for it.
      places: { ZZAA: { lat: near.lat + 8 / 60, lon: near.lon } },
    });
    const cp = r.out.filter((m) => m.kind === 'cpdlc').map((m) => m.message.text);
    expect(divert(r)).toBe('ZZAA');
    expect(cp.some((x) => x.includes('PROCEED DIRECT TO @ZZAA@'))).toBe(true);
  });
});

describe('the cruise scenarios start at a random moment (T51)', () => {
  it('four of them have the window, ped_fire_cabin ends it 20 min before the top of descent', () => {
    for (const id of ['medical_onboard', 'unruly_passenger', 'tech_defect_mel', 'ped_fire_cabin']) {
      const tr = scenario(id).def.trigger;
      expect(tr, id).toMatchObject({ on: 'phase', phase: 'CRUISE' });
      expect((tr as { window?: unknown }).window, id).toEqual({
        after_min: 10,
        before_tod_min: id === 'ped_fire_cabin' ? 20 : 30,
      });
    }
  });

  it('they start from 10 min in to 30 min before the top of descent, not at the top of climb', () => {
    const probe = (id: string, seed: string) => {
      const core = AcarsCore.create({ ofp, scenarios: [scenario(id)], seed });
      core.startFlight();
      let enter: number | null = null;
      for (const s of flight.snapshots) {
        const r = core.tick({ now: s.t, telemetry: s });
        if (
          enter === null &&
          r.events.some((e) => e.type === 'PHASE_CHANGE' && e.to === 'CRUISE')
        ) {
          enter = s.t;
        }
        if (r.outbound.length > 0 && enter !== null) return (s.t - enter) / 60_000;
      }
      return Number.NaN;
    };
    const mins = Array.from({ length: 8 }, (_, i) => probe('unruly_passenger', `w${i}`));
    for (const m of mins) {
      expect(m).toBeGreaterThanOrEqual(10);
      expect(m).toBeLessThan(110);
    }
    expect(new Set(mins.map(Math.round)).size).toBeGreaterThan(3);
  });
});

describe('a holding with a named airport', () => {
  it('the loop of drone_activity takes the named airport too', () => {
    const drone = withHoldMin(scenario('drone_activity'), 120);
    const r = fly([drone], 'drone_activity', 'DIVERT EGLL', { places: { EGLL } });
    expect(divert(r)).toBe('EGLL');
  });
});
