// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { type FormEvent, useState } from 'react';
import { CheckedMark, ExternalLink, Hint, Row, Saved } from './SettingsControls.js';
import { useStore } from './store.js';
import { useT } from './ui.js';

/** Credentials on the settings page: SimBrief username, Hoppie code, AeroDataBox key (U-06). */

/** Where the user finds the SimBrief username and gets a Hoppie code (U-06, checked 2026-10-22). */
const SIMBRIEF_URL = 'https://dispatch.simbrief.com/';
const HOPPIE_REGISTER_URL = 'https://www.hoppie.nl/acars/system/register.html';

export function UsernameForm({ initial }: { initial: string }) {
  const t = useT();
  const [value, setValue] = useState(initial);
  const busy = useStore((s) => s.busy);
  const { setUsername, checkSimbrief } = useStore.getState();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void setUsername(value);
  };
  return (
    <form onSubmit={submit}>
      <Row
        htmlFor="sb-user"
        title={t('set.simbrief')}
        hint={
          <Hint
            text={t('set.simbriefHint')}
            link={<ExternalLink href={SIMBRIEF_URL}>dispatch.simbrief.com</ExternalLink>}
          />
        }
      >
        <input
          id="sb-user"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
        />
        <button
          type="submit"
          className="btn"
          disabled={busy !== null || value.trim() === '' || value.trim() === initial}
        >
          {t('set.save')}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy !== null || initial === '' || value.trim() !== initial}
          onClick={() => void checkSimbrief()}
        >
          {busy === 'check' ? '…' : t('set.check')}
        </button>
        <Saved what="username" />
        <CheckedMark what="simbrief" />
      </Row>
    </form>
  );
}

export function HoppieCodeForm({ isSet }: { isSet: boolean }) {
  const t = useT();
  const [value, setValue] = useState('');
  const busy = useStore((s) => s.busy);
  const running = useStore((s) => s.app?.session === 'running');
  const { setHoppieCode, clearHoppieCode, checkHoppie } = useStore.getState();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void setHoppieCode(value).then((ok) => {
      if (ok) setValue('');
    });
  };
  return (
    <form onSubmit={submit}>
      <Row
        htmlFor="hoppie-code"
        title={
          <>
            {t('set.hoppie')}{' '}
            <span className={isSet ? 'pill ok' : 'pill'}>
              {t(isSet ? 'set.hoppieSet' : 'set.hoppieNotSet')}
            </span>
          </>
        }
        hint={
          <>
            <Hint text={t('set.hoppieHint')} />{' '}
            <span>
              {t('set.hoppieWhere')}{' '}
              <ExternalLink href={HOPPIE_REGISTER_URL}>hoppie.nl</ExternalLink>
            </span>
          </>
        }
      >
        <input
          id="hoppie-code"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={t('set.hoppiePlaceholder')}
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
        />
        <button type="submit" className="btn" disabled={busy !== null || value.trim() === ''}>
          {t('set.save')}
        </button>
        {isSet && (
          <button
            type="button"
            className="btn"
            // One ping per press; not during a flight (the transport keeps the request gap).
            disabled={busy !== null || running}
            title={running ? t('why.flight_running') : undefined}
            onClick={() => void checkHoppie()}
          >
            {busy === 'check' ? '…' : t('set.check')}
          </button>
        )}
        {isSet && (
          <button
            type="button"
            className="btn danger"
            disabled={busy !== null}
            onClick={() => {
              if (window.confirm(t('set.clearHoppieConfirm'))) void clearHoppieCode();
            }}
          >
            {t('set.clear')}
          </button>
        )}
        <Saved what="code" />
        <CheckedMark what="hoppie" />
      </Row>
    </form>
  );
}

/** The user's RapidAPI key for AeroDataBox: onward flights (T30, docs/07 C1, C3, C4). */
export function AerodataboxKeyForm({ isSet }: { isSet: boolean }) {
  const t = useT();
  const [value, setValue] = useState('');
  const busy = useStore((s) => s.busy);
  const { setAerodataboxKey, clearAerodataboxKey } = useStore.getState();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void setAerodataboxKey(value).then((ok) => {
      if (ok) setValue('');
    });
  };
  return (
    <form onSubmit={submit}>
      <Row
        htmlFor="adb-key"
        title={
          <>
            {t('set.adbKey')}{' '}
            <span className={isSet ? 'pill ok' : 'pill'}>
              {t(isSet ? 'set.hoppieSet' : 'set.hoppieNotSet')}
            </span>
          </>
        }
        hint={
          <Hint
            text={t('set.adbKeyHint')}
            link={<ExternalLink href="https://aerodatabox.com/">aerodatabox.com</ExternalLink>}
          />
        }
      >
        <input
          id="adb-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={t('set.adbKeyPlaceholder')}
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
        />
        <button type="submit" className="btn" disabled={busy !== null || value.trim() === ''}>
          {t('set.save')}
        </button>
        {isSet && (
          <button
            type="button"
            className="btn danger"
            disabled={busy !== null}
            onClick={() => {
              if (window.confirm(t('set.clearAdbConfirm'))) void clearAerodataboxKey();
            }}
          >
            {t('set.clear')}
          </button>
        )}
        <Saved what="adbKey" />
      </Row>
    </form>
  );
}
