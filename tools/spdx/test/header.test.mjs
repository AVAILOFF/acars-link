// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { describe, expect, it } from 'vitest';
import { expectedHeader, hasHeader, withHeader } from '../header.mjs';

const OURS = [
  '// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary',
  '// Copyright (c) 2026 AVAILOFF',
];

describe('licence header (T62)', () => {
  it('a file without the header fails the check', () => {
    expect(hasHeader('packages/core/src/a.ts', 'export const a = 1;\n')).toBe(false);
  });

  it('adds the header with a blank line and is idempotent', () => {
    const fixed = withHeader('packages/core/src/a.ts', 'export const a = 1;\n');
    expect(fixed).toBe(`${OURS.join('\n')}\n\nexport const a = 1;\n`);
    expect(hasHeader('packages/core/src/a.ts', fixed)).toBe(true);
    expect(withHeader('packages/core/src/a.ts', fixed)).toBe(fixed);
  });

  it('keeps a shebang first and CRLF line ends', () => {
    const fixed = withHeader('tools/x.mjs', '#!/usr/bin/env node\r\nrun();\r\n');
    expect(fixed).toBe(`#!/usr/bin/env node\r\n${OURS.join('\r\n')}\r\n\r\nrun();\r\n`);
  });

  it('replaces an outdated header instead of stacking a second one', () => {
    const old = '// SPDX-License-Identifier: MIT\n// Copyright (c) 2025 X\n\nexport {};\n';
    expect(withHeader('apps/desktop/src/a.tsx', old)).toBe(`${OURS.join('\n')}\n\nexport {};\n`);
  });

  it('uses # in Python and // in C#', () => {
    expect(expectedHeader('tools/squawk-tables/generate.py')?.[0]).toBe(
      '# SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary',
    );
    expect(expectedHeader('bridge/msfs/src/AcarsBridge/Program.cs')).toEqual(OURS);
  });

  it('OpenFlights table stays under the ODbL', () => {
    expect(expectedHeader('packages/core/src/ext/openflights.ts')?.[0]).toBe(
      '// SPDX-License-Identifier: ODbL-1.0',
    );
  });

  it('other file types carry no header', () => {
    expect(expectedHeader('docs/07-roadmap-tasks.md')).toBeNull();
    expect(hasHeader('packages/scenarios/base/a.yaml', 'id: a\n')).toBe(true);
  });
});
