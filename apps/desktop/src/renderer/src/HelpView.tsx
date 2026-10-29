// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { useState } from 'react';
import { HELP, type HelpBlock, searchHelp } from './help.js';
import { useStore } from './store.js';
import { useT } from './ui.js';

/** The "Help" tab: a manual and FAQ as folding questions; "Getting started" is open at first. */
export function HelpView() {
  const t = useT();
  const lang = useStore((s) => s.settings?.language ?? 'en');
  const [query, setQuery] = useState('');
  const sections = searchHelp(HELP[lang], query);
  const searching = query.trim() !== '';
  const { openWelcome, setTour } = useStore.getState();

  return (
    <section className="page" aria-labelledby="help-title">
      <h2 id="help-title" className="page-title">
        {t('page.help')}
      </h2>
      <p className="hint">{t('help.hint')}</p>
      <div className="row help-intro">
        <button type="button" className="btn" onClick={openWelcome}>
          {t('help.welcome')}
        </button>
        <button type="button" className="btn" onClick={() => setTour(0)}>
          {t('help.tour')}
        </button>
      </div>
      <label className="search page-search">
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="M20 20l-4.8-4.8" />
        </svg>
        <span className="sr-only">{t('help.search')}</span>
        <input
          type="search"
          placeholder={t('help.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
      </label>
      {sections.length === 0 && <p className="hint">{t('help.none')}</p>}
      {sections.map((s) => (
        <section key={s.id} className="group" aria-labelledby={`help-${s.id}`}>
          <h3 id={`help-${s.id}`} className="group-title">
            {s.title}
          </h3>
          <div className="help-list">
            {s.items.map((i) => (
              // Keyed by the query too: a search opens the matches, clearing it folds them back.
              <details
                key={`${i.id}:${searching}`}
                className="help-item"
                open={searching || s.id === 'start'}
              >
                <summary>{i.q}</summary>
                <div className="help-answer">
                  {i.a.map((b, n) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: static text, never reordered
                    <Block key={n} block={b} />
                  ))}
                </div>
              </details>
            ))}
          </div>
        </section>
      ))}
    </section>
  );
}

function Block({ block }: { block: HelpBlock }) {
  if (typeof block === 'string') return <p>{block}</p>;
  if ('link' in block) {
    return (
      <p>
        <a href={block.href} target="_blank" rel="noreferrer">
          {block.link}
        </a>
      </p>
    );
  }
  const items = block.list.map((x) => <li key={x}>{x}</li>);
  return block.ordered === true ? <ol>{items}</ol> : <ul>{items}</ul>;
}
