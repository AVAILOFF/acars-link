// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { ScenarioCategory } from '@acars/core';
import { useEffect, useState } from 'react';
import type { AppState, ScenarioInfo } from '../../shared/api.js';
import { SwitchInput } from './Switch.js';
import { useStore } from './store.js';
import { useT, useUiText } from './ui.js';

/**
 * Groups in the order a flight meets them (U-10), not by the English ids; pilot commands last, in
 * a group of their own without switches (the requests need them).
 */
type Group = ScenarioCategory | 'commands';
const ORDER: readonly Group[] = ['docs', 'ops', 'irregular', 'external', 'fun', 'commands'];

const groupOf = (s: ScenarioInfo): Group => (s.command ? 'commands' : s.category);

export function ScenariosView() {
  const t = useT();
  const scenarios = useStore((s) => s.scenarios) ?? [];
  const running = useStore((s) => s.app?.session === 'running');
  const text = useUiText();
  const irregular = useStore((s) => s.app?.irregular) ?? [];
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const matches = (s: ScenarioInfo) =>
    q === '' ||
    [s.id, text(s.titleText), s.description === null ? '' : text(s.description)]
      .join(' ')
      .toLowerCase()
      .includes(q);
  const groups = ORDER.map((g) => {
    const all = scenarios.filter((s) => groupOf(s) === g);
    return { g, all, shown: all.filter(matches) };
  }).filter((x) => x.shown.length > 0);

  return (
    <section className="page" aria-labelledby="scen-title">
      <h2 id="scen-title" className="page-title">
        {t('scen.title')}
      </h2>
      <p className={running ? 'hint warn' : 'hint'}>{t(running ? 'scen.running' : 'scen.hint')}</p>
      {running && irregular.length > 0 && <ForceForm list={irregular} />}
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
        <span className="sr-only">{t('scen.search')}</span>
        <input
          type="search"
          placeholder={t('scen.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
      </label>
      {groups.length === 0 && scenarios.length > 0 && <p className="hint">{t('scen.none')}</p>}
      {groups.map(({ g, all, shown }) => (
        <CategoryGroup key={g} group={g} all={all} shown={shown} searching={q !== ''} />
      ))}
    </section>
  );
}

/**
 * One category, folding (open while searching); its switch turns all of it on or off at once.
 * Pilot commands have no switches.
 */
function CategoryGroup({
  group,
  all,
  shown,
  searching,
}: {
  group: Group;
  all: readonly ScenarioInfo[];
  shown: readonly ScenarioInfo[];
  searching: boolean;
}) {
  const t = useT();
  const busy = useStore((s) => s.busy);
  const setScenarios = useStore((s) => s.setScenarios);
  const [open, setOpen] = useState(true);
  const on = all.filter((s) => s.enabled).length;
  const name = t(`cat.${group}`);
  const commands = group === 'commands';
  return (
    <section className="group" aria-labelledby={`cat-${group}`}>
      <div className="group-head">
        <button
          type="button"
          id={`cat-${group}`}
          className="group-toggle"
          aria-expanded={open || searching}
          aria-controls={`cat-list-${group}`}
          onClick={() => setOpen(!open)}
        >
          <span className="group-chevron" aria-hidden="true">
            {open || searching ? '▾' : '▸'}
          </span>
          <span className="group-title">{name}</span>
          <span className="group-count">{t('scen.categoryCount', { on, all: all.length })}</span>
        </button>
        {!commands && (
          <SwitchInput
            label={t('scen.category', { category: name })}
            checked={on === all.length}
            disabled={busy !== null}
            onChange={(v) =>
              void setScenarios(
                all.map((s) => s.id),
                v,
              )
            }
          />
        )}
      </div>
      {(open || searching) && (
        <ul className="sheet" id={`cat-list-${group}`}>
          {commands && <li className="sheet-note">{t('scen.commandsHint')}</li>}
          {shown.map((s) => (
            <ScenarioItem key={s.id} s={s} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ScenarioItem({ s }: { s: ScenarioInfo }) {
  const t = useT();
  const text = useUiText();
  const busy = useStore((st) => st.busy);
  const setScenario = useStore((st) => st.setScenario);
  return (
    <li className="scenario">
      <div className="sheet-row scenario-row">
        <label className="row-text" htmlFor={s.command ? undefined : `scen-${s.id}`}>
          <span className="row-title">{text(s.titleText)}</span>
          {s.description !== null && <span className="row-desc">{text(s.description)}</span>}
          <span className="row-hint">
            <span className="row-id">{s.id}</span>
            {!s.command &&
              s.enabled !== s.enabledByDefault &&
              ` · ${t('scen.default', {
                value: t(s.enabledByDefault ? 'scen.on' : 'scen.off'),
              })}`}
          </span>
        </label>
        {s.category === 'irregular' && !s.command && <ChanceInput s={s} />}
        {s.command ? (
          <span className="pill">{t('scen.command')}</span>
        ) : (
          <SwitchInput
            id={`scen-${s.id}`}
            checked={s.enabled}
            disabled={busy !== null}
            onChange={(v) => void setScenario(s.id, v)}
          />
        )}
      </div>
      {s.droneRiskDefault !== null && <DroneRiskTable defaults={s.droneRiskDefault} />}
    </li>
  );
}

/**
 * Chance of an irregular scenario in percent (U-11): empty = the file's value, said in words next
 * to the field; a bad value stays with a message instead of quietly going back.
 */
function ChanceInput({ s }: { s: ScenarioInfo }) {
  const t = useT();
  const busy = useStore((st) => st.busy);
  const setChance = useStore((st) => st.setChance);
  const [text, setText] = useState(s.chance === null ? '' : String(s.chance));
  const [bad, setBad] = useState(false);
  useEffect(() => {
    setText(s.chance === null ? '' : String(s.chance));
    setBad(false);
  }, [s.chance]);
  const commit = () => {
    const v = text.trim().replace(',', '.');
    if (v === '') {
      setBad(false);
      if (s.chance !== null) void setChance(s.id, null);
      return;
    }
    const n = Math.round(Number(v) * 10) / 10;
    if (!/^\d+(?:\.\d+)?$/.test(v) || n < 0 || n > 100) {
      setBad(true);
      return;
    }
    setBad(false);
    if (n !== s.chance) void setChance(s.id, n);
  };
  const errId = `chance-${s.id}-error`;
  return (
    <span className={bad ? 'chance invalid' : 'chance'}>
      <input
        type="text"
        inputMode="decimal"
        aria-label={t('scen.chance', { id: s.id })}
        aria-invalid={bad}
        aria-describedby={bad ? errId : undefined}
        value={text}
        disabled={busy !== null}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
      <span className="chance-unit">%</span>
      {bad ? (
        <span id={errId} className="row-error" role="alert">
          {t('scen.chanceBad')}
        </span>
      ) : (
        <span className="chance-default">
          {t('scen.chanceDefault', { value: s.defaultChance })}
        </span>
      )}
      {s.chance !== null && !bad && (
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={() => void setChance(s.id, null)}
        >
          {t('scen.chanceReset')}
        </button>
      )}
    </span>
  );
}

/** Chance multiplier by destination country (T38); an empty custom table = the built-in one. */
function DroneRiskTable({ defaults }: { defaults: Readonly<Record<string, number>> }) {
  const t = useT();
  const busy = useStore((st) => st.busy) !== null;
  const custom = useStore((st) => st.settings?.droneRisk) ?? {};
  const update = useStore((st) => st.updateSettings);
  const isCustom = Object.keys(custom).length > 0;
  const table = isCustom ? custom : defaults;
  const rows = Object.entries(table).sort(([a], [b]) =>
    a === '*' ? 1 : b === '*' ? -1 : a.localeCompare(b),
  );
  const [code, setCode] = useState('');
  const [factor, setFactor] = useState('');
  // U-11: what was wrong with the last input, instead of a silent undo.
  const [error, setError] = useState<string | null>(null);
  const save = (next: Record<string, number>) => void update({ droneRisk: next });
  const parse = (v: string): number | null => {
    const n = Number(v.trim().replace(',', '.'));
    return v.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
  };
  const add = () => {
    const c = code.trim().toUpperCase();
    const n = parse(factor);
    if (!(c === '*' || /^[A-Z]{2}$/.test(c))) return setError(t('drone.badCode'));
    if (n === null) return setError(t('drone.bad'));
    setError(null);
    save({ ...table, [c]: n });
    setCode('');
    setFactor('');
  };
  return (
    <details className="drone-risk">
      <summary>
        {t('drone.title')}{' '}
        <span className="row-hint">{t(isCustom ? 'drone.custom' : 'drone.builtin')}</span>
      </summary>
      <p className="hint">{t('drone.hint')}</p>
      <ul className="drone-rows">
        {rows.map(([c, m]) => (
          <li key={`${c}:${m}`}>
            <span className="drone-code">{c}</span>
            <span>×</span>
            <input
              type="number"
              min={0}
              max={100}
              step={0.1}
              aria-label={t('drone.factor', { country: c })}
              defaultValue={m}
              disabled={busy}
              onBlur={(e) => {
                const n = parse(e.currentTarget.value);
                if (n === null) {
                  e.currentTarget.value = String(m);
                  setError(t('drone.bad'));
                } else {
                  setError(null);
                  if (n !== m) save({ ...table, [c]: n });
                }
              }}
            />
            <button
              type="button"
              className="btn-close"
              disabled={busy}
              aria-label={t('drone.remove', { country: c })}
              onClick={() => {
                const { [c]: _gone, ...rest } = table;
                save(rest);
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="drone-add">
        <input
          type="text"
          className="caps"
          maxLength={2}
          aria-label={t('drone.country')}
          placeholder="XX / *"
          value={code}
          disabled={busy}
          onChange={(e) => setCode(e.target.value)}
        />
        <input
          type="number"
          min={0}
          max={100}
          step={0.1}
          aria-label={t('drone.factor', { country: code === '' ? '…' : code })}
          value={factor}
          disabled={busy}
          onChange={(e) => setFactor(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
        />
        <button type="button" className="btn" disabled={busy} onClick={add}>
          {t('drone.add')}
        </button>
        {isCustom && (
          <button type="button" className="btn" disabled={busy} onClick={() => save({})}>
            {t('drone.reset')}
          </button>
        )}
      </div>
      {error !== null && (
        <p className="row-error" role="alert">
          {error}
        </p>
      )}
    </details>
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
