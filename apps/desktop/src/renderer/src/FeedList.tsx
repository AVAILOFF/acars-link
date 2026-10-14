import type { FeedEntry } from '../../shared/api.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { systemText } from './i18n.js';
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
              <ErrorBoundary resetKey={e.id} fallback={<p className="muted mono">{e.id}</p>}>
                <Entry e={e} />
              </ErrorBoundary>
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
    return (
      <div className="sys">
        <time className="mono">{zulu(e.t)}</time>
        <span>{systemText(t, e.code, e.params)}</span>
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
