import { DEFAULT_RESCUE_FLIPPED, DEFAULT_RESCUE_TITLES, RESCUE_TITLE_GROUPS } from '@acars/core';
import { type FormEvent, type ReactNode, useState } from 'react';
import type { Language, Settings, SettingsPatch, TransportChoice } from '../../shared/api.js';
import { firstSentence } from './hints.js';
import { Switch, SwitchInput } from './Switch.js';
import { testSiren } from './siren.js';
import { playMessageSound } from './sound.js';
import { useStore } from './store.js';
import { useT } from './ui.js';

/** Choices for the gap between messages, seconds. */
const GAPS: readonly number[] = [0, 30, 60, 90, 120, 180];

/** Where the user finds the SimBrief username and gets a Hoppie code (U-06, checked 2026-10-22). */
const SIMBRIEF_URL = 'https://dispatch.simbrief.com/';
const HOPPIE_REGISTER_URL = 'https://www.hoppie.nl/acars/system/register.html';

/** The same rule as `main/settings.ts`, so a bad template is caught at the field. */
const STATION_RE = /^(?:[A-Z0-9]|\{flight\}|\{airline\})+$/i;

/**
 * Settings (T56): the basic ones first, the expert ones folded under "Advanced" (U-07). Every
 * setting saves at once and marks its own row "saved" (U-08); the ones a running flight does not
 * pick up carry a "next flight" tag (U-09).
 */
