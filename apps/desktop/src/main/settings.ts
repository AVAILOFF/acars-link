import { DEFAULT_STATION } from '@acars/core';
import type { Language, Settings, SettingsPatch, TransportChoice } from '../shared/api.js';
import { AppFailure } from './errors.js';
import { readTextFile, writeTextFileAtomic } from './files.js';

/**
 * Non-secret settings, a JSON file in the user-data folder. Everything read from disk or
 * received from the renderer goes through the same checks.
 */

export const DEFAULT_BRIDGE_PORT = 47830;

const LANGUAGES: readonly Language[] = ['en', 'ru'];
const TRANSPORTS: readonly TransportChoice[] = ['hoppie', 'offline'];
/** Letters/digits and `{flight}` / `{airline}` placeholders. */
const STATION_RE = /^(?:[A-Z0-9]|\{flight\}|\{airline\})+$/i;
export const SCENARIO_ID_RE = /^[a-z0-9_]{1,64}$/;

export function defaultSettings(locale: string): Settings {
  return {
    language: locale.toLowerCase().startsWith('ru') ? 'ru' : 'en',
    transport: 'hoppie',
    stationTemplate: DEFAULT_STATION,
    bridgePort: DEFAULT_BRIDGE_PORT,
    recordFlights: true,
    scenarios: {},
  };
}

const bad = (field: string, why: string) => new AppFailure('invalid_input', `${field}: ${why}`);

/** Checks a patch from the renderer; throws `invalid_input`. */
export function validatePatch(patch: unknown): SettingsPatch {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw bad('settings', 'expected an object');
  }
  const p = patch as Record<string, unknown>;
  const out: { -readonly [K in keyof SettingsPatch]: SettingsPatch[K] } = {};
  for (const [key, value] of Object.entries(p)) {
    switch (key) {
      case 'language':
        if (!LANGUAGES.includes(value as Language)) throw bad(key, 'en or ru');
        out.language = value as Language;
        break;
      case 'transport':
        if (!TRANSPORTS.includes(value as TransportChoice)) throw bad(key, 'hoppie or offline');
        out.transport = value as TransportChoice;
        break;
      case 'stationTemplate':
        if (typeof value !== 'string' || value.length > 32 || !STATION_RE.test(value)) {
          throw bad(key, 'letters, digits, {flight}, {airline}');
        }
        out.stationTemplate = value;
        break;
      case 'bridgePort':
        if (!Number.isInteger(value) || (value as number) < 1024 || (value as number) > 65535) {
          throw bad(key, 'integer 1024..65535');
        }
        out.bridgePort = value as number;
        break;
      case 'recordFlights':
        if (typeof value !== 'boolean') throw bad(key, 'true or false');
        out.recordFlights = value;
        break;
      default:
        throw bad(key, 'unknown setting');
    }
  }
  return out;
}

/** Settings from disk: unknown or bad values fall back to the defaults, one by one. */
export function sanitize(raw: unknown, defaults: Settings): Settings {
  if (typeof raw !== 'object' || raw === null) return defaults;
  const r = raw as Record<string, unknown>;
  let s = defaults;
  const keys = ['language', 'transport', 'stationTemplate', 'bridgePort', 'recordFlights'] as const;
  for (const key of keys) {
    if (!(key in r)) continue;
    try {
      s = { ...s, ...validatePatch({ [key]: r[key] }) };
    } catch {
      // keep the default
    }
  }
  const scenarios: Record<string, boolean> = {};
  if (typeof r['scenarios'] === 'object' && r['scenarios'] !== null) {
    for (const [id, on] of Object.entries(r['scenarios'] as Record<string, unknown>)) {
      if (SCENARIO_ID_RE.test(id) && typeof on === 'boolean') scenarios[id] = on;
    }
  }
  return { ...s, scenarios };
}

export class SettingsStore {
  private current: Settings | null = null;

  constructor(
    private readonly file: string,
    private readonly defaults: Settings,
  ) {}

  async get(): Promise<Settings> {
    if (this.current !== null) return this.current;
    const text = await readTextFile(this.file);
    let raw: unknown = null;
    if (text !== null) {
      try {
        raw = JSON.parse(text);
      } catch {
        raw = null;
      }
    }
    this.current = sanitize(raw, this.defaults);
    return this.current;
  }

  async update(patch: SettingsPatch): Promise<Settings> {
    return this.save({ ...(await this.get()), ...validatePatch(patch) });
  }

  async setScenario(id: string, enabled: boolean): Promise<Settings> {
    if (!SCENARIO_ID_RE.test(id)) throw bad('scenario', 'bad id');
    const s = await this.get();
    return this.save({ ...s, scenarios: { ...s.scenarios, [id]: enabled } });
  }

  private async save(s: Settings): Promise<Settings> {
    await writeTextFileAtomic(this.file, `${JSON.stringify(s, null, 2)}\n`);
    this.current = s;
    return s;
  }
}
