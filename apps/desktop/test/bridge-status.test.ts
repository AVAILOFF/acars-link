// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { describe, expect, it } from 'vitest';
import { translator } from '../src/renderer/src/i18n.js';
import { bridgeStatus } from '../src/renderer/src/status.js';
import type { AppState, BridgeProcessView, BridgeView } from '../src/shared/api.js';

/** T75: what the status line says when the bridge the app started is not there. */

const view = (link: BridgeView['link']): BridgeView => ({
  link,
  sim: null,
  running: false,
  paused: false,
  simRate: 1,
  detail: link === 'closed' ? 'ECONNREFUSED' : null,
  retryAt: null,
  protocol: null,
  commands: [],
  source: null,
  version: null,
});

const app = (link: BridgeView['link'], bridgeProcess: BridgeProcessView | null) =>
  ({ bridge: view(link), bridgeProcess }) as AppState;

describe('bridgeStatus (T75)', () => {
  const en = translator('en');
  const ru = translator('ru');

  it('port taken and no bridge answering: names the port and the way out, in both languages', () => {
    const state = app('closed', { kind: 'port_in_use', port: 47830 });
    expect(bridgeStatus(state, en)).toMatchObject({ tone: 'bad', short: 'port busy' });
    expect(bridgeStatus(state, en).text).toContain('Port 47830 is used by another program');
    expect(bridgeStatus(state, ru).text).toBe(
      'Порт 47830 занят другой программой: закройте другой мост или смените порт в настройках',
    );
  });

  it('a bridge that answers is fine, whatever the process said (one started by hand)', () => {
    expect(bridgeStatus(app('open', { kind: 'port_in_use', port: 47830 }), en)).toMatchObject({
      tone: 'ok',
      short: 'connected',
    });
  });

  it('restarting is a warning, giving up is an error with the last lines of the log', () => {
    expect(bridgeStatus(app('closed', { kind: 'restarting', attempt: 2 }), en)).toMatchObject({
      tone: 'warn',
      short: 'restarting…',
    });
    const failed = bridgeStatus(app('closed', { kind: 'failed', lastLines: 'a\nb' }), en);
    expect(failed.tone).toBe('bad');
    expect(failed.text).toContain('does not start');
    expect(failed.text).toContain('Last lines of its log: a · b');
    expect(bridgeStatus(app('closed', { kind: 'failed', lastLines: '' }), en).text).not.toContain(
      'Last lines',
    );
  });

  it('nothing to report: the plain link state, as before', () => {
    expect(bridgeStatus(app('closed', null), en)).toEqual({
      tone: 'bad',
      short: 'not running',
      text: 'not running — ECONNREFUSED',
    });
  });
});
