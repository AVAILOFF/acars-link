import { type FormEvent, useState } from 'react';
import type { Language, TransportChoice } from '../../shared/api.js';
import { playMessageSound } from './sound.js';
import { useStore } from './store.js';
import { useT } from './ui.js';

export function SettingsView() {
  const t = useT();
  const creds = useStore((s) => s.creds);
  const settings = useStore((s) => s.settings);
  const running = useStore((s) => s.app?.session === 'running');
  if (creds === null || settings === null) return null;
  return (
    <div className="settings">
      <section className="panel narrow" aria-labelledby="acc-title">
        <h2 id="acc-title" className="panel-title">
          {t('set.account')}
        </h2>
        {!creds.secureStorage && <p className="hint warn">{t('set.noSecure')}</p>}
        <UsernameForm initial={creds.simbriefUsername} />
        <HoppieCodeForm isSet={creds.hoppieCodeSet} />
      </section>
      <section className="panel narrow" aria-labelledby="net-title">
        <h2 id="net-title" className="panel-title">
          {t('set.network')}
        </h2>
        {running && <p className="hint warn">{t('set.runningNote')}</p>}
        <NetworkForm />
      </section>
    </div>
  );
}

function Saved({ what }: { what: 'username' | 'code' | 'settings' }) {
  const t = useT();
  const saved = useStore((s) => s.saved === what);
  return saved ? (
    <span className="saved" role="status">
      ✓ {t('set.saved')}
    </span>
  ) : null;
}

function UsernameForm({ initial }: { initial: string }) {
  const t = useT();
  const [value, setValue] = useState(initial);
  const busy = useStore((s) => s.busy);
  const setUsername = useStore((s) => s.setUsername);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void setUsername(value);
  };
  return (
    <form className="field" onSubmit={submit}>
      <label htmlFor="sb-user">{t('set.simbrief')}</label>
      <div className="row">
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
        <Saved what="username" />
      </div>
      <p className="hint">{t('set.simbriefHint')}</p>
    </form>
  );
}

function HoppieCodeForm({ isSet }: { isSet: boolean }) {
  const t = useT();
  const [value, setValue] = useState('');
  const busy = useStore((s) => s.busy);
  const { setHoppieCode, clearHoppieCode } = useStore.getState();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void setHoppieCode(value).then((ok) => {
      if (ok) setValue('');
    });
  };
  return (
    <form className="field" onSubmit={submit}>
      <label htmlFor="hoppie-code">
        {t('set.hoppie')}{' '}
        <span className={isSet ? 'badge ok' : 'badge'}>
          {t(isSet ? 'set.hoppieSet' : 'set.hoppieNotSet')}
        </span>
      </label>
      <div className="row">
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
            className="btn ghost"
            disabled={busy !== null}
            onClick={() => void clearHoppieCode()}
          >
            {t('set.clear')}
          </button>
        )}
        <Saved what="code" />
      </div>
      <p className="hint">{t('set.hoppieHint')}</p>
    </form>
  );
}

function NetworkForm() {
  const t = useT();
  const settings = useStore((s) => s.settings);
  const busy = useStore((s) => s.busy);
  const update = useStore((s) => s.updateSettings);
  const openRecordings = useStore((s) => s.openRecordings);
  const clearMemory = useStore((s) => s.clearMemory);
  const memory = useStore((s) => s.app?.memory ?? []);
  const running = useStore((s) => s.app?.session === 'running');
  const [station, setStation] = useState(settings?.stationTemplate ?? '');
  const [port, setPort] = useState(String(settings?.bridgePort ?? ''));
  if (settings === null) return null;
  const dirty = station !== settings.stationTemplate || port !== String(settings.bridgePort);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void update({ stationTemplate: station.trim(), bridgePort: Number(port) });
  };
  return (
    <>
      <div className="field">
        <label htmlFor="lang">{t('set.language')}</label>
        <select
          id="lang"
          value={settings.language}
          disabled={busy !== null}
          onChange={(e) => void update({ language: e.currentTarget.value as Language })}
        >
          <option value="en">English</option>
          <option value="ru">Русский</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="transport">{t('set.transport')}</label>
        <select
          id="transport"
          value={settings.transport}
          disabled={busy !== null}
          onChange={(e) => void update({ transport: e.currentTarget.value as TransportChoice })}
        >
          <option value="hoppie">{t('set.transport.hoppie')}</option>
          <option value="offline">{t('set.transport.offline')}</option>
        </select>
      </div>
      <div className="field">
        <div className="row">
          <label className="check">
            <input
              type="checkbox"
              checked={settings.recordFlights}
              disabled={busy !== null}
              onChange={(e) => void update({ recordFlights: e.currentTarget.checked })}
            />
            {t('set.record')}
          </label>
          <button
            type="button"
            className="btn ghost"
            disabled={busy !== null}
            onClick={() => void openRecordings()}
          >
            {t('set.openRecordings')}
          </button>
        </div>
        <p className="hint">{t('set.recordHint')}</p>
      </div>
      <div className="field">
        <label className="check">
          <input
            type="checkbox"
            checked={settings.liveData}
            disabled={busy !== null}
            onChange={(e) => void update({ liveData: e.currentTarget.checked })}
          />
          {t('set.liveData')}
        </label>
        <p className="hint">{t('set.liveDataHint')}</p>
      </div>
      <div className="field">
        <div className="row">
          <label className="check">
            <input
              type="checkbox"
              checked={settings.soundOnMessage}
              disabled={busy !== null}
              onChange={(e) => void update({ soundOnMessage: e.currentTarget.checked })}
            />
            {t('set.sound')}
          </label>
          <button type="button" className="btn ghost" onClick={() => playMessageSound()}>
            {t('set.soundTest')}
          </button>
        </div>
        <p className="hint">{t('set.soundHint')}</p>
      </div>
      <div className="field">
        <div className="row">
          <span>
            {memory.length === 0
              ? t('set.memoryEmpty')
              : t('set.memory', { names: memory.join(', ') })}
          </span>
          <button
            type="button"
            className="btn ghost"
            disabled={busy !== null || running || memory.length === 0}
            onClick={() => void clearMemory()}
          >
            {t('set.clearMemory')}
          </button>
        </div>
        <p className="hint">{t('set.memoryHint')}</p>
      </div>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="station">{t('set.station')}</label>
          <input
            id="station"
            type="text"
            className="mono"
            spellCheck={false}
            value={station}
            onChange={(e) => setStation(e.currentTarget.value)}
          />
          <p className="hint">{t('set.stationHint')}</p>
        </div>
        <div className="field">
          <label htmlFor="port">{t('set.bridgePort')}</label>
          <input
            id="port"
            type="number"
            min={1024}
            max={65535}
            className="mono short"
            value={port}
            onChange={(e) => setPort(e.currentTarget.value)}
          />
        </div>
        <div className="row">
          <button type="submit" className="btn" disabled={busy !== null || !dirty}>
            {t('set.save')}
          </button>
          <Saved what="settings" />
        </div>
      </form>
    </>
  );
}
