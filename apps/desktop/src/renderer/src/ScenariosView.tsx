import type { ScenarioCategory } from '@acars/core';
import { useEffect, useState } from 'react';
import type { ScenarioInfo } from '../../shared/api.js';
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
    <section className="panel narrow" aria-labelledby="scen-title">
      <h2 id="scen-title" className="panel-title">
        {t('scen.title')}
      </h2>
      <p className={running ? 'hint warn' : 'hint'}>{t(running ? 'scen.running' : 'scen.hint')}</p>
      {[...groups].map(([category, list]) => (
        <fieldset key={category} className="group">
          <legend>{t(`cat.${category}`)}</legend>
          {list.map((s) => (
            <div key={s.id} className="scenario-row">
              <label className="check">
                <input
                  type="checkbox"
                  checked={s.enabled}
                  disabled={busy !== null}
                  onChange={(e) => void setScenario(s.id, e.currentTarget.checked)}
                />
                <span className="check-title">{text(s.titleText)}</span>
                <span className="mono muted small">{s.id}</span>
                {s.enabled !== s.enabledByDefault && (
                  <span className="muted small">
                    {t('scen.default', { value: t(s.enabledByDefault ? 'scen.on' : 'scen.off') })}
                  </span>
                )}
                {s.category === 'irregular' && <ChanceInput s={s} />}
              </label>
              {s.description !== null && (
                <p className="hint small scenario-desc">{text(s.description)}</p>
              )}
            </div>
          ))}
        </fieldset>
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
        className="mono"
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
      <span className="muted small">%</span>
      {s.chance !== null && (
        <span className="muted small">{t('scen.chanceDefault', { value: s.defaultChance })}</span>
      )}
    </span>
  );
}
