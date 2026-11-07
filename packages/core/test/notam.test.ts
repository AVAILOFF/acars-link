// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  clipWords,
  NOTAM_MAX_ITEMS,
  NOTAM_NIL,
  NOTAM_TEXT_MAX,
  notamLines,
  notamRank,
  notamText,
  notamTime,
  selectNotams,
} from '../src/ext/notam.js';
import { alignOfpDay, type Ofp, type OfpNotam, parseSimbriefOfp } from '../src/ofp/index.js';
import { normalizePilotText, parseCommand } from '../src/scenario/pilot.js';

/** T95: NOTAM of the OFP, the company summary and `REQ NOTAM`. */

const FIX = join(import.meta.dirname, 'fixtures/ofp');
const json = (name: string) => JSON.parse(readFileSync(join(FIX, name), 'utf8'));
const notams = json('notams-rjbb-rjgg.json');

/** The kgs fixture with real NOTAM of RJBB / RJGG (and other shapes under the destination). */
function withNotams(extra: readonly unknown[] = []): Ofp {
  const raw = json('rctp-rjbb-a35k-kgs.json');
  raw.destination.notam = [...notams.destination, ...extra];
  raw.alternate[0].notam = notams.alternate;
  return parseSimbriefOfp(raw);
}

const ofp = withNotams(notams.other);
const byId = (id: string) => ofp.notams?.find((n) => n.id === id) as OfpNotam;
const ms = (iso: string) => Date.parse(iso);
const ETA = ms('2026-10-08T10:14:23Z');

describe('notam[] of the OFP (T95)', () => {
  it('reads every entry of the destination, alternate and other shapes, in OFP order', () => {
    expect(ofp.notams?.map((n) => `${n.icao} ${n.id}`)).toEqual([
      ...notams.destination.map(
        (n: { location_icao: string; notam_id: string }) => `${n.location_icao} ${n.notam_id}`,
      ),
      ...notams.other.map(
        (n: { location_icao: string; notam_id: string }) => `${n.location_icao} ${n.notam_id}`,
      ),
      ...notams.alternate.map(
        (n: { location_icao: string; notam_id: string }) => `${n.location_icao} ${n.notam_id}`,
      ),
    ]);
  });

  it('keeps the fields; the schedule line SimBrief puts first is not part of the text', () => {
    expect(byId('B2655/26')).toEqual({
      id: 'B2655/26',
      icao: 'RJBB',
      qcode: 'QMRLC',
      startMs: ms('2026-10-07T15:00:00Z'),
      endMs: ms('2026-10-30T21:30:00Z'),
      endEstimated: false,
      schedule: '07 09 13-14 16 20-21 23 27-28 30 1500/2130',
      text: 'RWY 06R/24L CLSD DUE TO MAINT',
    });
    // Lines of item E are joined by spaces.
    expect(byId('B2496/26').text).toBe(
      'TRIGGER NOTAM-AIRAC AIP SUP 218/26 WEF 01 OCT 2026 TIL 29 SEP 2027 UNSERVICEABILITY OF KANSAI ILS',
    );
  });

  it('empty Q-code ([]), PERM (false), estimated end as true / "1" / {} and schedule {}', () => {
    expect(byId('10/132').qcode).toBeNull();
    expect(byId('A5472/26').endMs).toBeNull();
    expect(byId('B2647/26').endEstimated).toBe(true);
    expect(byId('A3470/26').endEstimated).toBe(true);
    expect(byId('A3470/26').schedule).toBeNull();
    expect(byId('U2508/26').endEstimated).toBe(false);
  });

  it('an entry that does not read is left out, the plan is not refused', () => {
    const o = withNotams([{ notam_id: 'X1/26' }, { notam_id: 'X2/26', date_effective: 'soon' }]);
    expect(o.notams?.some((n) => n.id.startsWith('X'))).toBe(false);
  });

  it('an OFP without NOTAM has no field (as recordings made before T95)', () => {
    expect('notams' in parseSimbriefOfp(json('rctp-rjbb-a35k-kgs.json'))).toBe(false);
  });

  it('moves with the plan when the OFP day follows the flight clock', () => {
    const { ofp: moved, days } = alignOfpDay(ofp, ofp.times.schedOutMs + 3 * 86_400_000);
    expect(days).toBe(3);
    const n = moved.notams?.find((x) => x.id === 'B2655/26');
    expect(n?.startMs).toBe(byId('B2655/26').startMs + 3 * 86_400_000);
    expect(moved.notams?.find((x) => x.id === 'A5472/26')?.endMs).toBeNull();
  });

  // The OFPs SimBrief made for the user (not in git): every NOTAM there reads.
  const REF = join(import.meta.dirname, '../../../reference/ofp/raw');
  it.runIf(existsSync(REF))('reads the NOTAM of the reference OFPs', () => {
    // Only json=v2 OFPs (ISO `params.time_generated`), not other responses saved there.
    for (const f of readdirSync(REF).filter((x) => x.endsWith('.json'))) {
      const raw = JSON.parse(readFileSync(join(REF, f), 'utf8'));
      if (!/^\d{4}-/.test(String(raw.params?.time_generated))) continue;
      const count = ['origin', 'destination', 'alternate']
        .flatMap((k) => [raw[k] ?? []].flat())
        .reduce((s, a) => s + [a.notam ?? []].flat().length, 0);
      expect(parseSimbriefOfp(raw).notams?.length ?? 0, f).toBe(count);
    }
  });
});

