// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { ScenarioGroups } from '@acars/core';

/**
 * Scenario groups (T39): `group: <name>` in a scenario file; the engine lets at most
 * `max_per_flight` members of a group start in one flight (a forced start ignores it, like
 * `excludes`). A group name that is not listed here fails the load.
 */
export const SCENARIO_GROUPS: ScenarioGroups = {
  /** The "news" of T29 (space weather, aurora, eclipse, air show, history, F1, NHL, holidays, earthquake): one per flight. */
  special_news: { max_per_flight: 1 },
};
