import { useEffect } from 'react';
import type { AppState } from '../../shared/api.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { FlightView } from './FlightView.js';
import { errorKey, phaseKey, systemText } from './i18n.js';
import { ScenariosView } from './ScenariosView.js';
import { SettingsView } from './SettingsView.js';
import { useSiren } from './siren.js';
import { useMessageSound } from './sound.js';
import {
  atcStatus,
  bridgeStatus,
  linkStatus,
  netStatus,
  type StatusItem,
  simStatus,
} from './status.js';
import { type Tab, useStore } from './store.js';
import { useT, useUtcClock, zulu } from './ui.js';

/** `VRT204 · A20N · EDDM → LEMD` under the section title; null without a flight plan. */
function flightLine(app: AppState | null): string | null {
  const f = app?.flight ?? null;
  return f === null ? null : `${f.callsign} · ${f.aircraftIcao} · ${f.origin} → ${f.destination}`;
}

export function App() {
  const t = useT();
  const tab = useStore((s) => s.tab);
  const ready = useStore((s) => s.app !== null && s.settings !== null);
  const language = useStore((s) => s.settings?.language);
  useMessageSound();
  useSiren();

  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void useStore
      .getState()
      .init()
      .then((unsubscribe) => {
        if (cancelled) unsubscribe();
        else off = unsubscribe;
      });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  useEffect(() => {
    if (language !== undefined) document.documentElement.lang = language;
  }, [language]);

  return (
    <div className="app">
      <TopBar />
      <div className="body">
        <Rail />
        <main className="content">
          <ErrorBanner />
          <ErrorBoundary
            resetKey={tab}
            fallback={
              <p className="muted" role="alert">
                {t('err.view_crashed')}
              </p>
            }
          >
            {!ready ? null : tab === 'flight' ? (
              <FlightView />
            ) : tab === 'scenarios' ? (
              <ScenariosView />
            ) : (
              <SettingsView />
            )}
          </ErrorBoundary>
        </main>
      </div>
      {ready && <StatusBar />}
    </div>
  );
}

/** Logo, UTC, section and flight, then SIM / NET / CPDLC as words (no dots, design/spec.md §4). */
function TopBar() {
  const t = useT();
  const clock = useUtcClock();
  const tab = useStore((s) => s.tab);
  const app = useStore((s) => s.app);
  const route = flightLine(app);
  const phase = app?.session === 'running' ? app.phase : null;
  const subtitle = route === null || phase === null ? route : `${route} · ${t(phaseKey(phase))}`;
  const links: [string, StatusItem][] =
    app === null
      ? []
      : [
          ['SIM', simStatus(app, t)],
          ['NET', netStatus(app, t)],
        ];
  const atc = app === null ? null : atcStatus(app, t);
  if (atc !== null) links.push(['CPDLC', atc]);
  return (
    <header className="topbar">
      <div className="brand">
        <svg
          aria-hidden="true"
          width="30"
          height="22"
          viewBox="0 0 30 22"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <ellipse cx="13" cy="13" rx="11" ry="7" />
          <path d="M6 12l14-8 6 1-12 9-5 1z" />
        </svg>
        <time className="clock" title={t('top.utc')}>
          {clock}
        </time>
      </div>
      <div className="brand-text">
        <h1>{t(`page.${tab}`)}</h1>
        <span>{subtitle ?? t('app.title')}</span>
      </div>
      <ul className="top-links">
        {links.map(([k, s]) => (
          <li key={k} title={s.text}>
            <span className="top-key">{k}</span>
            <span className={`top-value ${s.tone}`}>{s.short}</span>
          </li>
        ))}
      </ul>
    </header>
  );
}

/** Text tiles (design/spec.md: "Боковая навигация"); the count is a second line, not a badge. */
function Rail() {
  const t = useT();
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  const messages = useStore((s) => s.app?.feed.filter((e) => e.kind !== 'system').length ?? 0);
  const tile = (id: Tab, count?: number) => (
    <button
      type="button"
      className={id === tab ? 'rail-tile active' : 'rail-tile'}
      aria-current={id === tab ? 'page' : undefined}
      onClick={() => setTab(id)}
    >
      <span className="rail-label">{t(`rail.${id}`)}</span>
      {count !== undefined && count > 0 && <span className="rail-count">{count}</span>}
    </button>
  );
  return (
    <nav className="rail" aria-label={t('app.sections')}>
      {tile('flight', messages)}
      {tile('scenarios')}
      <span className="rail-gap" />
      {tile('settings')}
    </nav>
  );
}

/** Link chips with a dot, then the last event of the feed. */
function StatusBar() {
  const t = useT();
  const app = useStore((s) => s.app);
  if (app === null) return null;
  const chips: [string, StatusItem][] = [
    [t('status.bridge'), bridgeStatus(app, t)],
    [t('status.sim'), simStatus(app, t)],
    [t('status.network'), netStatus(app, t)],
  ];
  const link = linkStatus(app, t);
  if (link !== null) chips.push([t('status.link'), link]);
  const last = app.feed.at(-1);
  const lastText =
    last === undefined
      ? null
      : last.kind === 'system'
        ? systemText(t, last.code, last.params)
        : last.kind === 'outbound'
          ? t('bar.sent', { to: last.to, id: last.scenarioId })
          : t('bar.received', { from: last.from });
  return (
    <footer className="statusbar">
      <ul className="bar-chips">
        {chips.map(([label, s]) => (
          <li key={label} className="bar-chip" title={s.text}>
            <span className={`dot ${s.tone}`} aria-hidden="true" />
            <span className="bar-label">{label}</span>
            <span className="bar-value">{s.short}</span>
          </li>
        ))}
      </ul>
      {last !== undefined && lastText !== null && (
        <p className="bar-last" aria-live="polite">
          <strong>{zulu(last.t)}</strong> · {lastText}
        </p>
      )}
    </footer>
  );
}

function ErrorBanner() {
  const t = useT();
  const error = useStore((s) => s.error);
  const dismiss = useStore((s) => s.dismissError);
  if (error === null) return null;
  return (
    <div className="banner error" role="alert">
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" className="banner-icon">
        <path d="M12 2.5l10.5 18.5h-21z" />
        <path d="M11 9h2v6h-2zM11 17h2v2h-2z" className="banner-icon-mark" />
      </svg>
      <span className="banner-kind">{t('banner.error')}</span>
      <span className="banner-text">{t(errorKey(error.code), { detail: error.detail })}</span>
      <button
        type="button"
        className="btn-round"
        aria-label={t('err.dismiss')}
        title={t('err.dismiss')}
        onClick={dismiss}
      >
        ✕
      </button>
    </div>
  );
}
