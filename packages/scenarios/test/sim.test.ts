// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AcarsCore,
  generateSyntheticFlight,
  type Ofp,
  parseSimbriefOfp,
  type SimCommand,
  type VdgsCommand,
  type VdgsMessage,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../src/index.js';
import { standsFor } from './stands.js';

/** T22: sim-effect scenarios (`sim/`): VDGS text for GSX. */

const DIR = join(import.meta.dirname, '..', 'sim');
const OFPS = join(import.meta.dirname, '../../core/test/fixtures/ofp');
const sim = loadScenarios(
  readdirSync(DIR)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(DIR, file), 'utf8') })),
);
/** What the app runs without the user's changes: `vdgs_departure_etd` (T103) is off by default. */
const onByDefault = sim.filter((s) => s.def.enabled_by_default);
const etdOnly = sim.filter((s) => s.id === 'vdgs_departure_etd');
const ofpOf = (name: string): Ofp =>
  parseSimbriefOfp(JSON.parse(readFileSync(join(OFPS, `${name}.json`), 'utf8')));

function fly(ofp: Ofp, stands = true, say?: string) {
  const core = AcarsCore.create({ ofp, scenarios: onByDefault, seed: 'sim' });
  core.startFlight();
  const commands: SimCommand[] = [];
  const errors: string[] = [];
  let said = false;
  for (const [i, s] of generateSyntheticFlight({ ofp }).snapshots.entries()) {
    const out = core.tick({
      now: s.t,
      telemetry: s,
      ...(i === 0 && stands ? { data: standsFor(ofp, s.t) } : {}),
      ...(say !== undefined && s.altFt > 30_000 && !said
        ? { inbound: [{ from: ofp.callsign, type: 'telex' as const, text: say }] }
        : {}),
    });
    if (say !== undefined && s.altFt > 30_000) said = true;
    commands.push(...out.commands);
    expect(out.outbound.filter((m) => m.scenarioId !== '#ops')).toEqual([]);
    for (const e of out.events) if (e.type === 'SCENARIO_ERROR') errors.push(e.error);
  }
  return { commands, errors };
}

