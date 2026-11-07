// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { ReplayResult, TimelineEntry } from './run.js';

/** Human-readable timeline of a replay, one event per line, telex bodies indented. */

export interface ReportOptions {
  /** Leave out telex bodies. */
  readonly brief?: boolean;
  /** Also list scenario start/done/skip, sim pause/resume and step climbs. */
  readonly verbose?: boolean;
}

const hhmmss = (t: number) => new Date(t).toISOString().slice(11, 19);

function elapsed(ms: number): string {
  const sign = ms < 0 ? '-' : '+';
  const s = Math.floor(Math.abs(ms) / 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${sign}${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}

function describe(e: TimelineEntry, o: ReportOptions): [string, string] | null {
  switch (e.kind) {
    case 'late_start':
      return ['DELAY', `late start: flight delayed ${e.delayMin} min`];
    case 'error':
      return ['ERROR', e.error];
    case 'resume':
      return ['RESUME', 'the app restored the flight after a restart'];
    case 'cmd':
      return [
        'SIM',
        `${e.command.scenarioId}  ${e.command.command}${
          e.command.command === 'vdgs' && e.command.vdgs === null ? ' stop' : ''
        }`,
      ];
    case 'out': {
      const m = e.message;
      if (m.kind === 'cpdlc') return ['CPDLC', `${m.from} → ${m.to}  ${m.message.lines.join(' ')}`];
      return ['TELEX', `${m.scenarioId}  ${m.from} → ${m.to}  (${m.message.lines.length} lines)`];
    }
    case 'event': {
      const ev = e.event;
      switch (ev.type) {
        case 'PHASE_CHANGE':
          return ['PHASE', `${ev.from} → ${ev.to}`];
        case 'OOOI_OUT':
        case 'OOOI_OFF':
        case 'OOOI_ON':
        case 'OOOI_IN':
          return ['OOOI', `${ev.type.slice(5)} at ${hhmmss(ev.t)}Z`];
        case 'TELEMETRY_LOST':
          return ['TELEMETRY', `lost (last sample ${hhmmss(ev.lastT)}Z)`];
        case 'TELEMETRY_RESTORED':
          return ['TELEMETRY', `restored after ${Math.round(ev.gapMs / 1000)} s`];
        case 'DISCONTINUITY':
          return ['JUMP', `position jumped ${ev.jumpNm.toFixed(1)} nm`];
        case 'PILOT_MESSAGE': {
          const to =
            ev.result === 'reply'
              ? `reply to ${ev.scenarioId}`
              : ev.result === 'command'
                ? `command ${ev.command}`
                : ev.detail === null
                  ? ev.result
                  : `${ev.result}: ${ev.detail}`;
          return ['PILOT', `"${ev.text}" → ${to}`];
        }
        case 'REPLY_EXPECTED':
          return [
            'PILOT',
            `${ev.id} waits for ${ev.options.join('/')} (${Math.round(ev.timeoutMs / 60_000)} min)`,
          ];
        case 'REPLY_TIMEOUT':
          return ['PILOT', `${ev.id}: no answer, takes ${ev.option}`];
        case 'GROUND':
          return [
            'GSX',
            ev.event === 'GSX_BOARDING_DONE' ? 'boarding completed' : 'refuelling completed',
          ];
        case 'PREDEP_FLUSH':
          return ['FLUSH', `pushback: pre-departure ${ev.ids.join(', ')} sent now`];
        case 'WAIT_UNTIL':
          return ['PILOT', `${ev.id}: wait until ${ev.result}`];
        case 'SET':
          return [
            'SET',
            `${ev.id}: ${ev.name} = ${JSON.stringify(ev.value)}${ev.applied ? '' : ' (not applied)'}`,
          ];
        case 'FLIGHT_KIND':
          return [
            'KIND',
            `${ev.override ?? 'auto'} -> ${ev.kind}${ev.applied ? '' : ' (not applied: fixed after OUT)'}`,
          ];
        case 'FORCED':
          return ['FORCED', `${ev.id}: ${ev.result}${ev.detail === null ? '' : ` (${ev.detail})`}`];
        case 'DATA_REQUEST':
          return ['DATA', `core asks for ${ev.kind} ${ev.icao}`];
        case 'SCENARIO_STARTED':
          return o.verbose === true ? ['SCENARIO', `${ev.id} started`] : null;
        case 'SCENARIO_DONE':
          return o.verbose === true ? ['SCENARIO', `${ev.id} done`] : null;
        case 'SCENARIO_ERROR':
          return ['SCENARIO', `${ev.id} ERROR: ${ev.error}`];
        case 'RESCUE_NO_AIRPORT':
          return ['SIM', `${ev.id}  rescue: no airport of the flight within 5 NM`];
        case 'SCENARIO_SKIPPED':
          return o.verbose === true ? ['SCENARIO', `${ev.id} skipped (${ev.reason})`] : null;
        case 'ALT_CHANGE':
          return o.verbose === true ? ['ALT', `${ev.fromFt} → ${ev.toFt} ft`] : null;
        case 'SIM_PAUSED':
          return o.verbose === true ? ['SIM', 'paused'] : null;
        case 'SIM_RESUMED':
          return o.verbose === true ? ['SIM', 'resumed'] : null;
        case 'ATC_STATION':
          return ['ATC', `${ev.fir}: log on to ${ev.station} (${ev.unit})`];
        case 'ATC_LOGON':
          return [
            'ATC',
            `logon to ${ev.station} ${ev.accepted ? 'accepted' : `refused (${ev.reason})`}`,
          ];
        case 'ATC_HANDOVER':
          return ['ATC', `handover ${ev.from} → ${ev.to}`];
        case 'ATC_LOGOFF':
          return ['ATC', `logoff ${ev.station} by ${ev.by}`];
        case 'ATC_LIVE':
          return ['ATC', `${ev.fir}: live ${ev.callsign} ${ev.frequency}, station steps aside`];
        case 'ATC_REQUEST':
          return [
            'ATC',
            `${ev.station}: "${ev.request}" -> ${ev.reply}${ev.why === null ? '' : ` (${ev.why})`}`,
          ];
        case 'ATC_AUTO':
          return ['ATC', `${ev.station}: ${ev.kind} ${ev.text}`];
        case 'ATC_UNSUPPORTED':
          return ['ATC', `${ev.station}: not supported "${ev.text}"`];
        case 'ATC_EMERGENCY':
          return ['ATC', `${ev.station}: ${ev.kind} received, airline chain starts`];
        case 'ATC_LEVEL_CHECK':
          return ['ATC', `${ev.station}: confirm assigned level ${ev.levelFt} ft (${ev.why})`];
        case 'ATC_MISROUTED':
          return [
            'ATC',
            `${ev.station}: ${ev.packet} not taken (${ev.what})${ev.target === null ? '' : `, send to ${ev.target}`}`,
          ];
        case 'ATC_DCL':
          return ['DCL', `${ev.station}: ${ev.what}`];
        case 'ATC_DCL_CLEARANCE':
          return ['DCL', `${ev.station}: ${ev.format} squawk ${ev.squawk} (${ev.squawkSource})`];
        case 'ATC_DCL_REJECTED':
          return [
            'DCL',
            `${ev.station}: rejected (${ev.reason}${ev.detail === null ? '' : ` ${ev.detail}`})`,
          ];
        case 'ATC_OCL':
          return [
            'OCL',
            `${ev.station} (${ev.oca}): ${ev.what}${ev.detail === null ? '' : ` ${ev.detail}`}`,
          ];
      }
    }
  }
}

export function formatReport(r: ReplayResult, o: ReportOptions = {}): string {
  const t0 = r.firstNow ?? 0;
  const lines: string[] = [];
  for (const e of r.timeline) {
    const d = describe(e, o);
    if (d === null) continue;
    lines.push(`${hhmmss(e.now)}Z ${elapsed(e.now - t0)}  ${d[0].padEnd(9)}  ${d[1]}`);
    if (e.kind === 'out' && e.message.kind === 'telex' && o.brief !== true) {
      for (const l of e.message.message.lines) lines.push(`${' '.repeat(22)}| ${l}`);
    }
  }
  const span = r.firstNow === null || r.lastNow === null ? 0 : r.lastNow - r.firstNow;
  lines.push(
    '',
    `${r.ticks} ticks over ${elapsed(span).slice(1)}, final phase ${r.finalPhase}, ` +
      `${r.outbound.length} telexes` +
      (r.recorded.length > 0 ? ` (live: ${r.recorded.length})` : ''),
  );
  return `${lines.join('\n')}\n`;
}
