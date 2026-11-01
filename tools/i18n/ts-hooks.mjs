// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Lets `tools/i18n` import the workspace's TypeScript sources with Node's own type stripping: a
 * relative `./x.js` resolves to `./x.ts` when only the latter exists (as in tsc's NodeNext output).
 */
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const ts = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (
        existsSync(fileURLToPath(ts)) &&
        !existsSync(fileURLToPath(new URL(specifier, context.parentURL)))
      ) {
        return next(ts.href, context);
      }
    }
    return next(specifier, context);
  },
});
