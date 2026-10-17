import type { CSSProperties } from 'react';
import { type FormEvent, useState } from 'react';
import type { AppState, FeedEntry, FlightSummary } from '../../shared/api.js';
import { atcHints } from '../../shared/atc-hints.js';
import { type Filter, MessageTable } from './FeedList.js';
import { phaseKey } from './i18n.js';
import { RequestDialog, type RequestKind } from './RequestDialog.js';
import { useStore } from './store.js';
import { num, useT, useUiText, zulu } from './ui.js';

/** FMS screen width without a flight plan: the narrowest profile. */
const DEFAULT_COLS = 24;

type Message = Exclude<FeedEntry, { kind: 'system' }>;

const isMessage = (e: FeedEntry): e is Message => e.kind !== 'system';

/** "Messages" screen of the mockup: toolbar + table, context column with the flight and the FMS. */
export function FlightView() {
  const t = useT();
  const app = useStore((s) => s.app) as AppState;
  const busy = useStore((s) => s.busy);
  const running = app.session === 'running';
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  // null = follow the newest message.
  const [picked, setPicked] = useState<string | null>(null);
  // Messages already there when the screen opened are not "new".
  const [seen, setSeen] = useState(() => new Set(app.feed.map((e) => e.id)));
  const [request, setRequest] = useState<RequestKind | null>(null);

  const messages = app.feed.filter(isMessage);
  const selected =
    messages.find((m) => m.id === picked) ?? (messages.length > 0 ? messages.at(-1) : undefined);
  const select = (id: string) => {
    // Picking the newest message goes back to following the newest one.
    setPicked(id === messages.at(-1)?.id ? null : id);
    setSeen((s) => (s.has(id) ? s : new Set(s).add(id)));
  };
  const counts: Record<Filter, number> = {
    all: app.feed.length,
    airline: app.feed.filter((e) => e.kind === 'outbound').length,
    pilot: app.feed.filter((e) => e.kind === 'inbound').length,
    system: app.feed.filter((e) => e.kind === 'system').length,
  };
  const disabledWhy = running ? undefined : t('req.notRunning');

  return (
    <div className="msg-layout">
      <section className="workspace" aria-label={t('page.flight')}>
        <div className="toolbar">
          <div className="filters" role="tablist" aria-label={t('filter.label')}>
            {(['all', 'airline', 'pilot', 'system'] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={f === filter}
                className={f === filter ? 'tab active' : 'tab'}
                onClick={() => setFilter(f)}
              >
                {t(`filter.${f}`)}
                <span className="tab-count">{counts[f]}</span>
              </button>
            ))}
          </div>
          <span className="toolbar-gap" />
          <label className="search">
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
            <span className="sr-only">{t('search.label')}</span>
            <input
              type="search"
              placeholder={t('search.placeholder')}
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
            />
          </label>
        </div>
        <div className="toolbar">
          <button
            type="button"
            className="btn primary"
            disabled={!running || busy !== null}
            title={disabledWhy}
            onClick={() => setRequest('text')}
          >
            {t('toolbar.new')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!running || busy !== null}
            title={disabledWhy}
            onClick={() => setRequest('wx')}
          >
            {t('toolbar.request')}
          </button>
          {running && app.irregular.length > 0 && <ForceForm list={app.irregular} />}
        </div>
        <MessageTable
          entries={app.feed}
          filter={filter}
          query={query}
          selectedId={selected?.id ?? null}
          seen={seen}
          onSelect={select}
        />
      </section>
      <aside className="context" aria-label={t('ctx.label')}>
        <FlightCard app={app} />
        <FmsPanel
          messages={messages}
          selected={selected}
          cols={app.flight?.lineWidth ?? DEFAULT_COLS}
          running={running}
          onSelect={select}
        />
      </aside>
      {request !== null && (
        <RequestDialog
          initial={request}
          destination={app.flight?.destination ?? ''}
          onClose={() => setRequest(null)}
        />
      )}
    </div>
  );
}

/**
 * iniBuilds A350/A380 fetch Hoppie telexes only after a flight plan request in the FMS
 * (docs/06, human check 2026-10-08).
 */
function needsFplnRequest(title: string | undefined): boolean {
  return title !== undefined && /\bA3(50|5K|80)|A350|A380|A35K/i.test(title);
}

