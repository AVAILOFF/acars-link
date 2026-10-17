import { useState } from 'react';
import type { Delivery, FeedEntry } from '../../shared/api.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { systemText } from './i18n.js';
import { useStore } from './store.js';
import { useT, useUiText, zulu } from './ui.js';

export type Filter = 'all' | 'airline' | 'pilot' | 'system';

const KIND: Record<Exclude<Filter, 'all'>, FeedEntry['kind']> = {
  airline: 'outbound',
  pilot: 'inbound',
  system: 'system',
};

/** Delivery state → pill tone (design/spec.md §4, "Статус-пилюля"). */
function tone(d: Delivery): 'ok' | 'caution' | 'error' {
  return d === 'sent' ? 'ok' : d === 'queued' || d === 'retry' ? 'caution' : 'error';
}

interface Row {
  readonly e: FeedEntry;
  readonly from: string;
  readonly type: string;
  readonly subject: string;
  readonly preview: string;
}

/** First line of a telex as the subject, the rest flattened as the preview. */
function split(text: string): [string, string] {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  return [lines[0] ?? '', lines.slice(1).join(' ')];
}

/**
 * The message table on a light sheet (ScreenMain): newest first, filter tabs and search above it.
 * A click picks the message for the FMS screen.
 */
export function MessageTable({
  entries,
  filter,
  query,
  selectedId,
  seen,
  onSelect,
}: {
  entries: readonly FeedEntry[];
  filter: Filter;
  query: string;
  selectedId: string | null;
  seen: ReadonlySet<string>;
  onSelect: (id: string) => void;
}) {
  const t = useT();
  const uiText = useUiText();
  const scenarios = useStore((s) => s.scenarios);
  // Entries already there when the table appeared are not highlighted as new.
  const [initial] = useState(() => new Set(entries.map((e) => e.id)));
  const title = (id: string): string | null => {
    const s = scenarios?.find((x) => x.id === id);
    return s === undefined ? null : uiText(s.titleText);
  };

  const rows: Row[] = [...entries].reverse().map((e) => {
    if (e.kind === 'system') {
      return { e, from: 'SYS', type: 'SYS', subject: systemText(t, e.code, e.params), preview: '' };
    }
    const [first, rest] = split(e.text);
    if (e.kind === 'outbound') {
      const name = title(e.scenarioId);
      return {
        e,
        from: e.from,
        type: 'TELEX',
        subject: name ?? first,
        preview: name === null ? rest : [first, rest].filter((x) => x !== '').join(' '),
      };
    }
    return { e, from: e.from, type: e.type.toUpperCase(), subject: first, preview: rest };
  });
  const q = query.trim().toUpperCase();
  const shown = rows.filter(
    (r) =>
      (filter === 'all' || r.e.kind === KIND[filter]) &&
      (q === '' ||
        `${r.from} ${r.type} ${r.subject} ${r.preview} ${r.e.kind === 'outbound' ? r.e.scenarioId : ''}`
          .toUpperCase()
          .includes(q)),
  );

  return (
    <div className="sheet table-sheet">
      {entries.length === 0 ? (
        <p className="sheet-empty">{t('feed.empty')}</p>
      ) : (
        <table className="msg-table">
          <thead>
            <tr>
              <th scope="col" className="col-dot">
                <span className="sr-only">{t('msg.unread')}</span>
              </th>
              <th scope="col" className="col-time">
                UTC
              </th>
              <th scope="col" className="col-from">
                {t('col.from')}
              </th>
              <th scope="col" className="col-type">
                {t('col.type')}
              </th>
              <th scope="col">{t('col.content')}</th>
              <th scope="col" className="col-status">
                {t('col.status')}
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <ErrorBoundary
                key={r.e.id}
                resetKey={r.e.id}
                fallback={
                  <tr>
                    <td colSpan={6}>{r.e.id}</td>
                  </tr>
                }
              >
                <MessageRow
                  r={r}
                  selected={r.e.id === selectedId}
                  unread={r.e.kind !== 'system' && !seen.has(r.e.id)}
                  fresh={!initial.has(r.e.id)}
                  onSelect={onSelect}
                />
              </ErrorBoundary>
            ))}
          </tbody>
        </table>
      )}
      {entries.length > 0 && shown.length === 0 && (
        <p className="sheet-empty">{t('search.none')}</p>
      )}
    </div>
  );
}

function MessageRow({
  r,
  selected,
  unread,
  fresh,
  onSelect,
}: {
  r: Row;
  selected: boolean;
  unread: boolean;
  fresh: boolean;
  onSelect: (id: string) => void;
}) {
  const t = useT();
  const { e } = r;
  const failed = e.kind === 'outbound' && (e.delivery === 'failed' || e.delivery === 'dropped');
  const cls = [
    'msg-row',
    e.kind,
    selected ? 'selected' : '',
    failed ? 'error' : '',
    fresh ? 'fresh' : '',
    unread ? 'unread' : '',
  ]
    .filter((c) => c !== '')
    .join(' ');
  const pick = e.kind === 'system' ? undefined : () => onSelect(e.id);
  return (
    <tr className={cls} onClick={pick} aria-selected={e.kind === 'system' ? undefined : selected}>
      <td className="col-dot">
        {unread && <span className="unread-dot" role="img" aria-label={t('msg.unread')} />}
      </td>
      <td className="col-time">{zulu(e.t)}</td>
      <td className="col-from">
        <span className={e.kind === 'system' ? 'chip muted-chip' : 'chip'}>{r.from}</span>
      </td>
      <td className={`col-type ${e.kind}`}>{r.type}</td>
      <td className="col-content">
        {pick === undefined ? (
          <span className="subject">{r.subject}</span>
        ) : (
          <button
            type="button"
            className="subject"
            onClick={(ev) => {
              ev.stopPropagation(); // the row would pick it a second time
              pick();
            }}
          >
            {r.subject}
          </button>
        )}
        {r.preview !== '' && <span className="preview">{r.preview}</span>}
      </td>
      <td className="col-status">
        {e.kind === 'outbound' ? (
          <span
            className={`pill ${tone(e.delivery)}`}
            title={e.detail === null ? undefined : e.detail}
          >
            {t(`delivery.${e.delivery}`)}
          </span>
        ) : e.kind === 'inbound' ? (
          <span className="status-word">{t('feed.pilot')}</span>
        ) : (
          <span className="status-word">{t('msg.info')}</span>
        )}
      </td>
    </tr>
  );
}
