import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { AppError } from '../../shared/api.js';
import { errorKey } from './i18n.js';
import { useStore } from './store.js';
import { useT } from './ui.js';

/**
 * The request sheet of the mockup (RequestModal). It only builds a pilot command the core already
 * understands (packages/core/src/scenario/pilot.ts) and sends it as a pilot telex (T12).
 */
export type RequestKind = 'wx' | 'atis' | 'gate' | 'loadsheet' | 'text';

const KINDS: readonly RequestKind[] = ['wx', 'atis', 'gate', 'loadsheet', 'text'];
const ICAO = /^[A-Z]{4}$/;

function command(kind: RequestKind, airport: string, text: string): string {
  switch (kind) {
    case 'wx':
      return `REQ WX ${airport}`.trim();
    case 'atis':
      return `REQ ATIS ${airport}`.trim();
    case 'gate':
      return 'REQ GATE';
    case 'loadsheet':
      return 'REQ LOADSHEET';
    case 'text':
      return text.trim().toUpperCase();
  }
}

export function RequestDialog({
  initial,
  destination,
  onClose,
}: {
  initial: RequestKind;
  destination: string;
  onClose: () => void;
}) {
  const t = useT();
  const busy = useStore((s) => s.busy);
  const ref = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<RequestKind>(initial);
  const [airport, setAirport] = useState(destination);
  const [text, setText] = useState('');
  // Why the last send failed: the error banner is behind the modal, so it is repeated here.
  const [failed, setFailed] = useState<AppError | null>(null);

  // A modal <dialog>: focus trap, inert background and Esc come from the browser.
  useEffect(() => {
    const d = ref.current;
    if (d !== null && !d.open) d.showModal();
  }, []);

  const needsAirport = kind === 'wx' || kind === 'atis';
  const icao = airport.trim().toUpperCase();
  const badAirport = needsAirport && icao !== '' && !ICAO.test(icao);
  const out = command(kind, needsAirport ? icao : '', text);
  const canSend = busy === null && out !== '' && !badAirport;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSend) return;
    setFailed(null);
    if (await useStore.getState().sendPilotMessage(out)) onClose();
    else setFailed(useStore.getState().error);
  };

  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby="req-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <form className="modal-sheet" onSubmit={(e) => void submit(e)}>
        <header className="modal-head">
          <span />
          <h2 id="req-title">{t(`req.title.${kind}`)}</h2>
          <button
            type="button"
            className="btn-round light"
            aria-label={t('req.close')}
            onClick={onClose}
          >
            ✕
          </button>
        </header>
        <fieldset className="segments">
          <legend className="sr-only">{t('req.kind')}</legend>
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={k === kind}
              className={k === kind ? 'segment active' : 'segment'}
              onClick={() => setKind(k)}
            >
              {t(`req.${k}`)}
            </button>
          ))}
        </fieldset>
        <div className="sheet modal-body">
          {needsAirport && (
            <div className={badAirport ? 'field-row invalid' : 'field-row'}>
              <label htmlFor="req-airport">{t('req.airport')}</label>
              <input
                id="req-airport"
                type="text"
                className="caps"
                maxLength={4}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={badAirport}
                aria-describedby="req-airport-hint"
                value={airport}
                onChange={(e) => setAirport(e.currentTarget.value)}
              />
              <span id="req-airport-hint" className="field-hint">
                {badAirport ? t('req.badAirport') : t('req.airportHint')}
              </span>
            </div>
          )}
          {kind === 'text' && (
            <div className="field-row">
              <label htmlFor="req-text">{t('req.text')}</label>
              <input
                id="req-text"
                type="text"
                className="caps"
                maxLength={200}
                autoComplete="off"
                spellCheck={false}
                placeholder={t('pilot.placeholder')}
                value={text}
                onChange={(e) => setText(e.currentTarget.value)}
              />
            </div>
          )}
          <div className="field-col">
            <span className="field-label">{t('req.preview')}</span>
            <div className="fms">
              <pre className="fms__screen modal-screen">{out === '' ? ' ' : out}</pre>
            </div>
            {failed === null ? (
              <span className="field-hint">{t('pilot.hint')}</span>
            ) : (
              <span className="field-hint" role="alert">
                {t(errorKey(failed.code), { detail: failed.detail })}
              </span>
            )}
          </div>
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            {t('req.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={!canSend}>
            {t('pilot.send')}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
