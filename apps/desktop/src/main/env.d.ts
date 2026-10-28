// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

// Vite's `import.meta.glob` (main/scenario-sources.ts); vite/client types would pull in the DOM.
interface ImportMeta {
  glob<T>(
    pattern: string,
    options: { readonly query: '?raw'; readonly import: 'default'; readonly eager: true },
  ): Record<string, T>;
}