describe('the company summary (T95)', () => {
  it('Q-codes: subject groups in order; taxiways, obstacles, warnings, no code, back to normal — out', () => {
    const rank = (qcode: string | null) => notamRank({ ...byId('B2655/26'), qcode });
    expect(rank('QFALC')).toBe(0);
    expect(rank('QMRLC')).toBe(1);
    expect(rank('QICAS')).toBe(2);
    expect(rank('QPICH')).toBe(3);
    expect(rank('QLPAS')).toBe(4);
    expect(rank('QMPLC')).toBe(5);
    for (const q of ['QMXLC', 'QLXAS', 'QLYCS', 'QOLAS', 'QOBAW', 'QWULW', 'QXXXX', null]) {
      expect(rank(q), String(q)).toBeNull();
    }
    for (const c of ['AK', 'AO', 'AF', 'CC', 'HV', 'CN', 'AX']) {
      expect(rank(`QMR${c}`), c).toBeNull();
    }
  });

  it('picks the NOTAM in force within an hour of the ETA, most important first', () => {
    // QFATT (aerodrome) before QMRLC (runway).
    expect(selectNotams(ofp.notams, 'RJBB', ETA).map((n) => n.id)).toEqual([
      'B2496/26',
      'B2655/26',
    ]);
    expect(selectNotams(ofp.notams, 'RJGG', ETA).map((n) => n.id)).toEqual([
      'G2431/26',
      'G2359/26',
    ]);
    // B2496/26 ends 2026-10-14 15:00: not at an ETA an hour and a bit later.
    const late = ms('2026-10-14T16:01:00Z');
    expect(selectNotams(ofp.notams, 'RJBB', late).map((n) => n.id)).toEqual(['B2655/26']);
    expect(selectNotams(ofp.notams, 'RJBB', ms('2026-10-14T16:00:00Z')).length).toBe(2);
    // Starts within the hour after the ETA.
    const early = ms('2026-10-07T14:00:00Z');
    expect(selectNotams(ofp.notams, 'RJBB', early).map((n) => n.id)).toContain('B2655/26');
    expect(selectNotams(ofp.notams, 'RJBB', early - 1).map((n) => n.id)).not.toContain('B2655/26');
    expect(selectNotams(undefined, 'RJBB', ETA)).toEqual([]);
  });

  it(`at most ${NOTAM_MAX_ITEMS} per airport`, () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      ...notams.destination[1],
      notam_id: `B90${i}/26`,
    }));
    const o = withNotams(many);
    expect(selectNotams(o.notams, 'RJBB', ETA)).toHaveLength(NOTAM_MAX_ITEMS);
  });

  it('an item: id and end of validity, text cut to two lines, the schedule as it is', () => {
    expect(notamLines(byId('B2655/26'))).toEqual([
      'B2655/26 TIL 302130Z',
      'RWY 06R/24L CLSD DUE TO MAINT',
      'SKED 07 09 13-14 16 20-21 23 27-28 30 1500/2130',
    ]);
    const long = notamLines(byId('B2496/26'));
    expect(long[1]).toBe('TRIGGER NOTAM-AIRAC AIP SUP 218/26 WEF 01 OCT');
    expect(long[1]?.length).toBeLessThanOrEqual(NOTAM_TEXT_MAX);
    expect(notamLines(byId('A5472/26'))[0]).toBe('A5472/26 PERM');
    expect(notamLines(byId('B2647/26'))[0]).toBe('B2647/26 TIL 061030Z EST');
  });

  it('clipWords cuts at a space, a single long word at the limit', () => {
    expect(clipWords('AAA BBB CCC', 7)).toBe('AAA BBB');
    expect(clipWords('AAA BBB CCC', 6)).toBe('AAA');
    expect(clipWords('ABCDEFGHIJ', 4)).toBe('ABCD');
    expect(clipWords('SHORT', 48)).toBe('SHORT');
  });

  it('nothing to tell = NIL SIGNIFICANT', () => {
    expect(notamText([])).toBe(NOTAM_NIL);
    expect(notamText([byId('B2655/26')]).split('\n')).toHaveLength(3);
  });

  it('the time: ETA from take-off, the plan moved by the delay, departure for the origin', () => {
    const t = ofp.times;
    const off = ms('2026-10-08T08:30:00Z');
    expect(notamTime(ofp, 'RJBB', off, 0)).toBe(off + t.estTimeEnrouteSec * 1000);
    expect(notamTime(ofp, 'RJBB', null, 600_000)).toBe((t.estOnMs as number) + 600_000);
    expect(notamTime(ofp, 'RCTP', null, 600_000)).toBe(t.estOutMs + 600_000);
    expect(notamTime(ofp, 'RCTP', off, 0)).toBe(off + t.estTimeEnrouteSec * 1000);
  });
});

describe('REQ NOTAM (T95)', () => {
  const cmd = (text: string) => parseCommand(normalizePilotText(text));
  it('with and without an airport; a bad airport gets the format', () => {
    expect(cmd('REQ NOTAM')).toMatchObject({
      ok: true,
      command: 'REQ_NOTAM',
      args: { icao: null },
    });
    expect(cmd('req notam rjgg')).toMatchObject({ ok: true, args: { icao: 'RJGG' } });
    expect(cmd('REQ NOTAM 12')).toEqual({
      ok: false,
      command: 'REQ_NOTAM',
      hint: 'REQ NOTAM ICAO',
    });
  });
});
