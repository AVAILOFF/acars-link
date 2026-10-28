// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

// Vite handles CSS imports (main.tsx).
declare module '*.css';
// Vite turns asset imports into URLs (the message sound).
declare module '*.mp3' {
  const url: string;
  export default url;
}
