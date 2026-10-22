import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VdgsCommand, VdgsLine } from '@acars/core';

/**
 * GSX VDGS custom messages (T22). GSX Pro reads every `*.json` in
 * `%APPDATA%\Virtuali\GSX\VGDS\` and reloads a file when it changes (FSDreamTeam "VGDS Custom
 * Messages System" manual, 2025-07-29; docs/06 "GSX VDGS"). The app owns one file there,
 * {@link VDGS_FILE}: one message per scenario, shown only at the message's airport, written
 * atomically, deleted when the flight ends and at app start (approved assumptions, docs/07 T22).
 * Without GSX (no `Virtuali\GSX` folder) everything is a no-op.
 */

export const VDGS_FILE = 'acars-sim.json';
const SOURCE = 'ACARS Link';

/** GSX's custom message folder, or null when GSX is not installed for this user. */
export function gsxVdgsDir(appData: string): string | null {
  const gsx = join(appData, 'Virtuali', 'GSX');
  return existsSync(gsx) ? join(gsx, 'VGDS') : null;
}

type Line = string | { readonly red: string };

/** The file GSX reads: header of the manual's "Required File Header", then the messages. */
export function vdgsFileJson(commands: readonly VdgsCommand[]): string {
  const line = (l: VdgsLine): Line => (l.red ? { red: l.text } : l.text);
  return `${JSON.stringify(
    {
      type: 'vgds_messages',
      version: '1.0',
      enabled: true,
      auto_cleanup: false,
      source: SOURCE,
      messages: commands.map((c) => ({
        id: `acars_${c.scenarioId}`,
        duration: c.vdgs.durationMs,
        conditions: { airports: [c.vdgs.airport] },
        display: Object.fromEntries(
          Object.entries(c.vdgs.displays).map(([d, lines]) => [
            d,
            { pages: [{ lines: (lines ?? []).map(line) }] },
          ]),
        ),
      })),
    },
    null,
    2,
  )}\n`;
}

export class VdgsWriter {
  /** Latest message per scenario, in the order they first appeared. */
  private readonly messages = new Map<string, VdgsCommand>();

  /** `dir`: from {@link gsxVdgsDir}; null = GSX not installed, the writer does nothing. */
  constructor(private readonly dir: string | null) {}

  get available(): boolean {
    return this.dir !== null;
  }

  /** Adds or replaces the scenario's message and rewrites the file. Throws on I/O errors. */
  show(c: VdgsCommand): void {
    if (this.dir === null) return;
    this.messages.set(c.scenarioId, c);
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, VDGS_FILE);
    // Not `*.json`, so GSX never loads a half-written file.
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, vdgsFileJson([...this.messages.values()]), 'utf8');
    renameSync(tmp, file);
  }

  /** Removes the file (end of flight, app start after a crash). Never throws. */
  clear(): void {
    this.messages.clear();
    if (this.dir === null) return;
    for (const f of [VDGS_FILE, `${VDGS_FILE}.tmp`]) {
      try {
        rmSync(join(this.dir, f), { force: true });
      } catch {
        // A locked file stays until the next start; GSX shows it only at that airport.
      }
    }
  }
}
