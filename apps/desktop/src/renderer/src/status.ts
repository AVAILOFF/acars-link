// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { AppState, LinkWindow } from '../../shared/api.js';
import type { Translate } from './i18n.js';
import { zulu } from './ui.js';

/** Tone of a link state: the colour of its word (top bar) or dot (status bar). */
export type Tone = 'ok' | 'warn' | 'bad' | 'off';

export interface StatusItem {
  readonly tone: Tone;
  /** Short value for the top bar. */
  readonly short: string;
  /** Full value with details for the status bar. */
  readonly text: string;
}

export function bridgeStatus(app: AppState, t: Translate): StatusItem {
  const b = app.bridge;
  // T75: why the bridge the app started is not there. A bridge that answers (one started by hand,
  // without our token) wins: then everything works and there is nothing to explain.
  const p = app.bridgeProcess;
  if (p !== null && b.link !== 'open') {
    if (p.kind === 'restarting') {
      const short = t('bridge.restarting');
      return { tone: 'warn', short, text: t('bridge.restartingText', { n: p.attempt }) };
    }
    if (p.kind === 'port_in_use') {
      return {
        tone: 'bad',
        short: t('bridge.portBusy'),
        text: t('bridge.portBusyText', { port: p.port }),
      };
    }
    const lines = p.lastLines.replaceAll('\n', ' · ');
    return {
      tone: 'bad',
      short: t('bridge.failed'),
      text: t('bridge.failedText') + (lines === '' ? '' : `. ${t('bridge.lastLines')}: ${lines}`),
    };
  }
  const tone: Tone = b.link === 'open' ? 'ok' : b.link === 'connecting' ? 'warn' : 'bad';
  const short = t(`bridge.${b.link}`);
  return { tone, short, text: short + (b.detail === null ? '' : ` — ${b.detail}`) };
}

export function simStatus(app: AppState, t: Translate): StatusItem {
  const b = app.bridge;
  // U-19: a word, not a dash: without the bridge nothing is known about the sim.
  if (b.link !== 'open' || b.sim === null) {
    const none = t('sim.noBridge');
    return { tone: 'off', short: none, text: none };
  }
  const tone: Tone = b.sim === 'connected' ? (b.running ? 'ok' : 'warn') : 'bad';
  let short = b.sim === 'connected' && !b.running ? t('sim.menu') : t(`sim.${b.sim}`);
  // T59: which simulator the bridge found.
  if (b.source !== null) short += ` · ${t(`sim.name.${b.source}`)}`;
  let text = short;
  if (b.paused) text += ` · ${t('sim.paused')}`;
  if (b.simRate !== 1) text += ` · ${t('sim.rate', { rate: b.simRate })}`;
  return { tone, short: b.paused ? t('sim.paused') : short, text };
}

export function netStatus(app: AppState, t: Translate): StatusItem {
  const tr = app.transport;
  if (tr === null) return { tone: 'off', short: t('net.none'), text: t('net.none') };
  const tone: Tone =
    tr.kind === 'mock'
      ? 'ok'
      : tr.status === 'halted'
        ? 'bad'
        : tr.status === 'degraded'
          ? 'warn'
          : 'ok';
  const short = tr.kind === 'mock' ? t('net.mock') : t(`net.${tr.status}`);
  let text = short;
  if (tr.reason !== null) text += ` — ${tr.reason}`;
  if (tr.pending > 0) text += ` · ${t('net.pending', { n: tr.pending })}`;
  if (tr.outbox > 0) text += ` · ${t('net.outbox', { n: tr.outbox })}`;
  return { tone, short, text };
}

/** XATC station (CPDLC); null when the station is off. */
export function atcStatus(app: AppState, t: Translate): StatusItem | null {
  const atc = app.atc;
  if (atc === null) return null;
  const tone: Tone = atc.connected !== null ? 'ok' : atc.station !== null ? 'warn' : 'off';
  const short =
    atc.connected ??
    (atc.station !== null ? t('atc.logon', { station: atc.station }) : t('atc.wait'));
  const text =
    (atc.connected !== null
      ? t('atc.connected', { station: atc.connected })
      : atc.station !== null
        ? t('atc.logon', { station: atc.station })
        : t('atc.wait')) + (atc.dcl === null ? '' : ` · ${t('atc.dcl', { station: atc.dcl })}`);
  return { tone, short, text };
}

/** Data link window (VHF / SATCOM); null when the simulation is off. */
export function linkStatus(app: AppState, t: Translate): StatusItem | null {
  const link = app.link;
  if (link === null) return null;
  const tone: Tone = link.kind === null ? 'warn' : 'ok';
  const text = linkLine(link, t);
  return { tone, short: text.split(' · ')[0] ?? text, text };
}

/** One line of the link window: the link, the AES/GES header, what waits, the last delivery. */
function linkLine(link: LinkWindow, t: Translate): string {
  const now =
    link.kind === 'vhf'
      ? t('link.vhf', { station: link.station ?? '', nm: link.distNm ?? 0 })
      : link.kind === 'satcom'
        ? t('link.satcom', { station: link.station ?? '', el: link.elevDeg ?? 0 })
        : t('link.none');
  const parts = [now];
  if (link.header !== null) parts.push(link.header);
  if (link.held > 0) parts.push(t('link.held', { n: link.held }));
  if (link.inFlight > 0) parts.push(t('link.inflight', { n: link.inFlight }));
  if (link.last !== null) {
    parts.push(
      t('link.last', {
        time: zulu(link.last.t),
        sec: Math.round(link.last.delayMs / 1000),
      }),
    );
  }
  return parts.join(' · ');
}
