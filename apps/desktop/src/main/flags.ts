import type { Value } from '@acars/core';
import { readTextFile, writeTextFileAtomic } from './files.js';

/**
 * Airline memory between flights (T14): the scenarios' `flags.*` (an open MEL item, a banned
 * passenger, crew rest after discretion…), a JSON file in the user-data folder. Read back with
 * the same limits the core keeps; anything else in the file is dropped.
 */

const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_FLAGS = 64;
const MAX_TEXT = 80;

export type Flags = Readonly<Record<string, Value>>;

export function sanitizeFlags(raw: unknown): Record<string, Value> {
  const out: Record<string, Value> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_FLAGS) break;
    if (!NAME.test(k)) continue;
    if (typeof v === 'string' && v.length <= MAX_TEXT) out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

export class FlagsStore {
  private current: Flags | null = null;

  constructor(private readonly file: string) {}

  async get(): Promise<Flags> {
    if (this.current !== null) return this.current;
    const text = await readTextFile(this.file);
    let raw: unknown = null;
    try {
      raw = text === null ? null : JSON.parse(text);
    } catch {
      raw = null;
    }
    this.current = sanitizeFlags(raw);
    return this.current;
  }

  async set(flags: Flags): Promise<Flags> {
    const clean = sanitizeFlags(flags);
    await writeTextFileAtomic(this.file, `${JSON.stringify(clean, null, 2)}\n`);
    this.current = clean;
    return clean;
  }
}
