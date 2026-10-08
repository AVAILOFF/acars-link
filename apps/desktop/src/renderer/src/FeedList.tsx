import type { FlightPhase } from '@acars/core';
import type { FeedEntry } from '../../shared/api.js';
import { phaseKey, systemKey } from './i18n.js';
import { useT, zulu } from './ui.js';

/** Newest first. Telexes are shown as the aircraft would show them (monospace, line by line). */
export function FeedList({ entries }: { entries: readonly FeedEntry[] }) {
  const t = useT();
  const list = [...entries].reverse();
  return (
    <>
      <h2 id="feed-title" className="panel-title">
        {t('feed.title')}
      </h2>
      {list.length === 0 ? (
        <p className="muted">{t('feed.empty')}</p>
      ) : (
        <ol className="feed">
          {list.map((e) => (
            <li key={e.id} className={`feed-item ${e.kind}`}>
              <Entry e={e} />
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function Entry({ e }: { e: FeedEntry }) {
  const t = useT();
  if (e.kind === 'system') {
    const params: Record<string, string> = { ...e.params };
    for (const k of ['from', 'to', 'phase'] as const) {
      const p = params[k];
      if (p !== undefined) params[k] = t(phaseKey(p as FlightPhase));
    }
    return (
      <div className="sys">
        <time className="mono">{zulu(e.t)}</time>
        <span>{t(systemKey(e.code), params)}</span>
      </div>
    );
  }
  const outbound = e.kind === 'outbound';
  return (
    <article>
      <header className="msg-head">
        <time className="mono">{zulu(e.t)}</time>
        <span className="mono strong">
          {e.from} → {e.to}
        </span>
        {outbound ? (
          <>
            <span className="tag">{e.scenarioId}</span>
            <span className={`delivery ${e.delivery}`}>
              {t(`delivery.${e.delivery}`)}
              {e.detail === null ? '' : ` — ${e.detail}`}
            </span>
          </>
        ) : (
          <span className="tag pilot">
            {t('feed.pilot')} · {e.type}
          </span>
        )}
      </header>
      <pre className="telex">{e.text}</pre>
    </article>
  );
}