export function SettingsView() {
  const t = useT();
  const creds = useStore((s) => s.creds);
  const settings = useStore((s) => s.settings);
  const open = useStore((s) => s.advancedOpen);
  const setOpen = useStore((s) => s.setAdvancedOpen);
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
      <BasicSettings s={settings} />
      <details className="advanced" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>
          <span className="advanced-title">{t('set.advanced')}</span>
          <span className="advanced-hint">{t('set.advancedHint')}</span>
        </summary>
        <AdvancedSettings s={settings} />
      </details>
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

/** A hint: its first sentence, the rest behind "More" (U-07); `link` always shows. */
function Hint({ text, link, off }: { text: string; link?: ReactNode; off?: string | undefined }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const first = firstSentence(text);
  const rest = text.slice(first.length).trim();
  return (
    <>
      {off !== undefined && <span className="row-off">{off}</span>}
      <span>
        {first}
        {open && rest !== '' && ` ${rest}`}
        {link !== undefined && <> {link}</>}
        {rest !== '' && (
          <>
            {' '}
            <button
              type="button"
              className="link-btn"
              aria-expanded={open}
              onClick={(e) => {
                // Inside a switch row's label: the click must not flip the switch.
                e.preventDefault();
                setOpen(!open);
              }}
            >
              {t(open ? 'set.less' : 'set.more')}
            </button>
          </>
        )}
      </span>
    </>
  );
}

/** "Next flight" tag (U-09): highlighted while a flight runs. */
function NextFlight() {
  const t = useT();
  const running = useStore((s) => s.app?.session === 'running');
  return (
    <span className={running ? 'tag next live' : 'tag next'} title={t('set.nextFlightTitle')}>
      {t('set.nextFlight')}
    </span>
  );
}

/** Title with the optional "next flight" tag. */
function Title({ text, next }: { text: ReactNode; next?: boolean | undefined }) {
  return (
    <>
      {text}
      {next === true && (
        <>
          {' '}
          <NextFlight />
        </>
      )}
    </>
  );
}

/** "Saved" next to the row that was just saved (U-08). */
function SavedMark({ field }: { field: string }) {
  const t = useT();
  const saved = useStore((s) => s.saved === 'settings' && s.savedField === field);
  return saved ? (
    <span className="saved" role="status">
      ✓ {t('set.saved')}
    </span>
  ) : null;
}

/** One sheet row: title and hint on the left, the control on the right; `off` dims it (U-13). */
function Row({
  htmlFor,
  title,
  hint,
  off,
  error,
  errorId,
  children,
}: {
  htmlFor?: string;
  title: ReactNode;
  hint?: ReactNode;
  off?: boolean | undefined;
  /** Inline message of a value that cannot be saved. */
  error?: string | null;
  errorId?: string;
  children?: ReactNode;
}) {
  const text = (
    <>
      <span className="row-title">{title}</span>
      {hint !== undefined && <span className="row-hint">{hint}</span>}
      {error != null && (
        <span id={errorId} className="row-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
  return (
    <div className={off === true ? 'sheet-row off' : 'sheet-row'}>
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

function Saved({ what }: { what: 'username' | 'code' | 'adbKey' }) {
  const t = useT();
  const saved = useStore((s) => s.saved === what);
  return saved ? (
    <span className="saved" role="status">
      ✓ {t('set.saved')}
    </span>
  ) : null;
}

/** Result of a "Check" button (U-06). */
function CheckedMark({ what }: { what: 'simbrief' | 'hoppie' }) {
  const t = useT();
  const checked = useStore((s) => s.checked);
  if (checked === null || checked.what !== what) return null;
  return (
    <span className="saved" role="status">
      ✓{' '}
      {checked.what === 'simbrief'
        ? t('set.checkSimbriefOk', { ...checked.ofp })
        : t('set.checkHoppieOk')}
    </span>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

function UsernameForm({ initial }: { initial: string }) {
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

function HoppieCodeForm({ isSet }: { isSet: boolean }) {
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

/** Saving of one setting; false while another action runs. */
function useUpdate() {
  const busy = useStore((s) => s.busy);
  const update = useStore((s) => s.updateSettings);
  return { off: busy !== null, update };
}

/** A switch row of a boolean setting with its "saved" mark. */
function SettingSwitch({
  s,
  k,
  title,
  hint,
  next,
  disabled,
  offHint,
}: {
  s: Settings;
  k: {
    [K in keyof SettingsPatch]-?: SettingsPatch[K] extends boolean | undefined ? K : never;
  }[keyof SettingsPatch];
  title: string;
  hint?: string;
  next?: boolean;
  /** Dimmed with `offHint` saying what to turn on (U-13). */
  disabled?: boolean;
  offHint?: string;
}) {
  const { off, update } = useUpdate();
  const dim = disabled === true;
  return (
    <Switch
      checked={s[k]}
      disabled={off || dim}
      onChange={(v) => void update({ [k]: v })}
      hint={
        hint === undefined && !dim ? undefined : (
          <Hint text={hint ?? ''} off={dim ? offHint : undefined} />
        )
      }
      after={<SavedMark field={k} />}
    >
      <Title text={title} next={next} />
    </Switch>
  );
}

/**
 * A text setting saved on Enter or when the field is left (U-08), checked first: a value that
 * cannot be saved stays in the field with a message under it.
 */
function useTextSetting({
  id,
  field,
  value,
  check,
  normalize,
  save,
  className,
  maxLength,
  inputMode,
  disabled,
}: {
  id: string;
  field: string;
  value: string;
  /** The message for a bad value, null = fine. */
  check: (v: string) => string | null;
  normalize?: (v: string) => string;
  save: (v: string) => void;
  className?: string;
  maxLength?: number;
  inputMode?: 'numeric';
  disabled: boolean;
}) {
  const [text, setText] = useState(value);
  const [shown, setShown] = useState(value);
  const [error, setError] = useState<string | null>(null);
  // A new stored value (saved here, a reset) replaces the text.
  if (shown !== value) {
    setShown(value);
    setText(value);
    setError(null);
  }
  const commit = () => {
    const v = (normalize ?? ((x: string) => x.trim()))(text);
    const bad = check(v);
    setError(bad);
    if (bad === null && v !== value) save(v);
  };
  return {
    error,
    input: (
      <>
        <input
          id={id}
          type="text"
          className={className}
          maxLength={maxLength}
          inputMode={inputMode}
          spellCheck={false}
          autoComplete="off"
          value={text}
          disabled={disabled}
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : `${id}-error`}
          onChange={(e) => setText(e.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              setText(value);
              setError(null);
            }
          }}
        />
        <SavedMark field={field} />
      </>
    ),
  };
}

/** A row with a {@link useTextSetting}: the inline error goes under the title. */
function TextRow({
  title,
  hint,
  off,
  ...p
}: Parameters<typeof useTextSetting>[0] & { title: ReactNode; hint?: ReactNode; off?: boolean }) {
  const { input, error } = useTextSetting(p);
  return (
    <Row htmlFor={p.id} title={title} hint={hint} off={off} error={error} errorId={`${p.id}-error`}>
      {input}
    </Row>
  );
}

function BasicSettings({ s }: { s: Settings }) {
  const t = useT();
  const { off, update } = useUpdate();
  return (
    <>
      <Group id="general" title={t('set.group.general')}>
        <Row htmlFor="lang" title={t('set.language')}>
          <select
            id="lang"
            value={s.language}
            disabled={off}
            onChange={(e) => void update({ language: e.currentTarget.value as Language })}
          >
            <option value="en">English</option>
            <option value="ru">Русский</option>
          </select>
          <SavedMark field="language" />
        </Row>
        <Row htmlFor="transport" title={<Title text={t('set.transport')} next />}>
          <select
            id="transport"
            value={s.transport}
            disabled={off}
            onChange={(e) => void update({ transport: e.currentTarget.value as TransportChoice })}
          >
            <option value="hoppie">{t('set.transport.hoppie')}</option>
            <option value="offline">{t('set.transport.offline')}</option>
          </select>
          <SavedMark field="transport" />
        </Row>
        <Row htmlFor="sound" title={t('set.sound')} hint={<Hint text={t('set.soundHint')} />}>
          <button type="button" className="btn" onClick={() => playMessageSound()}>
            {t('set.soundTest')}
          </button>
          <SwitchInput
            id="sound"
            checked={s.soundOnMessage}
            disabled={off}
            onChange={(v) => void update({ soundOnMessage: v })}
          />
          <SavedMark field="soundOnMessage" />
        </Row>
        <SettingSwitch s={s} k="messageHints" title={t('set.hints')} hint={t('set.hintsHint')} />
      </Group>

      <Group id="messages" title={t('set.group.messages')}>
        <Row
          htmlFor="gap"
          title={<Title text={t('set.gap')} next />}
          hint={<Hint text={t('set.gapHint')} />}
        >
          <select
            id="gap"
            value={s.messageGapSec}
            disabled={off}
            onChange={(e) => void update({ messageGapSec: Number(e.currentTarget.value) })}
          >
            {GAPS.includes(s.messageGapSec) ? null : (
              <option value={s.messageGapSec}>{s.messageGapSec}</option>
            )}
            {GAPS.map((g) => (
              <option key={g} value={g}>
                {g === 0 ? t('set.gapNone') : t('set.gapSec', { s: g })}
              </option>
            ))}
          </select>
          <SavedMark field="messageGapSec" />
        </Row>
        <SettingSwitch
          s={s}
          k="turnaround"
          title={t('set.turnaround')}
          hint={t('set.turnaroundHint')}
          next
        />
      </Group>

      <Group id="data" title={t('set.group.data')}>
        <SettingSwitch
          s={s}
          k="liveData"
          title={t('set.liveData')}
          hint={t('set.liveDataHint')}
          next
        />
        <p className="sheet-note">
          <strong>{t('set.special')}</strong> {t('set.specialHint')}
        </p>
        {(['specialSport', 'specialAviation', 'specialOther'] as const).map((key) => (
          <SettingSwitch key={key} s={s} k={key} title={t(`set.${key}`)} next />
        ))}
      </Group>

      <Group id="xatc" title={t('set.group.xatc')}>
        <SettingSwitch s={s} k="xatc" title={t('set.xatc')} hint={t('set.xatcHint')} next />
        <SettingSwitch
          s={s}
          k="xatcStandAside"
          title={t('set.xatcStandAside')}
          hint={t('set.xatcStandAsideHint')}
          next
          disabled={!s.xatc}
          offHint={t('set.offXatc')}
        />
        <SettingSwitch
          s={s}
          k="xatcRandomDirects"
          title={t('set.xatcRandomDirects')}
          hint={t('set.xatcRandomDirectsHint')}
          next
          disabled={!s.xatc}
          offHint={t('set.offXatc')}
        />
      </Group>
    </>
  );
}

function AdvancedSettings({ s }: { s: Settings }) {
  const t = useT();
  const { off, update } = useUpdate();
  const openRecordings = useStore((st) => st.openRecordings);
  const clearMemory = useStore((st) => st.clearMemory);
  const memory = useStore((st) => st.app?.memory ?? []);
  const running = useStore((st) => st.app?.session === 'running');
  const titles = (v: string) =>
    v
      .split('\n')
      .map((x) => x.trim())
      .filter((x) => x !== '');
  return (
    <>
      <Group id="time" title={t('set.group.time')}>
        <SettingSwitch
          s={s}
          k="simTime"
          title={t('set.simTime')}
          hint={t('set.simTimeHint')}
          next
        />
        <TextRow
          id="hub-icao"
          field="hubIcao"
          title={<Title text={t('set.hubIcao')} next />}
          hint={<Hint text={t('set.hubIcaoHint')} />}
          className="caps short"
          maxLength={4}
          value={s.hubIcao}
          normalize={(v) => v.trim().toUpperCase()}
          check={(v) => (/^(?:[A-Z]{4})?$/.test(v) ? null : t('set.badHub'))}
          save={(v) => void update({ hubIcao: v })}
          disabled={off}
        />
      </Group>

      <Group id="datalink" title={t('set.group.datalink')}>
        <SettingSwitch
          s={s}
          k="datalink"
          title={t('set.datalink')}
          hint={t('set.datalinkHint')}
          next
        />
        <SettingSwitch
          s={s}
          k="datalinkSatcom"
          title={t('set.datalinkSatcom')}
          next
          disabled={!s.datalink}
          offHint={t('set.offDatalink')}
        />
        <SettingSwitch
          s={s}
          k="datalinkHeaderInText"
          title={t('set.datalinkHeaderInText')}
          next
          disabled={!s.datalink}
          offHint={t('set.offDatalink')}
        />
        <TextRow
          id="icao-hex"
          field="aircraftIcaoHex"
          title={<Title text={t('set.aircraftIcaoHex')} next />}
          hint={
            <Hint
              text={t('set.aircraftIcaoHexHint')}
              off={s.datalink ? undefined : t('set.offDatalink')}
            />
          }
          off={!s.datalink}
          className="caps short"
          maxLength={6}
          value={s.aircraftIcaoHex}
          normalize={(v) => v.trim().toUpperCase()}
          check={(v) => (/^(?:[0-9A-F]{6})?$/.test(v) ? null : t('set.badHex'))}
          save={(v) => void update({ aircraftIcaoHex: v })}
          disabled={off || !s.datalink}
        />
      </Group>

      <Group id="rescue" title={t('set.group.rescue')}>
        <SettingSwitch s={s} k="rescue" title={t('set.rescue')} hint={t('set.rescueHint')} />
        <Row
          htmlFor="siren"
          title={t('set.rescueSiren')}
          hint={
            <Hint text={t('set.rescueSirenHint')} off={s.rescue ? undefined : t('set.offRescue')} />
          }
          off={!s.rescue}
        >
          <button type="button" className="btn" onClick={() => testSiren()}>
            {t('set.soundTest')}
          </button>
          <SwitchInput
            id="siren"
            checked={s.rescueSiren}
            disabled={off || !s.rescue}
            onChange={(v) => void update({ rescueSiren: v })}
          />
          <SavedMark field="rescueSiren" />
        </Row>
        <p className={s.rescue ? 'sheet-note' : 'sheet-note off'}>
          {s.rescue ? t('set.rescueTitlesHint') : t('set.offRescue')}
        </p>
        {RESCUE_TITLE_GROUPS.map((g) => (
          <Row key={g} htmlFor={`rescue-${g}`} title={t(`set.rescue.${g}`)} off={!s.rescue}>
            <textarea
              id={`rescue-${g}`}
              rows={2}
              spellCheck={false}
              // A new key after a save or a reset puts the stored list back in the field.
              key={s.rescueTitles[g].join('\n')}
              defaultValue={s.rescueTitles[g].join('\n')}
              disabled={off || !s.rescue}
              onBlur={(e) => {
                const list = titles(e.currentTarget.value);
                if (list.join('\n') !== s.rescueTitles[g].join('\n')) {
                  void update({ rescueTitles: { ...s.rescueTitles, [g]: list } }, `rescue-${g}`);
                }
              }}
            />
            <SavedMark field={`rescue-${g}`} />
          </Row>
        ))}
        <Row
          htmlFor="rescue-flipped"
          title={t('set.rescueFlipped')}
          hint={<Hint text={t('set.rescueFlippedHint')} />}
          off={!s.rescue}
        >
          <textarea
            id="rescue-flipped"
            rows={2}
            spellCheck={false}
            key={s.rescueFlipped.join('\n')}
            defaultValue={s.rescueFlipped.join('\n')}
            disabled={off || !s.rescue}
            onBlur={(e) => {
              const list = titles(e.currentTarget.value);
              if (list.join('\n') !== s.rescueFlipped.join('\n')) {
                void update({ rescueFlipped: list });
              }
            }}
          />
          <SavedMark field="rescueFlipped" />
        </Row>
        <Row title={t('set.rescueDefaults')} off={!s.rescue}>
          <button
            type="button"
            className="btn"
            disabled={off || !s.rescue}
            onClick={() =>
              void update(
                { rescueTitles: DEFAULT_RESCUE_TITLES, rescueFlipped: DEFAULT_RESCUE_FLIPPED },
                'rescueReset',
              )
            }
          >
            {t('set.rescueReset')}
          </button>
          <SavedMark field="rescueReset" />
        </Row>
      </Group>

      <Group id="records" title={t('set.group.records')}>
        <Row
          htmlFor="record"
          title={<Title text={t('set.record')} next />}
          hint={<Hint text={t('set.recordHint')} />}
        >
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
            checked={s.recordFlights}
            disabled={off}
            onChange={(v) => void update({ recordFlights: v })}
          />
          <SavedMark field="recordFlights" />
        </Row>
        <Row
          title={
            memory.length === 0
              ? t('set.memoryEmpty')
              : t('set.memory', { names: memory.join(', ') })
          }
          hint={<Hint text={t('set.memoryHint')} />}
        >
          <button
            type="button"
            className="btn danger"
            disabled={off || running || memory.length === 0}
            title={running ? t('why.stop_flight_first') : undefined}
            onClick={() => {
              if (window.confirm(t('set.clearMemoryConfirm', { names: memory.join(', ') }))) {
                void clearMemory();
              }
            }}
          >
            {t('set.clearMemory')}
          </button>
        </Row>
      </Group>

      <Group id="conn" title={t('set.group.connection')}>
        <TextRow
          id="station"
          field="stationTemplate"
          title={<Title text={t('set.station')} next />}
          hint={<Hint text={t('set.stationHint')} />}
          maxLength={32}
          value={s.stationTemplate}
          check={(v) => (v !== '' && STATION_RE.test(v) ? null : t('set.badStation'))}
          save={(v) => void update({ stationTemplate: v })}
          disabled={off}
        />
        <TextRow
          id="port"
          field="bridgePort"
          title={t('set.bridgePort')}
          className="short"
          maxLength={5}
          inputMode="numeric"
          value={String(s.bridgePort)}
          check={(v) => {
            const n = Number(v);
            return /^\d+$/.test(v) && n >= 1024 && n <= 65535 ? null : t('set.badPort');
          }}
          save={(v) => void update({ bridgePort: Number(v) })}
          disabled={off}
        />
      </Group>
    </>
  );
}
