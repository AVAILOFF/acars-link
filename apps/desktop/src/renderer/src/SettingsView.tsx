import { DEFAULT_RESCUE_TITLES, RESCUE_TITLE_GROUPS } from '@acars/core';
import { type FormEvent, type ReactNode, useState } from 'react';
import type { Language, TransportChoice } from '../../shared/api.js';
import { testSiren } from './siren.js';
import { playMessageSound } from './sound.js';

/** Choices for the gap between messages, seconds. */
const GAPS: readonly number[] = [0, 30, 60, 90, 120, 180];

import { Switch, SwitchInput } from './Switch.js';
import { useStore } from './store.js';
import { useT } from './ui.js';

export function SettingsView() {
  const t = useT();
  const creds = useStore((s) => s.creds);
  const settings = useStore((s) => s.settings);
  const running = useStore((s) => s.app?.session === 'running');
  if (creds === null || settings === null) return null;
  return (
    <section className="page" aria-labelledby="set-title">
      <h2 id="set-title" className="page-title">
        {t('tab.settings')}
      </h2>
      <Group id="acc" title={t('set.account')}>
        {!creds.secureStorage && <p className="sheet-note warn">{t('set.noSecure')}</p>}
        <UsernameForm initial={creds.simbriefUsername} />
        <HoppieCodeForm isSet={creds.hoppieCodeSet} />
        <AerodataboxKeyForm isSet={creds.aerodataboxKeySet} />
      </Group>
      {running && <p className="hint warn">{t('set.runningNote')}</p>}
      <NetworkForm />
    </section>
  );
}

/** A titled light sheet of rows, like grouped settings on iOS. */
function Group({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="group" aria-labelledby={`grp-${id}`}>
      <h3 id={`grp-${id}`} className="group-title">
        {title}
      </h3>
      <div className="sheet">{children}</div>
    </section>
  );
}

/** One sheet row: title and hint on the left, the control on the right. */
function Row({
  htmlFor,
  title,
  hint,
  children,
}: {
  htmlFor?: string;
  title: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
}) {
  const text = (
    <>
      <span className="row-title">{title}</span>
      {hint !== undefined && <span className="row-hint">{hint}</span>}
    </>
  );
  return (
    <div className="sheet-row">
      {htmlFor === undefined ? (
        <span className="row-text">{text}</span>
      ) : (
        <label className="row-text" htmlFor={htmlFor}>
          {text}
        </label>
      )}
      {children !== undefined && <div className="row-control">{children}</div>}
    </div>
  );
}

function Saved({ what }: { what: 'username' | 'code' | 'adbKey' | 'settings' }) {
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
    <form onSubmit={submit}>
      <Row htmlFor="sb-user" title={t('set.simbrief')} hint={t('set.simbriefHint')}>
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
      </Row>
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
        hint={t('set.hoppieHint')}
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
            className="btn danger"
            disabled={busy !== null}
            onClick={() => void clearHoppieCode()}
          >
            {t('set.clear')}
          </button>
        )}
        <Saved what="code" />
      </Row>
    </form>
  );
}

