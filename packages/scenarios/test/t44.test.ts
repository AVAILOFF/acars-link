// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AcarsCore,
  type CompiledScenario,
  type CoreEvent,
  type ExtDataUpdate,
  generateSyntheticFlight,
  type Ofp,
  OPS_REPLY_ID,
  type OutboundMessage,
  type PilotMessage,
  parseSimbriefOfp,
  type SyntheticFlight,
  stageIndex,
  type Value,
} from '@acars/core';
import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../src/index.js';
import { standsFor } from './stands.js';

/**
 * T44: the pilot commands MEDICAL, REQ ATIS, RDY, REQ GATE CHANGE and the diversion chain
 * (ETA to the alternate, arrival on block, the next flight from there).
 */

const MIN = 60_000;
const dir = (name: string) => join(import.meta.dirname, '..', name);
const read = (name: string) =>
  readdirSync(dir(name))
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(dir(name), file), 'utf8') }));
const everything = loadScenarios([...read('base'), ...read('commands'), ...read('irregular')]);
const only = (...ids: string[]): CompiledScenario[] =>
  everything.filter((s) => ids.includes(s.id)).map((s) => ({ ...s, probability: 1 }));

const kg: Ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../core/test/fixtures/ofp/rctp-rjbb-a35k-kgs.json'),
      'utf8',
    ),
  ),
);
const flightOf = (ofp: Ofp = kg, startMs?: number): SyntheticFlight =>
  generateSyntheticFlight({ ofp, ...(startMs === undefined ? {} : { startMs }) });

interface Say {
  readonly at: number;
  readonly text: string;
}

interface Run {
  readonly core: AcarsCore;
  readonly out: OutboundMessage[];
  readonly events: CoreEvent[];
}

function run(
  scenarios: readonly CompiledScenario[],
  flight: SyntheticFlight,
  say: readonly Say[],
  o: {
    readonly ofp?: Ofp;
    readonly seed?: string;
    readonly data?: (i: number, t: number) => ExtDataUpdate | undefined;
    readonly flags?: Readonly<Record<string, Value>>;
    readonly stands?: boolean;
  } = {},
): Run {
  const ofp = o.ofp ?? kg;
  const core = AcarsCore.create({
    ofp,
    scenarios,
    seed: o.seed ?? 't44',
    ...(o.flags === undefined ? {} : { flags: o.flags }),
  });
  core.startFlight();
  const out: OutboundMessage[] = [];
  const events: CoreEvent[] = [];
  flight.snapshots.forEach((s, i) => {
    const inbound: PilotMessage[] = say
      .filter((x) => x.at === i)
      .map((x) => ({ from: ofp.callsign, type: 'telex', text: x.text }));
    const stands = i === 0 && o.stands !== false ? standsFor(ofp, s.t) : undefined;
    const extra = o.data?.(i, s.t);
    const data: ExtDataUpdate | undefined =
      stands === undefined && extra === undefined
        ? undefined
        : { ...(stands ?? { t: s.t }), ...(extra ?? {}) };
    const r = core.tick({
      now: s.t,
      telemetry: s,
      ...(inbound.length > 0 ? { inbound } : {}),
      ...(data === undefined ? {} : { data }),
    });
    out.push(...r.outbound);
    events.push(...r.events);
  });
  return { core, out, events };
}

const ids = (r: Run) => r.out.map((m) => m.scenarioId);
const textsOf = (r: Run, id: string) =>
  r.out.filter((m) => m.scenarioId === id).map((m) => m.message.text.replaceAll('\n', ' '));
const all = (r: Run) => r.out.map((m) => m.message.text.replaceAll('\n', ' ')).join(' | ');
const errors = (r: Run) => r.events.filter((e) => e.type === 'SCENARIO_ERROR');

