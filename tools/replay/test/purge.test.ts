import { describe, expect, it } from 'vitest';
import { hasPurgedConnex, PURGED_TEXT, purgeConnex } from '../src/index.js';

/** T30 C9: AeroDataBox data leave recordings older than 7 days; identifiers stay. */

const header = JSON.stringify({ type: 'header', v: 1 });
const connex = {
  icao: 'RJBB',
  list: [{ number: 'JX862', dest: 'RCTP', std: 1, terminal: '1', gate: '12', codeshare: false }],
};
const tick = JSON.stringify({ type: 'tick', now: 1, telemetry: null, data: { t: 1, connex } });
const plain = JSON.stringify({ type: 'tick', now: 2, telemetry: null });
const out = JSON.stringify({
  type: 'out',
  t: 3,
  scenarioId: 'connex_list',
  from: 'OPS',
  to: 'SJX822',
  text: 'CONNEX RJBB\nJX862 RCTP 1135Z 12\nSRC AERODATABOX',
});
const file = `${[header, tick, plain, out].join('\n')}\n`;

describe('purgeConnex', () => {
  it('times, terminals, gates and the telexes go; numbers and airports stay', () => {
    const purged = purgeConnex(file) as string;
    const lines = purged.split('\n');
    expect(lines[0]).toBe(header);
    expect(lines[2]).toBe(plain);
    expect(JSON.parse(lines[1] as string).data.connex.list).toEqual([
      { number: 'JX862', dest: 'RCTP', std: null, terminal: null, gate: null, codeshare: false },
    ]);
    expect(JSON.parse(lines[3] as string).text).toBe(PURGED_TEXT);
    expect(purged).not.toContain('1135Z');
    expect(purged.endsWith('\n')).toBe(true);
    expect(hasPurgedConnex(purged)).toBe(true);
    expect(hasPurgedConnex(file)).toBe(false);
  });

  it('nothing to do: null (no data, already purged, a broken last line kept)', () => {
    expect(purgeConnex(`${[header, plain].join('\n')}\n`)).toBeNull();
    expect(purgeConnex(purgeConnex(file) as string)).toBeNull();
    const broken = `${file}{"type":"tick","data":{"connex"`;
    expect((purgeConnex(broken) as string).endsWith('{"type":"tick","data":{"connex"')).toBe(true);
  });
});
