import { useEffect } from 'react';
import { ErrorBoundary } from './ErrorBoundary.js';
import { FlightView } from './FlightView.js';
import { errorKey } from './i18n.js';
import { ScenariosView } from './ScenariosView.js';
import { SettingsView } from './SettingsView.js';
import { useMessageSound } from './sound.js';
import { type Tab, useStore } from './store.js';
import { useT } from './ui.js';

const TABS: readonly Tab[] = ['flight', 'scenarios', 'settings'];

export function App() {
  const t = useT();
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  const ready = useStore((s) => s.app !== null && s.settings !== null);
  const language = useStore((s) => s.settings?.language);
  useMessageSound();

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
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ◆
          </span>
          {t('app.title')}
        </div>
        <nav className="tabs" aria-label="Sections">
          {TABS.map((id) => (
            <button
              key={id}
              type="button"
              className={id === tab ? 'tab active' : 'tab'}
              aria-current={id === tab ? 'page' : undefined}
              onClick={() => setTab(id)}
            >
              {t(`tab.${id}`)}
            </button>
          ))}
        </nav>
      </header>
      <ErrorBanner />
      <main className="content">
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
  );
}

function ErrorBanner() {
  const t = useT();
  const error = useStore((s) => s.error);
  const dismiss = useStore((s) => s.dismissError);
  if (error === null) return null;
  return (
    <div className="error-banner" role="alert">
      <span>{t(errorKey(error.code), { detail: error.detail })}</span>
      <button type="button" className="btn ghost small" onClick={dismiss}>
        {t('err.dismiss')}
      </button>
    </div>
  );
}
