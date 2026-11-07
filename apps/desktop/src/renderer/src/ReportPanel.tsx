// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { FdmEvent, FlightReport, OooiKind, PlanFigure } from '@acars/core';
import type { FlightReportView } from '../../shared/api.js';
import { useStore } from './store.js';
import { num, useT, useUiText, zulu } from './ui.js';

/**
 * The flight report after ON_BLOCK (T69): actual against the OFP, numbers only (no grades, decision
 * of 2026-10-30). Stays until the next OFP is loaded; the logbook keeps it.
 */

const OOOI: readonly OooiKind[] = ['OUT', 'OFF', 'ON', 'IN'];

/** `2:44`, hours and minutes of a duration. */
function hmm(ms: number): string {
  const min = Math.round(Math.abs(ms) / 60_000);
  return `${ms < 0 ? '-' : ''}${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
}

const signed = (n: number) => (n > 0 ? `+${num(n)}` : n < 0 ? `−${num(-n)}` : '0');

export function ReportPanel({ view }: { view: FlightReportView }) {
  const t = useT();
  const text = useUiText();
  const busy = useStore((s) => s.busy);
  const saved = useStore((s) => s.saved === 'report');
  const { exportReport } = useStore.getState();
  const r = view.report;
  const min = (ms: number) => t('report.min', { n: signed(Math.round(ms / 60_000)) });
  const kg = (n: number) => signed(n);

  return (
    <section className="panel report" aria-labelledby="report-title">
      <div className="panel-head">
        <h2 id="report-title" className="panel-title">
          {t('report.title')}
        </h2>
        <span className="panel-sub">
          {r.callsign} · {r.origin}–{r.destination}
        </span>
      </div>

      <table className="report-table">
        <thead>
          <tr>
            <th scope="col" className="report-caps">
              {t('report.times')}
            </th>
            <th scope="col" className="report-caps">
              {t('report.actual')}
            </th>
            <th scope="col" className="report-caps">
              {t('report.plan')}
            </th>
            <th scope="col" className="report-caps">
              {t('report.diff')}
            </th>
          </tr>
        </thead>
        <tbody>
          {OOOI.map((k) => (
            <Line key={k} label={k} f={r.times[k]} show={zulu} diff={min} />
          ))}
          <Line label={t('report.block')} f={r.blockMs} show={hmm} diff={min} />
          <Line label={t('report.air')} f={r.airMs} show={hmm} diff={min} />
        </tbody>
        <tbody>
          <tr>
            <th scope="colgroup" colSpan={4} className="report-caps">
              {t('report.fuel')}
            </th>
          </tr>
          {OOOI.map((k) => (
            <Line key={k} label={k} f={r.fuelKg[k]} show={num} diff={kg} />
          ))}
          <tr>
            <th scope="colgroup" colSpan={4} className="report-caps">
              {t('report.burn')}
            </th>
          </tr>
          <Line label={t('report.burnTaxiOut')} f={r.burnKg.taxiOut} show={num} diff={kg} />
          <Line label={t('report.burnTrip')} f={r.burnKg.trip} show={num} diff={kg} />
          <Line label={t('report.burnTaxiIn')} f={r.burnKg.taxiIn} show={num} diff={kg} />
          <Line label={t('report.burnBlock')} f={r.burnKg.block} show={num} diff={kg} />
        </tbody>
      </table>

      <dl className="report-facts">
        <dt>{t('report.touchdown')}</dt>
        <dd>
          {r.touchdownFpm === null
            ? t('report.noData')
            : t('report.fpm', { fpm: num(r.touchdownFpm) })}
        </dd>
        <dt>{t('report.landed')}</dt>
        <dd>{landed(r, t)}</dd>
        {r.flightKind !== undefined && (
          <>
            <dt>{t('report.kind')}</dt>
            <dd>{t(`kind.${r.flightKind}`)}</dd>
          </>
        )}
        {r.divert !== null && (
          <>
            <dt>{t('report.divertSet')}</dt>
            <dd>{r.divert}</dd>
          </>
        )}
        <dt>{t('report.goArounds')}</dt>
        <dd>{r.goArounds}</dd>
        <dt>{t('report.delay')}</dt>
        <dd>
          {t('report.min', { n: String(r.delay.min) })}
          {r.delay.parts.length > 0 &&
            ` (${r.delay.parts.map((p) => `${p.code}: ${p.min}`).join(', ')})`}
        </dd>
        <dt>{t('report.messages')}</dt>
        <dd>
          {t('report.messagesValue', {
            airline: String(r.messages.airline),
            pilot: String(r.messages.pilot),
            replies: String(r.messages.replies),
          })}
        </dd>
        <dt>{t('report.irregular')}</dt>
        <dd>
          {view.irregular.length === 0 ? '—' : view.irregular.map((s) => text(s.title)).join(', ')}
        </dd>
        {r.fdm !== undefined && (
          <>
            <dt>{t('report.fdm')}</dt>
            <dd>
              {r.fdm.length === 0 ? (
                t('report.fdmNone')
              ) : (
                <ol className="report-fdm">
                  {r.fdm.map((e) => (
                    <li key={`${e.kind}-${e.t}`}>{fdmLine(e, t)}</li>
                  ))}
                </ol>
              )}
            </dd>
          </>
        )}
      </dl>

      <p className="hint">{t('report.hint')}</p>
      <div className="row actions">
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={() => void exportReport()}
        >
          {t('report.export')}
        </button>
        {saved && (
          <span className="saved" role="status">
            ✓ {t('report.saved')}
          </span>
        )}
      </div>
    </section>
  );
}

function Line({
  label,
  f,
  show,
  diff,
}: {
  label: string;
  f: PlanFigure;
  show: (n: number) => string;
  diff: (n: number) => string;
}) {
  return (
    <tr>
      <th scope="row" className="report-label">
        {label}
      </th>
      <td>{f.actual === null ? '—' : show(f.actual)}</td>
      <td>{f.plan === null ? '—' : show(f.plan)}</td>
      <td>{f.diff === null ? '' : diff(f.diff)}</td>
    </tr>
  );
}

/** One FDM event (T94): value, height, UTC time; facts only. */
function fdmLine(e: FdmEvent, t: ReturnType<typeof useT>): string {
  return t(`report.fdm.${e.kind}`, {
    value: e.value === null ? '' : num(e.value),
    alt: num(e.altFt),
    ldg: String(e.landingFlaps ?? ''),
    time: zulu(e.t),
  });
}

function landed(r: FlightReport, t: ReturnType<typeof useT>): string {
  const l = r.landed;
  if (l === null) return t('report.noData');
  if (l.icao === null) {
    return t('report.unknownApt', { lat: l.lat.toFixed(4), lon: l.lon.toFixed(4) });
  }
  return l.diverted ? t('report.diverted', { icao: l.icao, dest: r.destination }) : l.icao;
}
