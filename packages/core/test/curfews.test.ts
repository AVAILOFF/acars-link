import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CURFEWS, latestLanding, type Ofp, parseSimbriefOfp } from '../src/index.js';

/** T42 item 4: night curfews of destinations from the table of real ones. */

const base = parseSimbriefOfp(
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'ofp', 'rctp-rjbb-a35k-kgs.json'), 'utf8'),
  ),
);

/** `base` to `dest` from `orig`, scheduled ON at `onUtc` (ISO). */
function flight(dest: string, offsetH: number | null, onUtc: string, orig = 'RCTP'): Ofp {
  const on = Date.parse(onUtc);
  return {
    ...base,
    origin: { ...base.origin, icao: orig },
    destination: { ...base.destination, icao: dest, utcOffsetH: offsetH },
    times: { ...base.times, schedOnMs: on, schedInMs: on + 5 * 60_000 },
  };
}
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe('curfew table', () => {
  it('one entry per airport, valid hours, source and date', () => {
    const icaos = CURFEWS.map((c) => c.icao);
    expect(new Set(icaos).size).toBe(icaos.length);
    for (const c of CURFEWS) {
      const rules = [c.rule, ...Object.values(c.days ?? {}), ...(c.intl ? [c.intl] : [])];
      for (const r of rules) {
        if (r === undefined) continue;
        expect(r.start, c.icao).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
        expect(r.allowanceMin, c.icao).toBeGreaterThanOrEqual(0);
      }
      expect(c.url, c.icao).toMatch(/^https:\/\//);
      expect(c.checked, c.icao).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.source.length, c.icao).toBeGreaterThan(0);
    }
  });

  it('quota-only airports are not curfews', () => {
    for (const icao of ['EGCC', 'EGLL', 'EHAM', 'EDDM', 'RJBB'])
      expect(latestLanding(flight(icao, 0, '2026-10-25T14:30:00Z'))).toBeNull();
  });
});

describe('latestLanding', () => {
  it('start plus the delay allowance, in UTC (EDDF 23:00 + 60, CET)', () => {
    expect(iso(latestLanding(flight('EDDF', 1, '2026-10-25T21:40:00Z')))).toBe(
      '2026-10-25T23:00:00.000Z',
    );
  });

  it('no allowance: the start itself (YSSY 23:00, AEDT)', () => {
    expect(iso(latestLanding(flight('YSSY', 11, '2026-10-25T11:30:00Z')))).toBe(
      '2026-10-25T12:00:00.000Z',
    );
  });

  it('a flight scheduled inside the curfew gets the next night: no message', () => {
    // 23:30 local in Sydney: the next start is 23:00 a day later.
    expect(iso(latestLanding(flight('YSSY', 11, '2026-10-25T12:30:00Z')))).toBe(
      '2026-10-26T12:00:00.000Z',
    );
  });

  it('a start after midnight local (LSGG 00:00)', () => {
    expect(iso(latestLanding(flight('LSGG', 1, '2026-10-25T22:30:00Z')))).toBe(
      '2026-10-25T23:00:00.000Z',
    );
  });

  it('weekday hours (EGLC: Saturday 12:30 + 30, else 22:00 + 30)', () => {
    // 2026-10-31 is a Saturday, 2026-10-30 a Friday; GMT.
    expect(iso(latestLanding(flight('EGLC', 0, '2026-10-31T11:50:00Z')))).toBe(
      '2026-10-31T13:00:00.000Z',
    );
    expect(iso(latestLanding(flight('EGLC', 0, '2026-10-30T21:30:00Z')))).toBe(
      '2026-10-30T22:30:00.000Z',
    );
  });

  it('international arrivals (NZWN: domestic 00:00, from abroad 01:00, + 30)', () => {
    // 23:40 local NZDT (UTC+13).
    const on = '2026-10-25T10:40:00Z';
    expect(iso(latestLanding(flight('NZWN', 13, on, 'NZAA')))).toBe('2026-10-25T11:30:00.000Z');
    expect(iso(latestLanding(flight('NZWN', 13, on, 'YSSY')))).toBe('2026-10-25T12:30:00.000Z');
  });

  it('no UTC offset in the OFP: no curfew', () => {
    expect(latestLanding(flight('EDDF', null, '2026-10-25T21:40:00Z'))).toBeNull();
  });
});
