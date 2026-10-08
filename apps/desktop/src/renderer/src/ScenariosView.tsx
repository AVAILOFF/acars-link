import type { ScenarioCategory } from '@acars/core';
import type { ScenarioInfo } from '../../shared/api.js';
import { useStore } from './store.js';
import { useT } from './ui.js';

export function ScenariosView() {
  const t = useT();
  const scenarios = useStore((s) => s.scenarios) ?? [];
  const running = useStore((s) => s.app?.session === 'running');
  const busy = useStore((s) => s.busy);
  const setScenario = useStore((s) => s.setScenario);

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
            <label key={s.id} className="check">
              <input
                type="checkbox"
                checked={s.enabled}
                disabled={busy !== null}
                onChange={(e) => void setScenario(s.id, e.currentTarget.checked)}
              />
              <span className="check-title">{s.title}</span>
              <span className="mono muted small">{s.id}</span>
              {s.enabled !== s.enabledByDefault && (
                <span className="muted small">
                  {t('scen.default', { value: t(s.enabledByDefault ? 'scen.on' : 'scen.off') })}
                </span>
              )}
            </label>
          ))}
        </fieldset>
      ))}
    </section>
  );
}
