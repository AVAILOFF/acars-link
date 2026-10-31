// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { join } from 'node:path';
import type { LegalDoc } from '../shared/api.js';

/**
 * The licence files the "About" page opens (T74). Installed: next to the application, in
 * `resources` (electron-builder.yml, `extraResources`). From the sources (`pnpm desktop:dev`): the
 * files of the repository; the generated component licences exist there only after `pnpm licenses`.
 */

export interface LegalEnv {
  readonly packaged: boolean;
  /** `process.resourcesPath` of the installed application. */
  readonly resourcesPath: string;
  /** `apps/desktop` of the repository. */
  readonly desktopDir: string;
}

export function legalFile(doc: LegalDoc, env: LegalEnv): string {
  if (env.packaged) {
    const name = {
      eula: 'EULA.txt',
      notices: 'THIRD-PARTY-NOTICES.md',
      licenses: 'THIRD-PARTY-LICENSES.txt',
    }[doc];
    return join(env.resourcesPath, name);
  }
  return {
    eula: join(env.desktopDir, 'build', 'license.txt'),
    notices: join(env.desktopDir, '..', '..', 'THIRD-PARTY-NOTICES.md'),
    licenses: join(env.desktopDir, 'build', 'third-party-licenses.txt'),
  }[doc];
}
