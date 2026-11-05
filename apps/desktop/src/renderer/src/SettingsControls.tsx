// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { type ReactNode, useState } from 'react';
import {
  LANGUAGE_CHOICES,
  LANGUAGES,
  type Language,
  type Settings,
  type SettingsPatch,
} from '../../shared/api.js';
import { firstSentence } from './hints.js';
import { Switch } from './Switch.js';
import { useStore } from './store.js';
import { useT } from './ui.js';

/** Building blocks of the settings page (T56): groups, rows, hints, marks and setting controls. */

/** A titled light sheet of rows, like grouped settings on iOS. */
export function Group({ id, title, children }: { id: string; title: string; children: ReactNode }) {
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
export function Hint({
  text,
  link,
  off,
}: {
  text: string;
  link?: ReactNode;
  off?: string | undefined;
}) {
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
export function NextFlight() {
  const t = useT();
  const running = useStore((s) => s.app?.session === 'running');
  return (
    <span className={running ? 'tag next live' : 'tag next'} title={t('set.nextFlightTitle')}>
      {t('set.nextFlight')}
    </span>
  );
}

/** Title with the optional "next flight" tag. */
export function Title({ text, next }: { text: ReactNode; next?: boolean | undefined }) {
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
export function SavedMark({ field }: { field: string }) {
  const t = useT();
  const saved = useStore((s) => s.saved === 'settings' && s.savedField === field);
  return saved ? (
    <span className="saved" role="status">
      ✓ {t('set.saved')}
    </span>
  ) : null;
}

/** One sheet row: title and hint on the left, the control on the right; `off` dims it (U-13). */
/**
 * The options of a language list (settings, welcome; T85): the ready languages by their own names, a
 * machine translation is not marked; the current language stays listed even when it is not ready.
 */
export function LanguageOptions({ current }: { current: Language }) {
  const list = LANGUAGE_CHOICES.includes(current)
    ? LANGUAGE_CHOICES
    : [...LANGUAGE_CHOICES, current];
  return list.map((l) => {
    const info = LANGUAGES[l];
    return (
      <option key={l} value={l} lang={l}>
        {info.name}
      </option>
    );
  });
}

export function Row({
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

export function Saved({ what }: { what: 'username' | 'code' | 'adbKey' }) {
  const t = useT();
  const saved = useStore((s) => s.saved === what);
  return saved ? (
    <span className="saved" role="status">
      ✓ {t('set.saved')}
    </span>
  ) : null;
}

/** Result of a "Check" button (U-06). */
export function CheckedMark({ what }: { what: 'simbrief' | 'hoppie' }) {
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

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

/** Saving of one setting; false while another action runs. */
export function useUpdate() {
  const busy = useStore((s) => s.busy);
  const update = useStore((s) => s.updateSettings);
  return { off: busy !== null, update };
}

/** A switch row of a boolean setting with its "saved" mark. */
export function SettingSwitch({
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
export function useTextSetting({
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
export function TextRow({
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