describe('sim scenarios', () => {
  it('the VDGS scenarios', () => {
    expect(sim.map((s) => s.id)).toEqual([
      'vdgs_arrival',
      'vdgs_departure',
      'vdgs_departure_etd',
      'vdgs_divert',
    ]);
    expect(onByDefault.map((s) => s.id)).not.toContain('vdgs_departure_etd');
  });

  it('vdgs_arrival: flight, origin and gate at the destination after landing', () => {
    const r = fly(ofpOf('rctp-rjbb-a35k-kgs'));
    expect(r.errors).toEqual([]);
    expect(r.commands).toHaveLength(1);
    const v = (r.commands[0] as VdgsCommand).vdgs as VdgsMessage;
    expect(v.airport).toBe('RJBB');
    const narrow = (v.displays.narrow ?? []).map((l) => l.text);
    // 5 lines: the 6th line of a narrow display is GSX's scrolling line.
    expect(narrow).toHaveLength(5);
    expect(narrow.slice(0, 4)).toEqual(['SJX', '822', 'RCTP', 'GATE']);
    expect(narrow[4]).toMatch(/^[A-Z0-9]{1,6}$/);
    expect((v.displays.wide ?? []).map((l) => l.text)).toEqual([
      'SJX 822',
      'FROM RCTP',
      `GATE ${narrow[4]}`,
    ]);
    expect(v.displays.small).toBeUndefined();
  });

  it('vdgs_arrival on an OFP without a flight number: no error', () => {
    const r = fly(ofpOf('rctp-rjbb-a35k-lbs-synthetic'));
    expect(r.errors).toEqual([]);
  });

  it('vdgs_divert: a red DIVERTED line at the diversion airport, no gate; none without a diversion', () => {
    const ofp = ofpOf('rctp-rjbb-a35k-kgs');
    const altn = ofp.alternates[0]?.icao as string;
    const r = fly(ofp, true, `DIVERT ${altn}`);
    expect(r.errors).toEqual([]);
    expect(r.commands).toHaveLength(1);
    const v = (r.commands[0] as VdgsCommand).vdgs as VdgsMessage;
    expect(v.airport).toBe(altn);
    expect(v.displays.wide).toEqual([
      expect.objectContaining({ text: 'SJX 822' }),
      expect.objectContaining({ text: 'DIVERTED' }),
      expect.objectContaining({ text: 'FROM RCTP' }),
    ]);
    expect(JSON.stringify(v)).toMatch(/red/i);
    expect(JSON.stringify(v)).not.toContain('GATE');
  });

  describe('vdgs_departure (T102): the airline TOBT at an A-CDM departure stand', () => {
    const base = ofpOf('rctp-rjbb-a35k-kgs');
    /** The same flight from Dusseldorf (A-CDM, ext/acdm-airports.ts). */
    const fromEddl: Ofp = { ...base, origin: { ...base.origin, icao: 'EDDL' } };
    const sched = fromEddl.times.schedOutMs;
    const MIN = 60_000;
    const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16).replace(':', '');

    /** Ticks the flight up to OUT and a minute after; `pilot`: minutes from STD → text. */
    function atStand(
      ofp: Ofp,
      boardingMin: number,
      pilot: Readonly<Record<number, string>> = {},
      scenarios = onByDefault,
    ) {
      const core = AcarsCore.create({ ofp, scenarios, seed: 'sim' });
      core.startFlight();
      const out: { t: number; c: VdgsCommand }[] = [];
      const errors: string[] = [];
      const said = new Set<number>();
      const flight = generateSyntheticFlight({
        ofp,
        startMs: sched - 35 * MIN,
        boardingSec: boardingMin * 60,
      });
      let outAt: number | null = null;
      for (const s of flight.snapshots) {
        const due = Object.keys(pilot)
          .map(Number)
          .find((m) => !said.has(m) && s.t >= sched + m * MIN);
        if (due !== undefined) said.add(due);
        const o = core.tick({
          now: s.t,
          telemetry: s,
          ...(due === undefined
            ? {}
            : {
                inbound: [
                  { from: ofp.callsign, type: 'telex' as const, text: pilot[due] as string },
                ],
              }),
        });
        for (const c of o.commands) if (c.command === 'vdgs') out.push({ t: s.t, c });
        for (const e of o.events) if (e.type === 'SCENARIO_ERROR') errors.push(e.error);
        if (o.events.some((e) => e.type === 'OOOI_OUT')) outAt = s.t;
        if (outAt !== null && s.t > outAt + MIN) break;
      }
      return { out, errors, outAt };
    }
    const wide = (c: VdgsCommand) => (c.vdgs?.displays.wide ?? []).map((l) => l.text);
    const at = (r: ReturnType<typeof atStand>, min: number) =>
      [...r.out].reverse().find((x) => x.t <= sched + min * MIN)?.c as VdgsCommand;

    it('no board at an airport without A-CDM', () => {
      const r = atStand(base, 35);
      expect(r.errors).toEqual([]);
      expect(r.out).toEqual([]);
    });

    it('flight and destination, TOBT with a countdown from TOBT - 30, blank after, off at OUT', () => {
      const r = atStand(fromEddl, 37);
      expect(r.errors).toEqual([]);
      const first = r.out[0]?.c as VdgsCommand;
      expect(first.vdgs).toMatchObject({ airport: 'EDDL', replaces: 'flight_information' });
      expect(wide(first)).toEqual(['SJX 822', 'TO RJBB', '', '', 'RWY 05R', 'MOLK1A']);
      expect(wide(at(r, -30))).toEqual(
        expect.arrayContaining(['SJX 822', 'TO RJBB', `TOBT ${hhmm(sched)}`, 'TTD 30MIN']),
      );
      expect(wide(at(r, -10))[3]).toMatch(/^TTD 1[01]MIN$/);
      const narrow = (at(r, -5).vdgs?.displays.narrow ?? []).map((l) => l.text);
      expect(narrow).toEqual(['SJX', '822', 'RJBB', 'TOBT', hhmm(sched)]);
      expect(wide(at(r, 1)).slice(2, 4)).toEqual(['', '']);
      const last = r.out.at(-1) as { t: number; c: VdgsCommand };
      expect(last.c.vdgs).toBeNull();
      expect(last.t).toBe(r.outAt);
      // Every page fits every display (buildVdgsMessage checks, a failure is an error above).
      expect(r.out.filter((x) => x.c.vdgs !== null).length).toBeGreaterThan(30);
    });

    it('DELAY moves the TOBT on the next page', () => {
      const r = atStand(fromEddl, 60, { [-20]: 'DELAY 20 TECH' });
      expect(r.errors).toEqual([]);
      expect(wide(at(r, -21))[2]).toBe(`TOBT ${hhmm(sched)}`);
      expect(wide(at(r, -19)).slice(2, 4)).toEqual(['', '']); // TOBT + 20 is 39 min away
      expect(wide(at(r, -10))).toContain(`TOBT ${hhmm(sched + 20 * MIN)}`);
    });

    it('not off block 15 min after the TOBT: FLIGHT SUSPENDED in red; a DELAY brings it back', () => {
      const r = atStand(fromEddl, 35 + 25, { 16: 'DELAY 30' });
      expect(r.errors).toEqual([]);
      expect(wide(at(r, 14)).slice(2, 4)).toEqual(['', '']);
      const s = at(r, 15.5).vdgs;
      expect(s?.displays.wide?.slice(2)).toEqual(
        ['FLIGHT', 'SUSPENDED', 'NEW TOBT', 'REQUIRED'].map((text) => ({ text, red: true })),
      );
      expect(s?.displays.narrow?.map((l) => l.text)).toEqual([
        'FLIGHT',
        'SUSPND',
        'NEW',
        'TOBT',
        'REQRD',
      ]);
      expect(wide(at(r, 18))[2]).toBe(`TOBT ${hhmm(sched + 30 * MIN)}`);
    });

    describe('vdgs_departure_etd (T103): ETD board away from A-CDM, off by default', () => {
      it('none at an A-CDM airport (vdgs_departure is there)', () => {
        const r = atStand(fromEddl, 37, {}, etdOnly);
        expect(r.errors).toEqual([]);
        expect(r.out).toEqual([]);
      });

      it('ETD with a countdown from ETD - 30, blank after, no SUSPENDED, off at OUT', () => {
        const etd = base.times.estOutMs;
        const r = atStand(base, 35 + 25, {}, etdOnly);
        expect(r.errors).toEqual([]);
        const first = r.out[0]?.c as VdgsCommand;
        expect(first.vdgs).toMatchObject({ airport: 'RCTP', replaces: 'flight_information' });
        expect(wide(first).slice(2, 4)).toEqual(['', '']);
        const m = Math.ceil((etd - (sched - 10 * MIN)) / MIN);
        expect(wide(at(r, -10)).slice(2, 4)).toEqual([`ETD ${hhmm(etd)}`, `TTD ${m}MIN`]);
        expect((at(r, -5).vdgs?.displays.narrow ?? []).map((l) => l.text)).toEqual([
          'SJX',
          '822',
          'RJBB',
          'ETD',
          hhmm(etd),
        ]);
        expect(JSON.stringify(at(r, 20).vdgs)).not.toMatch(/SUSP|red":true/);
        expect(r.out.at(-1)?.c.vdgs).toBeNull();
      });

      it('a DELAY moves the ETD (ETD = ofp.est_out: every delay)', () => {
        const etd = base.times.estOutMs;
        const r = atStand(base, 60, { [-20]: 'DELAY 20' }, etdOnly);
        expect(r.errors).toEqual([]);
        expect(wide(at(r, -5))[2]).toBe(`ETD ${hhmm(etd + 20 * MIN)}`);
      });
    });
  });
});
