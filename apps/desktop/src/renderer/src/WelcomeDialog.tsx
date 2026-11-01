// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { useEffect, useRef, useState } from 'react';
import type { Language, TransportChoice } from '../../shared/api.js';
import type { MessageKey } from './i18n.js';
import { HoppieCodeForm, UsernameForm } from './SettingsAccounts.js';
import { LanguageOptions, Row } from './SettingsControls.js';
import { useStore } from './store.js';
import { useT } from './ui.js';
import { type ReadyItem, type ReadyKey, readiness, WELCOME_STEPS } from './welcome.js';

/**
 * The welcome dialog (T70): what the app does, accounts, the simulator, the first flight. Opens on
 * a new profile and from Help; closing it at any step counts as seen.
 */
export function WelcomeDialog() {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState(0);
  const finish = useStore((s) => s.finishWelcome);
  const name = WELCOME_STEPS[step] ?? 'hello';
  const last = step === WELCOME_STEPS.length - 1;

  // A modal <dialog>: focus trap, inert background and Esc come from the browser.
  useEffect(() => {
    const d = ref.current;
    if (d !== null && !d.open) d.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className="modal welcome"
      aria-labelledby="welcome-title"
      onCancel={(e) => {
        e.preventDefault();
        void finish();
      }}
    >
      <div className="modal-sheet">
        <header className="modal-head">
          <span className="welcome-count">
            {t('welcome.step', { n: step + 1, of: WELCOME_STEPS.length })}
          </span>
          <h2 id="welcome-title">{t(`welcome.${name}.title`)}</h2>
          <button
            type="button"
            className="btn-round light"
            aria-label={t('welcome.skip')}
            title={t('welcome.skip')}
            onClick={() => void finish()}
          >
            ✕
          </button>
        </header>
        <div className="sheet modal-body welcome-body">
          {name === 'hello' && <HelloStep />}
          {name === 'accounts' && <AccountsStep />}
          {name === 'sim' && <SimStep />}
          {name === 'first' && <FirstStep />}
        </div>
        <footer className="modal-foot">
          {step === 0 ? (
            <button type="button" className="btn" onClick={() => void finish()}>
              {t('welcome.skip')}
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => setStep(step - 1)}>
              {t('welcome.back')}
            </button>
          )}
          {last ? (
            <>
              <button type="button" className="btn" onClick={() => void finish(true)}>
                {t('welcome.tour')}
              </button>
              <button type="button" className="btn primary" onClick={() => void finish()}>
                {t('welcome.done')}
              </button>
            </>
          ) : (
            <button type="button" className="btn primary" onClick={() => setStep(step + 1)}>
              {t('welcome.next')}
            </button>
          )}
        </footer>
      </div>
    </dialog>
  );
}

function HelloStep() {
  const t = useT();
  const language = useStore((s) => s.settings?.language ?? 'en');
  const update = useStore((s) => s.updateSettings);
  return (
    <>
      <p className="welcome-text">{t('welcome.hello.text')}</p>
      <p className="welcome-text">{t('welcome.hello.english')}</p>
      <Row htmlFor="welcome-lang" title={t('set.language')}>
        <select
          id="welcome-lang"
          value={language}
          onChange={(e) => void update({ language: e.currentTarget.value as Language })}
        >
          <LanguageOptions current={language} />
        </select>
      </Row>
    </>
  );
}

function AccountsStep() {
  const t = useT();
  const creds = useStore((s) => s.creds);
  const transport = useStore((s) => s.settings?.transport ?? 'hoppie');
  const running = useStore((s) => s.app?.session === 'running');
  const update = useStore((s) => s.updateSettings);
  if (creds === null) return null;
  return (
    <>
      <p className="welcome-text">{t('welcome.accounts.text')}</p>
      <UsernameForm initial={creds.simbriefUsername} />
      <Row htmlFor="welcome-transport" title={t('set.transport')}>
        <select
          id="welcome-transport"
          value={transport}
          disabled={running}
          onChange={(e) => void update({ transport: e.currentTarget.value as TransportChoice })}
        >
          <option value="hoppie">{t('set.transport.hoppie')}</option>
          <option value="offline">{t('set.transport.offline')}</option>
        </select>
      </Row>
      {transport === 'hoppie' && <HoppieCodeForm isSet={creds.hoppieCodeSet} />}
      <p className="welcome-text field-hint">{t('welcome.accounts.later')}</p>
    </>
  );
}

function SimStep() {
  const t = useT();
  const items = useReadiness()?.filter((i) => i.key === 'bridge' || i.key === 'sim') ?? [];
  return (
    <>
      <p className="welcome-text">{t('welcome.sim.text')}</p>
      <ReadyList items={items} links={false} />
      <p className="welcome-text field-hint">{t('welcome.sim.later')}</p>
    </>
  );
}

function FirstStep() {
  const t = useT();
  return (
    <>
      <ol className="welcome-text welcome-steps">
        <li>{t('welcome.first.1')}</li>
        <li>{t('welcome.first.2')}</li>
        <li>{t('welcome.first.3')}</li>
        <li>{t('welcome.first.4')}</li>
      </ol>
      <p className="welcome-text field-hint">{t('welcome.first.help')}</p>
    </>
  );
}

/** The readiness items of the current state; null until the state is loaded. */
export function useReadiness(): readonly ReadyItem[] | null {
  const app = useStore((s) => s.app);
  const creds = useStore((s) => s.creds);
  const settings = useStore((s) => s.settings);
  if (app === null || creds === null || settings === null) return null;
  return readiness(app, creds, settings);
}

/** What to do about an item that is not done; `wait` texts where the state can be on its way. */
const TODO: Readonly<Record<ReadyKey, MessageKey>> = {
  simbrief: 'ready.simbrief.todo',
  network: 'ready.network.todo',
  bridge: 'ready.bridge.todo',
  sim: 'ready.sim.todo',
  ofp: 'ready.ofp.todo',
};
const WAIT: Readonly<Partial<Record<ReadyKey, MessageKey>>> = {
  bridge: 'ready.bridge.wait',
  sim: 'ready.sim.wait',
};

function readyHint(i: ReadyItem): MessageKey {
  if (i.offline) return 'ready.network.offline';
  if (i.state === 'ok') return 'ready.ok';
  return i.state === 'wait' ? (WAIT[i.key] ?? TODO[i.key]) : TODO[i.key];
}

/** The readiness list (U-01, U-02): each item with its state and, if not done, what to do. */
export function ReadyList({ items, links }: { items: readonly ReadyItem[]; links: boolean }) {
  const t = useT();
  const openField = useStore((s) => s.openField);
  return (
    <ul className="ready-list">
      {items.map((i) => {
        const fix = links ? i.fix : null;
        return (
          <li key={i.key} className="ready-item">
            <span
              aria-hidden="true"
              className={`dot ${i.state === 'ok' ? 'ok' : i.state === 'wait' ? 'warn' : 'off'}`}
            />
            <span className="ready-text">
              <span className="ready-title">{t(`ready.${i.key}`)}</span>
              <span className="ready-hint">{t(readyHint(i))}</span>
            </span>
            {fix !== null && (
              <button type="button" className="btn" onClick={() => openField(fix)}>
                {t('ready.fix')}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
