import { FLIGHT_PHASES, type FlightPhase } from '@acars/core';
import { type FormEvent, useState } from 'react';
import type { AppState, FlightSummary } from '../../shared/api.js';
import { FeedList } from './FeedList.js';
import { phaseKey } from './i18n.js';
import { useStore } from './store.js';
import { num, useT, useUiText, zulu } from './ui.js';

/** The normal sequence shown as a strip; GO_AROUND and the end states only as the label. */
const STRIP: readonly FlightPhase[] = FLIGHT_PHASES.filter(
  (p) => p !== 'GO_AROUND' && p !== 'TURNAROUND' && p !== 'DONE',
);

export function FlightView() {
  const app = useStore((s) => s.app) as AppState;
  return (
    <div className="flight-layout">
      <div className="side">
        <FlightCard app={app} />
        <StatusCard app={app} />
      </div>
      <section className="panel feed-panel" aria-labelledby="feed-title">
        {app.session === 'running' && <PilotForm />}
        {app.session === 'running' && app.irregular.length > 0 && (
          <ForceForm list={app.irregular} />
        )}
        <FeedList entries={app.feed} />
      </section>
    </div>
  );
}

function FlightCard({ app }: { app: AppState }) {
  const t = useT();
  const busy = useStore((s) => s.busy);
  const creds = useStore((s) => s.creds);
  const settings = useStore((s) => s.settings);
  const { loadOfp, startFlight, stopFlight, endFlight } = useStore.getState();
  const running = app.session === 'running';
  const f = app.flight;
  const offline = settings?.transport === 'offline';
  const needCode = !offline && creds?.hoppieCodeSet === false;

  return (
    <section className="panel" aria-labelledby="flight-title">
      <h2 id="flight-title" className="panel-title">
        {t('flight.title')}
      </h2>
      {f === null ? <p className="muted">{t('flight.none')}</p> : <Summary f={f} />}
      {creds?.simbriefUsername === '' && <p className="hint warn">{t('flight.needUsername')}</p>}
      {f !== null && !running && needCode && <p className="hint warn">{t('flight.needCode')}</p>}
      {f !== null && (running || !needCode) && (
        <p className="hint">
          {offline
            ? t('flight.offlineHint')
            : t('flight.fmsHint', { callsign: f.callsign, station: f.station })}
        </p>
      )}

      {running && app.phase === 'ON_BLOCK' && (
        <div className="end-flight">
          <p className="hint">{t('flight.endHint')}</p>
          <div className="row">
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() => void endFlight('TURNAROUND')}
            >
              {t('flight.turnaround')}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() => void endFlight('DONE')}
            >
              {t('flight.done')}
            </button>
          </div>
        </div>
      )}

      <div className="row actions">
        {running ? (
          <button
            type="button"
            className="btn danger"
            disabled={busy !== null}
            onClick={() => {
              if (window.confirm(t('flight.stopConfirm'))) void stopFlight();
            }}
          >
            {t('flight.stop')}
          </button>
        ) : (
          <>
            <button
              type="button"
              className={f === null ? 'btn primary' : 'btn'}
              disabled={busy !== null || creds?.simbriefUsername === ''}
              onClick={() => void loadOfp()}
            >
              {busy === 'load' ? '…' : t(f === null ? 'flight.load' : 'flight.reload')}
            </button>
            {f !== null && (
              <button
                type="button"
                className="btn primary"
                disabled={busy !== null || needCode}
                onClick={() => void startFlight()}
              >
                {t('flight.start')}
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** T12: a pilot telex typed in the app (aircraft without free-text telex, tests). */
/** "Run now" for an irregular scenario of the running flight; the result goes to the feed. */
function ForceForm({ list }: { list: AppState['irregular'] }) {
  const t = useT();
  const busy = useStore((s) => s.busy);
  const text = useUiText();
  const [id, setId] = useState(list[0]?.id ?? '');
  const current = list.some((x) => x.id === id) ? id : (list[0]?.id ?? '');
  return (
    <form
      className="pilot-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (current !== '') void useStore.getState().forceScenario(current);
      }}
    >
      <label htmlFor="force-id" className="small muted">
        {t('force.label')}
      </label>
      <div className="row">
        <select id="force-id" value={current} onChange={(e) => setId(e.currentTarget.value)}>
          {list.map((s) => (
            <option key={s.id} value={s.id}>
              {text(s.title)}
            </option>
          ))}
        </select>
        <button type="submit" className="btn" disabled={busy !== null || current === ''}>
          {t('force.run')}
        </button>
      </div>
      <p className="hint small">{t('force.hint')}</p>
    </form>
  );
}

function PilotForm() {
  const t = useT();
  const busy = useStore((s) => s.busy);
  const [text, setText] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (text.trim() === '') return;
    if (await useStore.getState().sendPilotMessage(text)) setText('');
  };
  return (
    <form className="pilot-form" onSubmit={(e) => void submit(e)}>
      <label htmlFor="pilot-text" className="small muted">
        {t('pilot.label')}
      </label>
      <div className="row">
        <input
          id="pilot-text"
          type="text"
          className="mono"
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
          placeholder={t('pilot.placeholder')}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="btn" disabled={busy !== null || text.trim() === ''}>
          {t('pilot.send')}
        </button>
      </div>
      <p className="hint small">{t('pilot.hint')}</p>
    </form>
  );
}

function Summary({ f }: { f: FlightSummary }) {
  const t = useT();
  return (
    <>
      <div className="callsign">
        {f.callsign}
        <span className="route">
          {f.origin} → {f.destination}
        </span>
      </div>
      <dl className="facts">
        <dt>{t('flight.aircraft')}</dt>
        <dd>
          {f.aircraftIcao}
          {f.aircraftReg === null ? '' : ` · ${f.aircraftReg}`}
        </dd>
        <dt>{t('flight.sched')}</dt>
        <dd className="mono">
          {zulu(f.schedOutMs)} / {zulu(f.schedInMs)}
        </dd>
        <dt>{t('flight.station')}</dt>
        <dd className="mono">{f.station}</dd>
        <dt>{t('flight.profile')}</dt>
        <dd>{t('flight.profileValue', { id: f.profileId, width: f.lineWidth })}</dd>
      </dl>
    </>
  );
}

type Tone = 'ok' | 'warn' | 'bad' | 'off';

function StatusCard({ app }: { app: AppState }) {
  const t = useT();
  const b = app.bridge;
  const bridgeTone: Tone = b.link === 'open' ? 'ok' : b.link === 'connecting' ? 'warn' : 'bad';
  const bridgeText = t(`bridge.${b.link}`) + (b.detail === null ? '' : ` — ${b.detail}`);

  let simTone: Tone = 'off';
  let simText = '—';
  if (b.link === 'open' && b.sim !== null) {
    simTone = b.sim === 'connected' ? (b.running ? 'ok' : 'warn') : 'bad';
    simText = t(`sim.${b.sim}`);
    if (b.sim === 'connected' && !b.running) simText = t('sim.menu');
    if (b.paused) simText += ` · ${t('sim.paused')}`;
    if (b.simRate !== 1) simText += ` · ${t('sim.rate', { rate: b.simRate })}`;
  }

  const tr = app.transport;
  let netTone: Tone = 'off';
  let netText = t('net.none');
  if (tr !== null) {
    netTone =
      tr.kind === 'mock'
        ? 'ok'
        : tr.status === 'halted'
          ? 'bad'
          : tr.status === 'degraded'
            ? 'warn'
            : 'ok';
    netText = tr.kind === 'mock' ? t('net.mock') : t(`net.${tr.status}`);
    if (tr.reason !== null) netText += ` — ${tr.reason}`;
    if (tr.pending > 0) netText += ` · ${t('net.pending', { n: tr.pending })}`;
  }

  const tm = app.telemetry;
  return (
    <section className="panel" aria-labelledby="status-title">
      <h2 id="status-title" className="panel-title">
        {t('status.title')}
      </h2>
      <PhaseStrip phase={app.phase} />
      <ul className="status-list">
        <StatusRow label={t('status.bridge')} tone={bridgeTone} text={bridgeText} />
        <StatusRow label={t('status.sim')} tone={simTone} text={simText} />
        <StatusRow label={t('status.network')} tone={netTone} text={netText} />
      </ul>
      {app.session === 'running' && (
        <p className="telemetry mono">
          {tm === null
            ? t('tm.none')
            : `${tm.aircraftTitle}\n${tm.onGround ? `${t('tm.ground')} · ` : ''}${t('tm.line', {
                alt: num(tm.altFt),
                gs: num(tm.gsKt),
                vs: num(tm.vsFpm),
                fuel: num(tm.fuelKg),
              })}`}
        </p>
      )}
    </section>
  );
}

function StatusRow({ label, tone, text }: { label: string; tone: Tone; text: string }) {
  return (
    <li>
      <span className={`dot ${tone}`} aria-hidden="true" />
      <span className="status-label">{label}</span>
      <span className="status-text">{text}</span>
    </li>
  );
}

function PhaseStrip({ phase }: { phase: FlightPhase | null }) {
  const t = useT();
  const index = phase === null ? -1 : STRIP.indexOf(phase === 'GO_AROUND' ? 'APPROACH' : phase);
  const ended = phase === 'TURNAROUND' || phase === 'DONE';
  return (
    <div className="phase">
      <div className="phase-label">
        <span className="muted">{t('status.phase')}</span>
        <strong>{phase === null ? '—' : t(phaseKey(phase))}</strong>
      </div>
      <ol className="phase-strip" aria-hidden="true">
        {STRIP.map((p, i) => (
          <li
            key={p}
            title={t(phaseKey(p))}
            className={ended || i < index ? 'past' : i === index ? 'current' : ''}
          />
        ))}
      </ol>
    </div>
  );
}
