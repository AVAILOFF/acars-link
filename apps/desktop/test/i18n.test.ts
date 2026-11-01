// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { loadScenarios, missingTranslations } from '@acars/scenarios';
import { describe, expect, it } from 'vitest';
import { BASE_SCENARIOS, SCENARIO_LOCALES } from '../src/main/scenario-sources.js';
import { HELP } from '../src/renderer/src/help.js';
import { MESSAGES } from '../src/renderer/src/i18n.js';
import { LANGUAGE_CHOICES, LANGUAGES } from '../src/shared/api.js';

/**
 * Completeness of the languages offered in the app (T86, T87): a language listed as ready has every UI
 * string, its own help and every scenario text. Not ready languages are only reported.
 */
describe('languages of the app', () => {
  const scenarios = loadScenarios(BASE_SCENARIOS, SCENARIO_LOCALES);
  const keys = Object.keys(MESSAGES.en);

  for (const lang of Object.keys(LANGUAGES) as (keyof typeof LANGUAGES)[]) {
    if (lang === 'en') continue;
    const missing = {
      messages: keys.filter((k) => MESSAGES[lang]?.[k as keyof typeof MESSAGES.en] === undefined),
      help: HELP[lang] === undefined,
      scenarios: missingTranslations(scenarios, lang),
    };
    it(`${lang}: ${LANGUAGES[lang].ready ? 'complete' : 'reported'}`, () => {
      console.info(
        `${lang}: ${missing.messages.length} UI strings, ${missing.scenarios.length} scenario texts not translated${missing.help ? ', no help' : ''}`,
      );
      if (!LANGUAGE_CHOICES.includes(lang)) return;
      expect(missing.messages).toEqual([]);
      expect(missing.help).toBe(false);
      expect(missing.scenarios).toEqual([]);
    });
  }
});