describe('MEDICAL <text> (T44)', () => {
  const f = flightOf();
  const climb = stageIndex(f, 'CLIMB', 60);

  it('the pilot text is in the answer; DIVERT sets the diversion; the random case stays away', () => {
    const r = run(
      only('cmd_medical', 'medical_onboard', 'divert_arrival'),
      f,
      [
        { at: climb, text: 'MEDICAL CHEST PAIN ROW 23' },
        { at: climb + 30, text: 'DIVERT' },
      ],
      { seed: 'med' },
    );
    expect(errors(r)).toEqual([]);
    const first = textsOf(r, 'cmd_medical')[0] ?? '';
    expect(first).toContain('CREW INFO: CHEST PAIN ROW 23');
    expect(first).toContain('REPLY CONTINUE OR DIVERT');
    expect(textsOf(r, 'cmd_medical')[1]).toContain('ROGER DIVERT');
    expect(textsOf(r, 'cmd_medical').at(-1)).toContain('PARAMEDICS AT AIRCRAFT DOOR');
    expect(ids(r)).not.toContain('medical_onboard');
    // The diversion it caused is a diversion like any other.
    expect(ids(r)).toContain('divert_arrival');
  });

  it('CONTINUE; on the ground it is UNABLE', () => {
    const r = run(only('cmd_medical'), f, [
      { at: climb, text: 'MEDICAL' },
      { at: climb + 20, text: 'CONTINUE' },
      { at: 100, text: 'MEDICAL FAINTED' },
    ]);
    expect(errors(r)).toEqual([]);
    expect(textsOf(r, 'cmd_medical')[0]).toContain('CREW INFO: NO DETAILS');
    expect(textsOf(r, 'cmd_medical')[1]).toContain('CONTINUE TO RJBB');
    expect(textsOf(r, OPS_REPLY_ID).join(' ')).toContain('UNABLE MEDICAL NOT AIRBORNE');
  });
});

describe('REQ ATIS [ICAO] (T44)', () => {
  const f = flightOf();
  const cruise = stageIndex(f, 'CRUISE', 60);
  const station = (icao: string, text: string | null) => ({
    atc: {
      [icao]: [
        {
          callsign: `${icao}_ATIS`,
          facility: 'ATIS' as const,
          frequency: '128.000',
          atisCode: 'K',
          atisText: text,
        },
      ],
    },
  });

  it('the VATSIM ATIS text of the destination (no airport) and of another airport', () => {
    const r = run(
      only('cmd_req_atis', 'cmd_req_atis_none'),
      f,
      [
        { at: cruise, text: 'REQ ATIS' },
        { at: cruise + 5, text: 'REQ ATIS RCTP' },
      ],
      {
        data: (i, t) =>
          i === cruise - 1
            ? {
                t,
                atc: {
                  ...station('RJBB', 'RJBB INFORMATION K 1200Z RUNWAY 06L IN USE').atc,
                  ...station('RCTP', null).atc,
                },
              }
            : undefined,
      },
    );
    expect(errors(r)).toEqual([]);
    expect(textsOf(r, 'cmd_req_atis')[0]).toContain('INFO K RJBB INFORMATION K 1200Z RUNWAY 06L');
    // The station of RCTP has no text: no ATIS, and what weather there is.
    expect(textsOf(r, 'cmd_req_atis_none')[0]).toContain('NO ATIS AVBL');
  });

  it('no data at all: NO ATIS AVBL, no invented text', () => {
    const r = run(only('cmd_req_atis', 'cmd_req_atis_none'), f, [{ at: cruise, text: 'REQ ATIS' }]);
    expect(ids(r)).toEqual(['cmd_req_atis_none']);
    expect(all(r)).toContain('NO ATIS AVBL');
    expect(all(r)).not.toContain('SOURCE VATSIM');
  });
});

