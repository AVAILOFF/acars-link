// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ZipEntry } from './zip.js';

/**
 * "Export diagnostics" (T67, decision 3): one .zip with the logs, the versions, the settings
 * without secrets and, when the user ticks it, the latest flight recording (callsign, route and
 * AeroDataBox data — off by default). Every text goes through the log redactor once more, so a
 * secret saved after a line was written is masked as well. Nothing is sent anywhere.
 */

export interface DiagnosticsSource {
  /** Log files (main and bridge), oldest first. */
  readonly logFiles: () => readonly string[];
  /** The newest flight recording, kept or temporary; null = none. */
  readonly latestRecording: () => string | null;
  /** App, Electron, Node and OS versions. */
  readonly about: () => Readonly<Record<string, string>>;
  readonly redact: (text: string) => string;
  /** Asks the user where to save (`defaultName` proposed); null = cancelled. */
  readonly choosePath: (defaultName: string) => Promise<string | null>;
  /** Shows the saved file in the file manager. */
  readonly reveal?: (file: string) => void;
}

export interface DiagnosticsInput {
  readonly source: DiagnosticsSource;
  readonly now: number;
  /** Bridge version from its `hello`; null = not connected yet. */
  readonly bridgeVersion: string | null;
  /** Settings and the state views; no secret is in them, they are redacted all the same. */
  readonly settings: unknown;
  readonly accounts: Readonly<Record<string, boolean>>;
  readonly state: unknown;
  readonly withRecording: boolean;
}

/** `acars-link-diagnostics-20261029-0800.zip` (UTC). */
export function diagnosticsFileName(now: number): string {
  const iso = new Date(now).toISOString();
  return `acars-link-diagnostics-${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 16).replace(':', '')}.zip`;
}

export async function diagnosticsEntries(i: DiagnosticsInput): Promise<ZipEntry[]> {
  const { redact } = i.source;
  const about = {
    ...i.source.about(),
    bridge: i.bridgeVersion ?? 'not connected',
    exported: new Date(i.now).toISOString(),
  };
  const json = (v: unknown) => redact(`${JSON.stringify(v, null, 2)}\n`);
  const entries: ZipEntry[] = [
    {
      name: 'about.txt',
      data: redact(
        Object.entries(about)
          .map(([k, v]) => `${k}: ${v}\n`)
          .join(''),
      ),
    },
    { name: 'settings.json', data: json({ settings: i.settings, accounts: i.accounts }) },
    { name: 'state.json', data: json(i.state) },
  ];
  for (const file of i.source.logFiles()) {
    const text = await readText(file);
    if (text !== null) entries.push({ name: `logs/${basename(file)}`, data: redact(text) });
  }
  if (i.withRecording) {
    const file = i.source.latestRecording();
    const text = file === null ? null : await readText(file);
    if (file !== null && text !== null) {
      entries.push({ name: `recording/${basename(file)}`, data: redact(text) });
    }
  }
  return entries;
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}
