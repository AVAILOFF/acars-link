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
    case 'out': {
      const m = e.message;
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
        case 'SCENARIO_STARTED':
          return o.verbose === true ? ['SCENARIO', `${ev.id} started`] : null;
        case 'SCENARIO_DONE':
          return o.verbose === true ? ['SCENARIO', `${ev.id} done`] : null;
        case 'SCENARIO_ERROR':
          return ['SCENARIO', `${ev.id} ERROR: ${ev.error}`];
        case 'SCENARIO_SKIPPED':
          return o.verbose === true ? ['SCENARIO', `${ev.id} skipped (${ev.reason})`] : null;
        case 'ALT_CHANGE':
          return o.verbose === true ? ['ALT', `${ev.fromFt} → ${ev.toFt} ft`] : null;
        case 'SIM_PAUSED':
          return o.verbose === true ? ['SIM', 'paused'] : null;
        case 'SIM_RESUMED':
          return o.verbose === true ? ['SIM', 'resumed'] : null;
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
    if (e.kind === 'out' && o.brief !== true) {
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
