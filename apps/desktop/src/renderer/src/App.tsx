// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { useEffect, useLayoutEffect, useRef } from 'react';
import type { AppState } from '../../shared/api.js';
import { openActions } from './actions.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { FlightView } from './FlightView.js';
import { HelpView } from './HelpView.js';
import { errorText, phaseKey, systemText } from './i18n.js';
import { ResumeDialog } from './ResumeDialog.js';
import { ScenariosView } from './ScenariosView.js';
import { SettingsView } from './SettingsView.js';
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
import { Tour } from './Tour.js';
import { useT, useUtcClock, zulu } from './ui.js';
import { WelcomeDialog } from './WelcomeDialog.js';

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
  const welcome = useStore((s) => s.welcome);
  const tour = useStore((s) => s.tour !== null);
  // T64: the lost flight is asked about before the welcome.
  const resume = useStore((s) => (s.resumeHidden ? null : (s.app?.resume ?? null)));
  const content = useRef<HTMLElement>(null);
  // U-12: each tab keeps its own scroll position in the shared scroll box.
  const scroll = useRef<Partial<Record<Tab, number>>>({});
  const shown = useRef<Tab>(tab);
  useMessageSound();

  useLayoutEffect(() => {
    const box = content.current;
    if (box === null || shown.current === tab) return;
    scroll.current[shown.current] = box.scrollTop;
    shown.current = tab;
    box.scrollTop = scroll.current[tab] ?? 0;
  }, [tab]);

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
        <main className="content" ref={content}>
          <ErrorBanner />
          <TransportBanner />
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
            ) : tab === 'help' ? (
              <HelpView />
            ) : (
              <SettingsView />
            )}
          </ErrorBoundary>
        </main>
      </div>
      {ready && <StatusBar />}
      {ready && resume !== null && <ResumeDialog offer={resume} />}
      {ready && resume === null && welcome && <WelcomeDialog />}
      {ready && tour && <Tour />}
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
    <header className="topbar" data-tour="top">
      <div className="brand">
        {/* Brand mark: design/logo/mark.svg */}
        <svg aria-hidden="true" width="24" height="24" viewBox="8 8 50 50" fill="none">
          <path
            fill="currentColor"
            transform="translate(25 39) rotate(45) scale(.62) translate(-32 -32)"
            d="M32 8C34 8 35 10 35 13V26L54 36V40L35 35V48L41 53V56L32 54L23 56V53L29 48V35L10 40V36L29 26V13C29 10 30 8 32 8Z"
          />
          <g stroke="currentColor" strokeWidth="4" strokeLinecap="round">
            <path d="M37 19A10 10 0 0 1 47 29" />
            <path d="M37 10A19 19 0 0 1 56 29" />
          </g>
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
    <nav className="rail" aria-label={t('app.sections')} data-tour="rail">
      {tile('flight', messages)}
      {tile('scenarios')}
      <span className="rail-gap" />
      {tile('settings')}
      {tile('help')}
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
  const action = openActions(app.feed).at(-1);
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
    <footer className="statusbar" data-tour="status">
      <ul className="bar-chips">
        {chips.map(([label, s]) => (
          <li key={label} className="bar-chip" title={s.text}>
            <span className={`dot ${s.tone}`} aria-hidden="true" />
            <span className="bar-label">{label}</span>
            <span className="bar-value">{s.short}</span>
          </li>
        ))}
      </ul>
      {action !== undefined ? (
        // U-15: what needs the pilot stays here until it is settled.
        <p
          className="bar-last bar-action"
          aria-live="polite"
          title={systemText(t, action.code, action.params)}
        >
          <span className="pill caution">{t('bar.action')}</span>
          <strong>{zulu(action.t)}</strong>
          <span className="bar-action-text">{systemText(t, action.code, action.params)}</span>
        </p>
      ) : (
        last !== undefined &&
        lastText !== null && (
          <p className="bar-last" aria-live="polite">
            <strong>{zulu(last.t)}</strong> · {lastText}
          </p>
        )
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
      <span className="banner-text">{errorText(t, error)}</span>
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

/**
 * U-06: Hoppie refused the transport (a wrong logon code): the reason and what to do, above every
 * tab until the flight stops. The running transport keeps its code, so a new one needs a new flight.
 */
function TransportBanner() {
  const t = useT();
  const transport = useStore((s) => s.app?.transport ?? null);
  const setTab = useStore((s) => s.setTab);
  if (transport === null || transport.kind !== 'hoppie' || transport.status !== 'halted') {
    return null;
  }
  return (
    <div className="banner error" role="alert">
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" className="banner-icon">
        <path d="M12 2.5l10.5 18.5h-21z" />
        <path d="M11 9h2v6h-2zM11 17h2v2h-2z" className="banner-icon-mark" />
      </svg>
      <span className="banner-kind">{t('banner.network')}</span>
      <span className="banner-text">{t('banner.halted', { reason: transport.reason ?? '' })}</span>
      <button type="button" className="btn" onClick={() => setTab('settings')}>
        {t('banner.toSettings')}
      </button>
    </div>
  );
}
