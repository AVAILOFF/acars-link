// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { ReactNode } from 'react';
import { LEGAL_DOCS, type LegalDoc } from '../../shared/api.js';
import { type DataSource, sourceById, sourcesFor } from '../../shared/sources.js';
import type { MessageKey } from './messages-en.js';
import { Row } from './SettingsControls.js';
import { useStore } from './store.js';
import { useT } from './ui.js';

/**
 * "About" on the Help tab (T74): versions, the licence in short, and the one list of the data
 * sources and components with their licences and the credits their terms ask for.
 */
export function AboutSection() {
  const t = useT();
  const lang = useStore((s) => s.settings?.language ?? 'en');
  const about = useStore((s) => s.about);
  const bridge = useStore((s) => s.app?.bridge.version ?? null);
  const openLegal = useStore((s) => s.openLegal);
  const sources = sourcesFor(about?.variant ?? 'public');
  const none = t('about.none');

  return (
    <section className="group" aria-labelledby="about-title">
      <h3 id="about-title" className="group-title">
        {t('about.title')}
      </h3>
      <div className="sheet">
        <Row title={t('about.app')}>
          <span className="about-value">
            {about === null || about.version === '' ? none : about.version}
            {about?.dev === true && ` (${t('about.dev')})`}
          </span>
        </Row>
        <Row title={t('about.bridge')}>
          <span className="about-value">{bridge ?? t('about.bridgeNone')}</span>
        </Row>
        <Row title="Electron">
          <span className="about-value">
            {about === null || about.electron === '' ? none : about.electron}
          </span>
        </Row>
        <Row title={t('about.build')}>
          <span className="about-value">
            {about === null ? none : t(`about.build.${about.variant}`)}
          </span>
        </Row>
      </div>

      <div className="sheet about-block">
        <p className="sheet-note">
          <strong>{t('about.licence')}</strong> {t('about.licenceText')}
        </p>
        <div className="sheet-actions">
          {LEGAL_DOCS.map((doc) => (
            <button key={doc} type="button" className="btn" onClick={() => void openLegal(doc)}>
              {t(OPEN_KEYS[doc])}
            </button>
          ))}
        </div>
      </div>

      <h3 id="about-sources" className="group-title">
        {t('about.sources')}
      </h3>
      <p className="hint">{t('about.sourcesHint')}</p>
      {(['service', 'bundled'] as const).map((kind) => (
        <section key={kind} className="sheet about-block" aria-labelledby={`about-${kind}`}>
          <p className="sheet-note">
            <strong id={`about-${kind}`}>{t(`about.kind.${kind}`)}</strong>
          </p>
          {sources
            .filter((s) => s.kind === kind)
            .map((s) => (
              <SourceRow key={s.id} source={s} lang={lang} />
            ))}
        </section>
      ))}
    </section>
  );
}

const OPEN_KEYS = {
  eula: 'about.open.eula',
  notices: 'about.open.notices',
  licenses: 'about.open.licenses',
} as const satisfies Record<LegalDoc, string>;

function SourceRow({ source, lang }: { source: DataSource; lang: 'en' | 'ru' }) {
  const t = useT();
  return (
    <Row
      title={source.name}
      hint={
        <>
          {source.what[lang]} · {source.license[lang]}
          {source.credit !== null && (
            <span className="row-credit">
              {t('about.credit')}: <CreditText source={source} />
            </span>
          )}
        </>
      }
    />
  );
}

/**
 * The credit a source's terms ask for, in the settings group that uses its data (T74); `label` says
 * what the data is used for. The credit text itself is never translated or shortened.
 */
export function SourceCredit({ id, label }: { id: string; label: MessageKey }) {
  const t = useT();
  const source = sourceById(id);
  return (
    <p className="sheet-note credit">
      {t(label)}: <CreditText source={source} />
    </p>
  );
}

/** The credit line exactly as the source's terms word it; a link to its terms when we know one. */
export function CreditText({ source }: { source: DataSource }): ReactNode {
  if (source.credit === null) return null;
  if (source.url === undefined) return source.credit;
  return (
    <a href={source.url} target="_blank" rel="noreferrer">
      {source.credit}
    </a>
  );
}
