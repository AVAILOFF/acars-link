import type { SpecialGroup } from '@acars/data-sources';
import type { Settings } from '../shared/api.js';

/**
 * Special events (T29, docs/07): the scenarios of each group. A group switched off in the
 * settings has these scenarios off (whatever their own switch) and its data sources not asked.
 */
export const SPECIAL_SCENARIOS: Readonly<Record<SpecialGroup, readonly string[]>> = {
  sport: ['f1_result', 'nhl_results'],
  aviation: [
    'space_weather',
    'volcanic_ash',
    'aurora_on_route',
    'solar_eclipse',
    'airshow_dest',
    'aviation_history',
  ],
  other: ['holiday_dest', 'earthquake_dest'],
};

const ON: Readonly<Record<SpecialGroup, (s: Settings) => boolean>> = {
  sport: (s) => s.specialSport,
  aviation: (s) => s.specialAviation,
  other: (s) => s.specialOther,
};

/** Groups switched on. */
export function specialGroups(s: Settings): SpecialGroup[] {
  return (Object.keys(ON) as SpecialGroup[]).filter((g) => ON[g](s));
}

/** False for a scenario of a group that is off. */
export function specialGroupOn(id: string, s: Settings): boolean {
  for (const g of Object.keys(SPECIAL_SCENARIOS) as SpecialGroup[]) {
    if (SPECIAL_SCENARIOS[g].includes(id)) return ON[g](s);
  }
  return true;
}