function FlightCard({ app }: { app: AppState }) {
  const t = useT();
  const busy = useStore((s) => s.busy);
  const creds = useStore((s) => s.creds);
  const settings = useStore((s) => s.settings);
  const { loadOfp, startFlight, stopFlight, endFlight } = useStore.getState();
  const running = app.session === 'running';
  const f = app.flight;
  const offline = settings?.transport === 'offline';
  const needCode = !offline && creds?.hoppieCodeSet === false;
  const tm = app.telemetry;

  return (
    <section className="panel" aria-labelledby="flight-title">
      <div className="panel-head">
        <h2 id="flight-title" className="panel-title">
          {t('flight.title')}
        </h2>
        {f !== null && (
          <span className="panel-sub">
            {f.callsign} · {f.aircraftIcao}
            {f.aircraftReg === null ? '' : ` · ${f.aircraftReg}`}
          </span>
        )}
      </div>
      {f === null ? (
        <p className="muted">{t('flight.none')}</p>
      ) : (
        <Summary f={f} phase={running && app.phase !== null ? t(phaseKey(app.phase)) : null} />
      )}
      {running && (
        <dl className="params">
          <Param k="ALT" v={tm === null ? '—' : num(tm.altFt)} unit="FT" />
          <Param k="VS" v={tm === null ? '—' : num(tm.vsFpm)} unit="FPM" />
          <Param k="GS" v={tm === null ? '—' : num(tm.gsKt)} unit="KT" />
          <Param k="FOB" v={tm === null ? '—' : num(tm.fuelKg)} unit="KG" />
        </dl>
      )}
      {running && tm !== null && (
        <p className="hint">
          {tm.aircraftTitle}
          {tm.onGround ? ` · ${t('tm.ground')}` : ''}
        </p>
      )}
      {running && tm === null && <p className="hint">{t('tm.none')}</p>}

      {creds?.simbriefUsername === '' && <p className="hint warn">{t('flight.needUsername')}</p>}
      {f !== null && !running && needCode && <p className="hint warn">{t('flight.needCode')}</p>}
      {f !== null && (running || !needCode) && (
        <p className="hint">
          {offline
            ? t('flight.offlineHint')
            : t('flight.fmsHint', { callsign: f.callsign, station: f.station })}
        </p>
      )}
      {running && needsFplnRequest(tm?.aircraftTitle) && (
        <p className="hint warn">{t('flight.fplnHint')}</p>
      )}
      {running &&
        atcHints({
          atc: app.atc,
          aircraftTitle: tm?.aircraftTitle,
          phase: app.phase,
          callsign: f?.callsign ?? null,
        }).map((h) => (
          <p key={h.key} className="hint">
            {t(h.key, h.params)}
          </p>
        ))}

      {running && app.phase === 'ON_BLOCK' && (
        <div className="end-flight">
          <p className="hint">{t('flight.endHint')}</p>
          <div className="row">
            <button
              type="button"
              className="btn primary"
              disabled={busy !== null}
              onClick={() => void endFlight('TURNAROUND')}
            >
              {t('flight.turnaround')}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() => void endFlight('DONE')}
            >
              {t('flight.done')}
            </button>
          </div>
        </div>
      )}

      <div className="row actions">
        {running ? (
          <button
            type="button"
            className="btn danger"
            disabled={busy !== null}
            onClick={() => {
              if (window.confirm(t('flight.stopConfirm'))) void stopFlight();
            }}
          >
            {t('flight.stop')}
          </button>
        ) : (
          <>
            <button
              type="button"
              className={f === null ? 'btn primary' : 'btn'}
              disabled={busy !== null || creds?.simbriefUsername === ''}
              onClick={() => void loadOfp()}
            >
              {busy === 'load' ? '…' : t(f === null ? 'flight.load' : 'flight.reload')}
            </button>
            {f !== null && (
              <button
                type="button"
                className="btn primary"
                disabled={busy !== null || needCode}
                onClick={() => void startFlight()}
              >
                {t('flight.start')}
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function Summary({ f, phase }: { f: FlightSummary; phase: string | null }) {
  const t = useT();
  return (
    <div className="route-block">
      <div className="route">
        <span>{f.origin}</span>
        <span className="route-line" aria-hidden="true" />
        <span>{f.destination}</span>
      </div>
      <div className="route-meta">
        <span>STD {zulu(f.schedOutMs)}</span>
        <span>{phase ?? t('flight.profileValue', { id: f.profileId, width: f.lineWidth })}</span>
        <span>STA {zulu(f.schedInMs)}</span>
      </div>
    </div>
  );
}

function Param({ k, v, unit }: { k: string; v: string; unit: string }) {
  return (
    <div>
      <dt>{k}</dt>
      <dd>
        {v}
        <span className="param-unit"> {unit}</span>
      </dd>
    </div>
  );
}

/** "Run now" for an irregular scenario of the running flight; the result goes to the feed. */
function ForceForm({ list }: { list: AppState['irregular'] }) {
  const t = useT();
  const busy = useStore((s) => s.busy);
  const text = useUiText();
  const [id, setId] = useState(list[0]?.id ?? '');
  const current = list.some((x) => x.id === id) ? id : (list[0]?.id ?? '');
  return (
    <form
      className="force-form"
      title={t('force.hint')}
      onSubmit={(e) => {
        e.preventDefault();
        if (current !== '') void useStore.getState().forceScenario(current);
      }}
    >
      <label htmlFor="force-id" className="force-label">
        {t('force.label')}
      </label>
      <select id="force-id" value={current} onChange={(e) => setId(e.currentTarget.value)}>
        {list.map((s) => (
          <option key={s.id} value={s.id}>
            {text(s.title)}
          </option>
        ))}
      </select>
      <button type="submit" className="btn" disabled={busy !== null || current === ''}>
        {t('force.run')}
      </button>
    </form>
  );
}

/** `left` and `right` on one screen line of `cols` characters. */
function pad(left: string, right: string, cols: number): string {
  return left + ' '.repeat(Math.max(1, cols - left.length - right.length)) + right;
}

/**
 * The FMS screen (fms.css): the selected message as the aircraft shows it, PREV/NEXT on the bezel,
 * and the scratchpad that sends a pilot telex (T12).
 */
function FmsPanel({
  messages,
  selected,
  cols,
  running,
  onSelect,
}: {
  messages: readonly Message[];
  selected: Message | undefined;
  cols: number;
  running: boolean;
  onSelect: (id: string) => void;
}) {
  const t = useT();
  const index = selected === undefined ? -1 : messages.indexOf(selected);
  const go = (step: number) => {
    const next = messages[index + step];
    if (next !== undefined) onSelect(next.id);
  };
  const screen = { '--fms-cols': cols } as CSSProperties;
  return (
    <section className="panel fms-panel" aria-labelledby="fms-title">
      <div className="panel-head">
        <h2 id="fms-title" className="panel-title">
          {t('fms.title')}
        </h2>
        <span className="panel-sub">{t('fms.width', { n: cols })}</span>
      </div>
      <div className="fms fms-bezel" style={screen}>
        <div className="fms__screen fms-body">
          {selected === undefined ? (
            <div className="fms__line--dim">{pad('ACARS MSG', '0/0', cols)}</div>
          ) : (
            <>
              <div>
                {pad(
                  selected.kind === 'outbound' ? 'ACARS MSG' : 'PILOT MSG',
                  `${index + 1}/${messages.length}`,
                  cols,
                )}
              </div>
              <div className="fms__line--sm">{pad('FROM', 'TIME', cols)}</div>
              <div>{pad(selected.from, zulu(selected.t), cols)}</div>
              <div className="fms__rule">{'-'.repeat(cols)}</div>
              <pre className="fms-text">{selected.text}</pre>
            </>
          )}
          {running && <Scratchpad />}
        </div>
        <div className="fms-keys">
          <button type="button" className="fms-key" disabled={index <= 0} onClick={() => go(-1)}>
            PREV
          </button>
          <button
            type="button"
            className="fms-key"
            disabled={index < 0 || index >= messages.length - 1}
            onClick={() => go(1)}
          >
            NEXT
          </button>
        </div>
      </div>
    </section>
  );
}

/** `[ ENTER MESSAGE ]` — a pilot telex typed in the app (aircraft without free-text telex, tests). */
function Scratchpad() {
  const t = useT();
  const busy = useStore((s) => s.busy);
  // In the store, not local state: a half-typed telex survives a tab switch.
  const text = useStore((s) => s.draft);
  const setText = useStore((s) => s.setDraft);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (text.trim() === '' || busy !== null) return;
    const sent = text;
    // Cleared only if nothing new was typed while it was being sent.
    if (await useStore.getState().sendPilotMessage(sent)) {
      if (useStore.getState().draft === sent) setText('');
    }
  };
  return (
    <form className="fms__scratch" onSubmit={(e) => void submit(e)} title={t('pilot.hint')}>
      <span aria-hidden="true">[</span>
      <input
        type="text"
        aria-label={t('pilot.label')}
        maxLength={200}
        autoComplete="off"
        spellCheck={false}
        placeholder="ENTER MESSAGE"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <span aria-hidden="true">]</span>
    </form>
  );
}
