import { afterEach, describe, expect, it, vi } from 'vitest';
import { MESSAGES, systemText, translator } from '../src/renderer/src/i18n.js';
import type { Language, SystemCode } from '../src/shared/api.js';

/** Params exactly as `session.ts` / `controller.ts` send them; the Record keeps this exhaustive. */
const SENT: Readonly<Record<SystemCode, Readonly<Record<string, string>>>> = {
  flight_started: { callsign: 'FIN4E', transport: 'mock' },
  flight_stopped: { phase: 'CRUISE' },
  late_start: { min: '5' },
  recording: { file: 'x.jsonl' },
  recording_failed: { error: 'disk full' },
  phase: { from: 'CLIMB', to: 'CRUISE' },
  oooi: { kind: 'OUT' },
  telemetry_lost: {},
  telemetry_restored: { gapSec: '12' },
  discontinuity: { nm: '3.4' },
  scenario_error: { id: 's', error: 'e' },
  reply_timeout: { id: 's', option: 'A' },
  data_failed: { source: 'metar', error: 'e' },
  memory: { names: 'a, b' },
  forced_started: { id: 's', detail: '' },
  forced_conditions: { id: 's', detail: 'c' },
  forced_running: { id: 's', detail: '' },
  forced_unknown: { id: 's', detail: '' },
  data_restored: { source: 'metar' },
  transport_status: { status: 'ok', reason: '' },
  sim_command_failed: { command: 'x', error: 'e', detail: 'd' },
  atc_station: { fir: 'EFIN', station: 'XFIN', unit: 'Helsinki' },
  atc_logon: { station: 'XFIN' },
  atc_logon_refused: { station: 'XFIN', reason: 'r' },
  atc_logon_wrong: { station: 'XFHK', expected: 'XFIN' },
  // Station callsigns in `from`/`to`: the crash of the 2026-10-10 test flight.
  atc_handover: { from: 'XFIN', to: 'XENM' },
  atc_logoff: { station: 'XFIN', by: 'station' },
  atc_live: { fir: 'EFIN', callsign: 'EFIN_CTR', frequency: '124.000' },
  atc_unsupported: { station: 'XFIN', text: 't' },
  atc_emergency: { station: 'XFIN', kind: 'MAYDAY' },
  atc_level_check: { station: 'XFIN', level: '39000', why: 'departed' },
  atc_misrouted_pdc: { station: 'XFIN', target: 'XFHK' },
  atc_misrouted_pdc_closed: { station: 'XFIN', target: '' },
  atc_misrouted_logon: { station: 'XFHK', target: 'XFIN' },
  atc_misrouted_logon_fir: { station: 'XFHK', target: '' },
  atc_misrouted_fir: { station: 'XFIN', target: '' },
  atc_misrouted_dcl: { station: 'XFHK', target: '' },
  flt_nbr_hint: { callsign: 'FIN4E' },
  atc_request: { station: 'XFIN', request: 'r', reply: 'p' },
  atc_auto: { station: 'XFIN', text: 't' },
  atc_needs_data: {},
  link_needs_data: {},
  atc_dcl_request: { station: 'XEFHK' },
  atc_dcl_clearance: { station: 'XEFHK', squawk: '1234', source: 's' },
  atc_dcl_confirmed: { station: 'XEFHK' },
  atc_dcl_unable: { station: 'XEFHK' },
  atc_dcl_rejected: { station: 'XEFHK', reason: 'r', detail: '' },
  atc_ocl_received: { station: 'XEGGX', oca: 'EGGX', detail: '' },
  atc_ocl_not_required: { station: 'XEGGX', oca: 'EGGX', detail: '' },
  atc_ocl_rejected: { station: 'XEGGX', oca: 'EGGX', detail: 'd' },
  atc_ocl_clearance: { station: 'XEGGX', oca: 'EGGX', detail: 'd' },
  atc_ocl_confirmed: { station: 'XEGGX', oca: 'EGGX', detail: '' },
  atc_ocl_cancelled: { station: 'XEGGX', oca: 'EGGX', detail: '' },
};

afterEach(() => vi.restoreAllMocks());

describe('system feed text', () => {
  for (const lang of ['en', 'ru'] as const satisfies readonly Language[]) {
    it(`renders every SystemCode with the params the main process sends (${lang})`, () => {
      const t = translator(lang);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      for (const code of Object.keys(SENT) as SystemCode[]) {
        const text = systemText(t, code, SENT[code]);
        expect(text, code).not.toBe('');
        expect(text, code).not.toMatch(/\{\w+\}/);
      }
      expect(error).not.toHaveBeenCalled();
    });
  }

  it('shows station callsigns of a handover as they are, not as flight phases', () => {
    expect(systemText(translator('en'), 'atc_handover', { from: 'XFIN', to: 'XENM' })).toBe(
      'ROPS: handover XFIN → XENM',
    );
    expect(systemText(translator('ru'), 'atc_handover', { from: 'XFIN', to: 'XENM' })).toBe(
      'ROPS: передача XFIN → XENM',
    );
  });

  it('translates flight phases of the phase and flight_stopped entries', () => {
    const t = translator('en');
    expect(systemText(t, 'phase', { from: 'CLIMB', to: 'CRUISE' })).toBe(
      `Phase: ${MESSAGES.en['phase.CRUISE']}`,
    );
    expect(systemText(t, 'flight_stopped', { phase: 'DESCENT' })).toBe(
      `Flight stopped in phase ${MESSAGES.en['phase.DESCENT']}`,
    );
  });
});

describe('translator', () => {
  it('returns an unknown key as text and logs it instead of throwing', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const t = translator('en');
    // biome-ignore lint/suspicious/noExplicitAny: the point is a key outside MessageKey
    expect(t('phase.XFIN' as any)).toBe('phase.XFIN');
    expect(error).toHaveBeenCalledOnce();
  });
});