/** The user's RapidAPI key for AeroDataBox: onward flights (T30, docs/07 C1, C3, C4). */
function AerodataboxKeyForm({ isSet }: { isSet: boolean }) {
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
          <>
            {t('set.adbKeyHint')}{' '}
            <a href="https://aerodatabox.com/" target="_blank" rel="noreferrer">
              aerodatabox.com
            </a>
          </>
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
            onClick={() => void clearAerodataboxKey()}
          >
            {t('set.clear')}
          </button>
        )}
        <Saved what="adbKey" />
      </Row>
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
  const off = busy !== null;
  const dirty = station !== settings.stationTemplate || port !== String(settings.bridgePort);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void update({ stationTemplate: station.trim(), bridgePort: Number(port) });
  };
  return (
    <>
      <Group id="general" title={t('set.group.general')}>
        <Row htmlFor="lang" title={t('set.language')}>
          <select
            id="lang"
            value={settings.language}
            disabled={off}
            onChange={(e) => void update({ language: e.currentTarget.value as Language })}
          >
            <option value="en">English</option>
            <option value="ru">Русский</option>
          </select>
        </Row>
        <Row htmlFor="transport" title={t('set.transport')}>
          <select
            id="transport"
            value={settings.transport}
            disabled={off}
            onChange={(e) => void update({ transport: e.currentTarget.value as TransportChoice })}
          >
            <option value="hoppie">{t('set.transport.hoppie')}</option>
            <option value="offline">{t('set.transport.offline')}</option>
          </select>
        </Row>
      </Group>

      <Group id="messages" title={t('set.group.messages')}>
        <Row htmlFor="gap" title={t('set.gap')} hint={t('set.gapHint')}>
          <select
            id="gap"
            value={settings.messageGapSec}
            disabled={off}
            onChange={(e) => void update({ messageGapSec: Number(e.currentTarget.value) })}
          >
            {GAPS.includes(settings.messageGapSec) ? null : (
              <option value={settings.messageGapSec}>{settings.messageGapSec}</option>
            )}
            {GAPS.map((s) => (
              <option key={s} value={s}>
                {s === 0 ? t('set.gapNone') : t('set.gapSec', { s })}
              </option>
            ))}
          </select>
        </Row>
        <Row htmlFor="sound" title={t('set.sound')} hint={t('set.soundHint')}>
          <button type="button" className="btn" onClick={() => playMessageSound()}>
            {t('set.soundTest')}
          </button>
          <SwitchInput
            id="sound"
            checked={settings.soundOnMessage}
            disabled={off}
            onChange={(v) => void update({ soundOnMessage: v })}
          />
        </Row>
        <Row htmlFor="hub-icao" title={t('set.hubIcao')} hint={t('set.hubIcaoHint')}>
          <input
            id="hub-icao"
            className="caps short"
            type="text"
            maxLength={4}
            spellCheck={false}
            defaultValue={settings.hubIcao}
            disabled={off}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim().toUpperCase();
              if (v !== settings.hubIcao) void update({ hubIcao: v });
            }}
          />
        </Row>
      </Group>

      <Group id="data" title={t('set.group.data')}>
        <Switch
          checked={settings.liveData}
          disabled={off}
          onChange={(v) => void update({ liveData: v })}
          hint={t('set.liveDataHint')}
        >
          {t('set.liveData')}
        </Switch>
        <p className="sheet-note">
          <strong>{t('set.special')}</strong> {t('set.specialHint')}
        </p>
        {(['specialSport', 'specialAviation', 'specialOther'] as const).map((key) => (
          <Switch
            key={key}
            checked={settings[key]}
            disabled={off}
            onChange={(v) => void update({ [key]: v })}
          >
            {t(`set.${key}`)}
          </Switch>
        ))}
      </Group>

      <Group id="rops" title={t('set.group.rops')}>
        <Switch
          checked={settings.rops}
          disabled={off}
          onChange={(v) => void update({ rops: v })}
          hint={t('set.ropsHint')}
        >
          {t('set.rops')}
        </Switch>
        <Switch
          checked={settings.ropsStandAside}
          disabled={off || !settings.rops}
          onChange={(v) => void update({ ropsStandAside: v })}
          hint={t('set.ropsStandAsideHint')}
        >
          {t('set.ropsStandAside')}
        </Switch>
        <Switch
          checked={settings.ropsRandomDirects}
          disabled={off || !settings.rops}
          onChange={(v) => void update({ ropsRandomDirects: v })}
          hint={t('set.ropsRandomDirectsHint')}
        >
          {t('set.ropsRandomDirects')}
        </Switch>
      </Group>

      <Group id="datalink" title={t('set.group.datalink')}>
        <Switch
          checked={settings.datalink}
          disabled={off}
          onChange={(v) => void update({ datalink: v })}
          hint={t('set.datalinkHint')}
        >
          {t('set.datalink')}
        </Switch>
        <Switch
          checked={settings.datalinkSatcom}
          disabled={off || !settings.datalink}
          onChange={(v) => void update({ datalinkSatcom: v })}
        >
          {t('set.datalinkSatcom')}
        </Switch>
        <Switch
          checked={settings.datalinkHeaderInText}
          disabled={off || !settings.datalink}
          onChange={(v) => void update({ datalinkHeaderInText: v })}
        >
          {t('set.datalinkHeaderInText')}
        </Switch>
        <Row
          htmlFor="icao-hex"
          title={t('set.aircraftIcaoHex')}
          hint={t('set.aircraftIcaoHexHint')}
        >
          <input
            id="icao-hex"
            className="caps short"
            type="text"
            maxLength={6}
            defaultValue={settings.aircraftIcaoHex}
            disabled={off || !settings.datalink}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              if (v !== settings.aircraftIcaoHex) void update({ aircraftIcaoHex: v });
            }}
          />
        </Row>
      </Group>

      <Group id="rescue" title={t('set.group.rescue')}>
        <Switch
          checked={settings.rescue}
          disabled={off}
          onChange={(v) => void update({ rescue: v })}
          hint={t('set.rescueHint')}
        >
          {t('set.rescue')}
        </Switch>
        <Row htmlFor="siren" title={t('set.rescueSiren')} hint={t('set.rescueSirenHint')}>
          <button type="button" className="btn" onClick={() => testSiren()}>
            {t('set.soundTest')}
          </button>
          <SwitchInput
            id="siren"
            checked={settings.rescueSiren}
            disabled={off || !settings.rescue}
            onChange={(v) => void update({ rescueSiren: v })}
          />
        </Row>
        <p className="sheet-note">{t('set.rescueTitlesHint')}</p>
        {RESCUE_TITLE_GROUPS.map((g) => (
          <Row key={g} htmlFor={`rescue-${g}`} title={t(`set.rescue.${g}`)}>
            <textarea
              id={`rescue-${g}`}
              rows={2}
              spellCheck={false}
              // A new key after a save or a reset puts the stored list back in the field.
              key={settings.rescueTitles[g].join('\n')}
              defaultValue={settings.rescueTitles[g].join('\n')}
              disabled={off || !settings.rescue}
              onBlur={(e) => {
                const list = e.currentTarget.value
                  .split('\n')
                  .map((s) => s.trim())
                  .filter((s) => s !== '');
                if (list.join('\n') !== settings.rescueTitles[g].join('\n')) {
                  void update({ rescueTitles: { ...settings.rescueTitles, [g]: list } });
                }
              }}
            />
          </Row>
        ))}
        <Row title={t('set.rescueDefaults')}>
          <button
            type="button"
            className="btn"
            disabled={off || !settings.rescue}
            onClick={() => void update({ rescueTitles: DEFAULT_RESCUE_TITLES })}
          >
            {t('set.rescueReset')}
          </button>
        </Row>
      </Group>

      <Group id="records" title={t('set.group.records')}>
        <Row htmlFor="record" title={t('set.record')} hint={t('set.recordHint')}>
          <button
            type="button"
            className="btn"
            disabled={off}
            onClick={() => void openRecordings()}
          >
            {t('set.openRecordings')}
          </button>
          <SwitchInput
            id="record"
            checked={settings.recordFlights}
            disabled={off}
            onChange={(v) => void update({ recordFlights: v })}
          />
        </Row>
        <Row
          title={
            memory.length === 0
              ? t('set.memoryEmpty')
              : t('set.memory', { names: memory.join(', ') })
          }
          hint={t('set.memoryHint')}
        >
          <button
            type="button"
            className="btn danger"
            disabled={off || running || memory.length === 0}
            onClick={() => void clearMemory()}
          >
            {t('set.clearMemory')}
          </button>
        </Row>
      </Group>

      <form onSubmit={submit}>
        <Group id="conn" title={t('set.group.connection')}>
          <Row htmlFor="station" title={t('set.station')} hint={t('set.stationHint')}>
            <input
              id="station"
              type="text"
              spellCheck={false}
              value={station}
              onChange={(e) => setStation(e.currentTarget.value)}
            />
          </Row>
          <Row htmlFor="port" title={t('set.bridgePort')}>
            <input
              id="port"
              type="number"
              min={1024}
              max={65535}
              className="short"
              value={port}
              onChange={(e) => setPort(e.currentTarget.value)}
            />
          </Row>
          <div className="sheet-actions">
            <Saved what="settings" />
            <button type="submit" className="btn primary" disabled={off || !dirty}>
              {t('set.save')}
            </button>
          </div>
        </Group>
      </form>
    </>
  );
}
