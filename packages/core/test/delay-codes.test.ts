import { describe, expect, it } from 'vitest';
import { delayLine, reasonCode } from '../src/scenario/delay-codes.js';

const MIN = 60_000;

describe('IATA delay codes (T43)', () => {
  it('codes a pilot reason: a code given first, a keyword, else 99', () => {
    expect(reasonCode('41 BRAKE TEMP')).toBe('41');
    expect(reasonCode('TECH ISSUE')).toBe('41');
    expect(reasonCode('LATE FUEL TRUCK')).toBe('36');
    expect(reasonCode('waiting for pax')).toBe('15');
    expect(reasonCode('DEICING')).toBe('75');
    expect(reasonCode('ATC SLOT')).toBe('81');
    expect(reasonCode('00 X')).toBe('99'); // airline internal codes are not given out
    expect(reasonCode('NO IDEA')).toBe('99');
    expect(reasonCode(null)).toBe('99');
  });

  it('on time or before OUT: no line', () => {
    expect(delayLine([{ code: '81', ms: 20 * MIN }], 0)).toBeNull();
    expect(delayLine([], -3)).toBeNull();
  });

  it('one cause: DL<code>/<hhmm>', () => {
    expect(delayLine([{ code: '81', ms: 25 * MIN }], 25)).toBe('DL81/0025');
  });

  it('two causes, largest first; same code summed; MVT form DL64/72/0015/0020', () => {
    const parts = [
      { code: '63', ms: 10 * MIN },
      { code: '81', ms: 15 * MIN },
      { code: '63', ms: 10 * MIN },
    ];
    expect(delayLine(parts, 35)).toBe('DL63/81/0020/0015');
  });

  it('the unexplained rest is 99; causes beyond the delay are cut', () => {
    expect(delayLine([{ code: '41', ms: 10 * MIN }], 14)).toBe('DL41/99/0010/0004');
    expect(delayLine([], 7)).toBe('DL99/0007');
    // Pushed back only 12 min late after a 30 min slot: the slot explains all of it.
    expect(delayLine([{ code: '81', ms: 30 * MIN }], 12)).toBe('DL81/0012');
  });

  it('only two codes are shown, the largest', () => {
    const parts = [
      { code: '15', ms: 5 * MIN },
      { code: '41', ms: 20 * MIN },
      { code: '81', ms: 10 * MIN },
    ];
    expect(delayLine(parts, 35)).toBe('DL41/81/0020/0010');
    expect(delayLine([{ code: '41', ms: 125 * MIN }], 125)).toBe('DL41/0205');
  });
});