describe('RDY (T44)', () => {
  const sched = kg.times.schedOutMs;
  // The slot of a seed, from a plain run.
  const slotOf = (seed: string) =>
    Number(
      /DELAY (\d+) MIN/.exec(
        textsOf(run(only('slot_ctot'), flightOf(), [], { seed }), 'slot_ctot')[0] ?? '',
      )?.[1],
    );

  /** RDY near the end of the window; the flight leaves just after it, as a ready crew would. */
  const rdy = (seed: string) => {
    const slot = slotOf(seed);
    const flight = flightOf(kg, sched - 35 * MIN + slot * MIN);
    const at = flight.snapshots.findIndex((s) => s.t >= sched + (slot - 4) * MIN);
    return run(only('slot_ctot', 'cmd_rdy', 'cmd_rdy_none'), flight, [{ at, text: 'RDY' }], {
      seed,
    });
  };

  it('READY MSG SENT, then an earlier CTOT or no improvement (both happen, seed decides)', () => {
    const seen = new Set<string>();
    for (let n = 1; n <= 14; n++) {
      const r = rdy(`rdy${n}`);
      expect(errors(r)).toEqual([]);
      const t = textsOf(r, 'cmd_rdy');
      expect(t[0], `seed rdy${n}: ${all(r)}`).toContain('READY MSG SENT');
      // The CTOT is the one the slot announced, not moved by the delay the slot caused.
      const announced = /CTOT (\d{4})Z/.exec(textsOf(r, 'slot_ctot')[0] ?? '')?.[1];
      expect(t[0]).toContain(`CTOT ${announced}Z`);
      expect(t).toHaveLength(2);
      // The answer comes 3 minutes later.
      const sent = r.out.filter((m) => m.scenarioId === 'cmd_rdy');
      expect((sent[1]?.t ?? 0) - (sent[0]?.t ?? 0)).toBeGreaterThanOrEqual(3 * MIN);
      if (t[1]?.includes('IMPROVED SLOT')) {
        seen.add('better');
        const nw = /NEW CTOT (\d{4})Z OLD CTOT (\d{4})Z/.exec(t[1] ?? '');
        expect(nw?.[1] && nw[2] && nw[1] < nw[2]).toBe(true);
      } else {
        seen.add('same');
        expect(t[1]).toContain('NO IMPROVEMENT');
      }
    }
    expect([...seen].sort()).toEqual(['better', 'same']);
  }, 60_000);

  it('same seed → same answer', () => {
    expect(all(rdy('rdy3'))).toBe(all(rdy('rdy3')));
  });

  it('no CTOT issued: nothing to improve', () => {
    const f = flightOf();
    const r = run(only('cmd_rdy', 'cmd_rdy_none'), f, [{ at: 600, text: 'RDY' }]);
    expect(ids(r)).toEqual(['cmd_rdy_none']);
    expect(all(r)).toContain('NO SLOT RESTRICTION');
  });

  it('after off-block it is UNABLE', () => {
    const f = flightOf();
    const r = run(only('slot_ctot', 'cmd_rdy', 'cmd_rdy_none'), f, [
      { at: stageIndex(f, 'TAXI_OUT', 30), text: 'RDY' },
    ]);
    expect(textsOf(r, OPS_REPLY_ID).join(' ')).toContain('UNABLE RDY OFF BLOCK ALREADY');
    expect(ids(r)).not.toContain('cmd_rdy');
  });
});

