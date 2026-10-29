// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { useEffect, useRef } from 'react';
import type { ResumeOffer } from '../../shared/api.js';
import { errorText } from './i18n.js';
import { useStore } from './store.js';
import { useT } from './ui.js';

/**
 * T64: the flight the app lost (closed, crashed) is offered at the start. "Continue" restores it
 * from its recording; "Discard" leaves the recording and does not offer it again. Esc only hides
 * the question until the next start of the app.
 */
export function ResumeDialog({ offer }: { offer: ResumeOffer }) {
  const t = useT();
  const busy = useStore((s) => s.busy);
  const error = useStore((s) => s.error);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (d !== null && !d.open) d.showModal();
  }, []);

  const when = new Date(offer.writtenAt).toISOString().slice(11, 16);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby="resume-title"
      aria-describedby="resume-text"
      onCancel={(e) => {
        e.preventDefault();
        useStore.getState().hideResume();
      }}
    >
      <div className="modal-sheet">
        <header className="modal-head">
          <span />
          <h2 id="resume-title">
            {t('resume.title', {
              callsign: offer.callsign,
              origin: offer.origin,
              destination: offer.destination,
            })}
          </h2>
          <span />
        </header>
        <div className="sheet modal-body">
          <p id="resume-text">{t('resume.text', { time: when })}</p>
          <p className="field-hint">{t('resume.note')}</p>
          {error !== null && (
            <p className="field-hint invalid" role="alert">
              {errorText(t, error)}
            </p>
          )}
        </div>
        <footer className="modal-foot">
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => void useStore.getState().discardResume()}
          >
            {t('resume.discard')}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy !== null}
            onClick={() => void useStore.getState().resumeFlight()}
          >
            {t('resume.continue')}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
