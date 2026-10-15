import { describe, expect, it } from 'vitest';
import { atcHints, lacksCpdlc, NO_CPDLC_AIRCRAFT } from '../src/shared/atc-hints.js';

const atc = { station: 'XFIN', connected: null, dcl: 'XFHK' };
const base = { atc, aircraftTitle: 'FenixA320_DLH', phase: 'PUSHBACK', callsign: 'FIN4E' } as const;

describe('ROPS hints under Status (T49)', () => {
  it('says where to log on and where to send the PDC', () => {
    expect(atcHints(base)).toEqual([{ key: 'atc.hint', params: { fir: 'XFIN', dcl: 'XFHK' } }]);
    expect(atcHints({ ...base, atc: { ...atc, dcl: null } })).toEqual([
      { key: 'atc.hintFir', params: { fir: 'XFIN' } },
    ]);
    expect(atcHints({ ...base, atc: { ...atc, station: null } })).toEqual([
      { key: 'atc.hintDcl', params: { dcl: 'XFHK' } },
    ]);
  });

  it('no hints when ROPS is off', () => {
    expect(atcHints({ ...base, atc: null })).toEqual([]);
  });

  it('an aircraft from the no-CPDLC list: only the PDC remains', () => {
    const list = [/NOCPDLC/i];
    expect(lacksCpdlc('Some NoCpdlc 200', list)).toBe(true);
    expect(atcHints({ ...base, aircraftTitle: 'Some NoCpdlc 200', noCpdlc: list })).toEqual([
      { key: 'atc.noCpdlc', params: {} },
      { key: 'atc.hintDcl', params: { dcl: 'XFHK' } },
    ]);
  });

  it('an unknown aircraft gets no such hint, and no aircraft is listed so far', () => {
    expect(lacksCpdlc('Unknown Plane', [/NOCPDLC/i])).toBe(false);
    expect(lacksCpdlc(undefined, [/NOCPDLC/i])).toBe(false);
    expect(NO_CPDLC_AIRCRAFT).toEqual([]);
    expect(lacksCpdlc('FenixA320_DLH')).toBe(false);
  });

  it('on block: the FLT NBR reminder, only there', () => {
    const on = atcHints({ ...base, phase: 'ON_BLOCK', atc: null });
    expect(on).toEqual([{ key: 'atc.fltNbr', params: { callsign: 'FIN4E' } }]);
    expect(atcHints({ ...base, phase: 'CRUISE', atc: null })).toEqual([]);
  });
});