describe('REQ GATE CHANGE (T44)', () => {
  const f = flightOf();
  const cruise = stageIndex(f, 'CRUISE', 60);
  const set = only(
    'gate_assignment',
    'arrival_info',
    'cmd_req_gate',
    'cmd_gate_change',
    'cmd_gate_change_none',
  );

  const change = (seed: string, text = 'REQ GATE CHANGE B2 NEARER TO EXIT') =>
    run(
      set,
      f,
      [
        { at: cruise, text },
        { at: cruise + 20, text: 'REQ GATE' },
      ],
      { seed },
    );

  it('approved: the gate asked for, and everything names it afterwards; refused: nothing changes', () => {
    const seen = new Set<string>();
    for (let n = 1; n <= 14; n++) {
      const r = change(`gc${n}`);
      expect(errors(r)).toEqual([]);
      const gc = [...textsOf(r, 'cmd_gate_change'), ...textsOf(r, 'cmd_gate_change_none')];
      expect(gc).toHaveLength(1);
      const asked = textsOf(r, 'cmd_req_gate')[0] ?? '';
      const arrival = textsOf(r, 'arrival_info')[0] ?? '';
      if (gc[0]?.includes('APPROVED')) {
        seen.add('approved');
        // The gate asked for (B2), or another one when B2 is the gate it already has.
        const gate = /NEW GATE (\w+)/.exec(gc[0] ?? '')?.[1] ?? '';
        expect(['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3']).toContain(gate);
        expect(asked).toContain(`EXPECTED GATE ${gate}`);
        expect(arrival).toContain(`GATE ${gate} CONFIRMED`);
      } else {
        seen.add('refused');
        expect(gc[0]).toContain('ALL GATES OCCUPIED');
        expect(asked).toContain('EXPECTED GATE');
        const kept = /KEEP GATE (\w+)/.exec(gc[0] ?? '')?.[1];
        expect(asked).toContain(`EXPECTED GATE ${kept}`);
      }
    }
    expect([...seen].sort()).toEqual(['approved', 'refused']);
  }, 60_000);

  it('a gate that is not known is not asked for: the alternative is offered', () => {
    for (let n = 1; n <= 8; n++) {
      const r = change(`gc${n}`, 'REQ GATE CHANGE Z99');
      const gc = textsOf(r, 'cmd_gate_change')[0] ?? '';
      if (gc.includes('APPROVED')) expect(gc).not.toContain('Z99');
    }
  }, 60_000);

  it('no stands known: no gate change, nothing invented', () => {
    const r = run(set, f, [{ at: cruise, text: 'REQ GATE CHANGE' }], { stands: false });
    expect(ids(r).filter((x) => x.startsWith('cmd_'))).toEqual(['cmd_gate_change_none']);
    expect(all(r)).toContain('GATE WILL BE ADVISED');
  });

  it('on block it is UNABLE', () => {
    const r = run(set, f, [{ at: f.snapshots.length - 5, text: 'REQ GATE CHANGE' }]);
    expect(textsOf(r, OPS_REPLY_ID).join(' ')).toContain('UNABLE REQ GATE CHANGE ALREADY ON BLOCK');
  });
});

describe('diversion chain (T44)', () => {
  const f = flightOf();
  const cruise = stageIndex(f, 'CRUISE', 120);
  const altn = kg.alternates[0]?.icao ?? '';
  const set = only('cmd_divert', 'cmd_divert_eta', 'divert_arrival', 'welcome_turnaround');

  it('distance and ETA to an alternate of the plan; none for an unknown airport', () => {
    const known = run(set, f, [{ at: cruise, text: `DIVERT ${altn}` }]);
    const eta = textsOf(known, 'cmd_divert_eta')[0] ?? '';
    expect(eta).toMatch(new RegExp(`${altn} \\d+ NM FROM PRESENT POS ETA \\d{4}Z AT PRESENT GS`));
    const unknown = run(set, f, [{ at: cruise, text: 'DIVERT RJOO' }]);
    expect(textsOf(unknown, 'cmd_divert_eta')).toEqual([]);
    expect(textsOf(unknown, 'cmd_divert')[0]).toContain('DIVERT RJOO RCVD');
  });

  it('on block at the alternate: handling; the next flight from there is told', () => {
    const r = run(set, f, [{ at: cruise, text: `DIVERT ${altn}` }]);
    expect(errors(r)).toEqual([]);
    expect(textsOf(r, 'divert_arrival')[0]).toContain(`ON BLOCK ${altn}`);
    // The normal welcome stays away on a diversion.
    expect(ids(r)).not.toContain('welcome_turnaround');
    expect(r.core.flags).toMatchObject({ recovery_airport: altn, recovery_flight: kg.callsign });

    // The next flight starts at the alternate.
    const next: Ofp = { ...kg, origin: kg.alternates[0] as Ofp['origin'] };
    const second = run(only('recovery_followup'), flightOf(next), [], {
      ofp: next,
      flags: r.core.flags,
    });
    expect(errors(second)).toEqual([]);
    expect(textsOf(second, 'recovery_followup')[0]).toContain(`AFTER DIVERSION OF ${kg.callsign}`);
    // Used once.
    expect(second.core.flags['recovery_airport']).toBeUndefined();
    // A flight from another airport hears nothing.
    const other = run(only('recovery_followup'), flightOf(), [], { flags: r.core.flags });
    expect(ids(other)).toEqual([]);
  });

  it('a flight without a diversion: no diversion messages', () => {
    const r = run(set, f, []);
    expect(ids(r)).not.toContain('divert_arrival');
    expect(r.core.flags['recovery_airport']).toBeUndefined();
  });
});
