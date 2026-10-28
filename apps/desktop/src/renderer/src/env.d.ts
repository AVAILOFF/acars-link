// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { AcarsApi } from '../../shared/api.js';

declare global {
  interface Window {
    /** Exposed by the preload script (src/preload/index.ts). */
    readonly acars: AcarsApi;
  }
}
