import type { ScenarioCategory } from '@acars/core';
import { useEffect, useState } from 'react';
import type { ScenarioInfo } from '../../shared/api.js';
import { SwitchInput } from './Switch.js';
import { useStore } from './store.js';
import { useT, useUiText } from './ui.js';

export function ScenariosView() {
  const t = useT();
  const scenarios = useStore((s) => s.scenarios) ?? [];
  const running = useStore((s) => s.app?.session === 'running');
  const busy = useStore((s) => s.busy);
  const setScenario = useStore((s) => s.setScenario);
  const text = useUiText();

  const groups = new Map<ScenarioCategory, ScenarioInfo[]>();
  for (const s of scenarios) groups.set(s.category, [...(groups.get(s.category) ?? []), s]);

  return (
    <section className="page" aria-labelledby="scen-title">
      <h2 id="scen-title" className="page-title">
        {t('scen.title')}
      </h2>
      <p className={running ? 'hint warn' : 'hint'}>{t(running ? 'scen.running' : 'scen.hint')}</p>
      {[...groups].map(([category, list]) => (
        <section key={category} className="group" aria-labelledby={`cat-${category}`}>
          <h3 id={`cat-${category}`} className="group-title">
            {t(`cat.${category}`)}
          </h3>
          <ul className="sheet">
            {list.map((s) => (
              <li key={s.id} className="scenario">
                <div className="sheet-row scenario-row">
                  <label className="row-text" htmlFor={`scen-${s.id}`}>
                    <span className="row-title">{text(s.titleText)}</span>
                    {s.description !== null && (
                      <span className="row-desc">{text(s.description)}</span>
                    )}
                    <span className="row-hint">
                      <span className="row-id">{s.id}</span>
                      {s.enabled !== s.enabledByDefault &&
                        ` · ${t('scen.default', {
                          value: t(s.enabledByDefault ? 'scen.on' : 'scen.off'),
                        })}`}
                    </span>
                  </label>
                  {s.category === 'irregular' && <ChanceInput s={s} />}
                  <SwitchInput
                    id={`scen-${s.id}`}
                    checked={s.enabled}
                    disabled={busy !== null}
                    onChange={(v) => void setScenario(s.id, v)}
                  />
                </div>
                {s.droneRiskDefault !== null && <DroneRiskTable defaults={s.droneRiskDefault} />}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}

/** Chance of an irregular scenario in percent; empty = the file's value. */
function ChanceInput({ s }: { s: ScenarioInfo }) {
  const t = useT();
  const busy = useStore((st) => st.busy);
  const setChance = useStore((st) => st.setChance);
  const [text, setText] = useState(s.chance === null ? '' : String(s.chance));
  useEffect(() => setText(s.chance === null ? '' : String(s.chance)), [s.chance]);
  const commit = () => {
    const v = text.trim().replace(',', '.');
    if (v === '') {
      if (s.chance !== null) void setChance(s.id, null);
      return;
    }
    const n = Math.round(Number(v) * 10) / 10;
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      setText(s.chance === null ? '' : String(s.chance));
      return;
    }
    if (n !== s.chance) void setChance(s.id, n);
  };
  return (
    <span className="chance">
      <input
        type="number"
        min={0}
        max={100}
        step={0.5}
        aria-label={t('scen.chance', { id: s.id })}
        placeholder={String(s.defaultChance)}
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
      {s.chance !== null && (
        <span className="chance-default">
          {t('scen.chanceDefault', { value: s.defaultChance })}
        </span>
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
  const save = (next: Record<string, number>) => void update({ droneRisk: next });
  const parse = (v: string): number | null => {
    const n = Number(v.trim().replace(',', '.'));
    return v.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
  };
  const add = () => {
    const c = code.trim().toUpperCase();
    const n = parse(factor);
    if (!(c === '*' || /^[A-Z]{2}$/.test(c)) || n === null) return;
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
                if (n === null) e.currentTarget.value = String(m);
                else if (n !== m) save({ ...table, [c]: n });
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
    </details>
  );
}
