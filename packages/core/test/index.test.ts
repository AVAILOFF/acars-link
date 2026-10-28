// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { describe, expect, it } from 'vitest';
import { CORE_PACKAGE } from '../src/index.js';

describe('@acars/core', () => {
  it('exports its package marker', () => {
    expect(CORE_PACKAGE).toBe('@acars/core');
  });
});
