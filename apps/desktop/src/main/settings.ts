// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import {
  DEFAULT_RESCUE_FLIPPED,
  DEFAULT_RESCUE_TITLES,
  DEFAULT_STATION,
  RESCUE_MAX_VEHICLES,
  RESCUE_TITLE_GROUPS,
  type RescueTitles,
} from '@acars/core';
import { DRONE_RISK_MAX, isDroneRiskKey, isDroneRiskValue } from '@acars/scenarios';
import type {
  ErrorReason,
  Language,
  Settings,
  SettingsPatch,
  SimChoice,
  TransportChoice,
} from '../shared/api.js';
import { AppFailure } from './errors.js';
import { readTextFile, writeTextFileAtomic } from './files.js';

/**
 * Non-secret settings, a JSON file in the user-data folder. Everything read from disk or
 * received from the renderer goes through the same checks.
 */

export const DEFAULT_BRIDGE_PORT = 47830;

const LANGUAGES: readonly Language[] = ['en', 'ru'];
const TRANSPORTS: readonly TransportChoice[] = ['hoppie', 'offline'];
const SIM_CHOICES: readonly SimChoice[] = ['auto', 'msfs', 'xplane'];
/** Letters/digits and `{flight}` / `{airline}` placeholders. */
const STATION_RE = /^(?:[A-Z0-9]|\{flight\}|\{airline\})+$/i;
export const SCENARIO_ID_RE = /^[a-z0-9_]{1,64}$/;

export function defaultSettings(locale: string): Settings {
  return {
    language: locale.toLowerCase().startsWith('ru') ? 'ru' : 'en',
    transport: 'hoppie',
    stationTemplate: DEFAULT_STATION,
    bridgePort: DEFAULT_BRIDGE_PORT,
    simChoice: 'auto',
    recordFlights: true,
    liveData: true,
    soundOnMessage: false,
    messageHints: true,
    messageGapSec: 60,
    xatc: true,
    datalink: false,
    datalinkSatcom: true,
    aircraftIcaoHex: '',
    hubIcao: '',
    simTime: false,
    turnaround: true,
    datalinkHeaderInText: false,
    xatcStandAside: true,
    xatcRandomDirects: true,
    specialSport: true,
    specialAviation: true,
    specialOther: true,
    rescue: true,
    rescueTitles: DEFAULT_RESCUE_TITLES,
    rescueFlipped: DEFAULT_RESCUE_FLIPPED,
    scenarios: {},
    chances: {},
    droneRisk: {},
  };
}

/** `reason` translates the rule (U-14); without one the UI names the field (`setting_value`). */
const bad = (field: string, why: string, reason: ErrorReason = 'setting_value') =>
  new AppFailure('invalid_input', `${field}: ${why}`, reason, { field });

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
      case 'simChoice':
        if (!SIM_CHOICES.includes(value as SimChoice)) throw bad(key, 'auto, msfs or xplane');
        out.simChoice = value as SimChoice;
        break;
      case 'stationTemplate':
        if (typeof value !== 'string' || value.length > 32 || !STATION_RE.test(value)) {
          throw bad(key, 'letters, digits, {flight}, {airline}', 'station_template');
        }
        out.stationTemplate = value;
        break;
      case 'messageGapSec':
        if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 600) {
          throw bad(key, 'integer 0..600', 'message_gap');
        }
        out.messageGapSec = value as number;
        break;
      case 'bridgePort':
        if (!Number.isInteger(value) || (value as number) < 1024 || (value as number) > 65535) {
          throw bad(key, 'integer 1024..65535', 'bridge_port');
        }
        out.bridgePort = value as number;
        break;
      case 'aircraftIcaoHex':
        if (typeof value !== 'string' || !/^(?:[0-9A-Fa-f]{6})?$/.test(value)) {
          throw bad(key, 'six hex digits or empty', 'icao_hex');
        }
        out.aircraftIcaoHex = value.toUpperCase();
        break;
      case 'hubIcao':
        if (typeof value !== 'string' || !/^(?:[A-Za-z]{4})?$/.test(value)) {
          throw bad(key, 'four letters or empty', 'hub_icao');
        }
        out.hubIcao = value.toUpperCase();
        break;
      case 'droneRisk': {
        const t = parseDroneRisk(value);
        if (t === null) throw bad(key, `{country or *: 0..${DRONE_RISK_MAX}}`, 'drone_table');
        out.droneRisk = t;
        break;
      }
      case 'rescueTitles': {
        const t = parseRescueTitles(value);
        if (t === null) {
          throw bad(
            key,
            `{group: [titles]}, up to ${RESCUE_MAX_VEHICLES} per group, no |`,
            'rescue_titles',
          );
        }
        out.rescueTitles = t;
        break;
      }
      case 'rescueFlipped': {
        if (
          !Array.isArray(value) ||
          value.length > 64 ||
          !value.every((t) => typeof t === 'string' && TITLE_RE.test(t))
        ) {
          throw bad(key, 'a list of up to 64 titles, no |', 'rescue_flipped');
        }
        out.rescueFlipped = value as string[];
        break;
      }
      case 'simTime':
      case 'turnaround':
      case 'recordFlights':
      case 'liveData':
      case 'soundOnMessage':
      case 'messageHints':
      case 'xatc':
      case 'datalink':
      case 'datalinkSatcom':
      case 'datalinkHeaderInText':
      case 'xatcStandAside':
      case 'xatcRandomDirects':
      case 'specialSport':
      case 'specialAviation':
      case 'specialOther':
      case 'rescue':
        if (typeof value !== 'boolean') throw bad(key, 'true or false');
        out[key] = value;
        break;
      default:
        throw bad(key, 'unknown setting');
    }
  }
  return out;
}

/** A multiplier table (country or `*` → 0..100, at most 300 rows), else null. */
function parseDroneRisk(v: unknown): Record<string, number> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const entries = Object.entries(v);
  if (entries.length > 300) return null;
  const out: Record<string, number> = {};
  for (const [k, m] of entries) {
    if (!isDroneRiskKey(k) || !isDroneRiskValue(m)) return null;
    out[k] = Math.round(m * 100) / 100;
  }
  return out;
}

/** A SimObject title: printable ASCII without `|` (the bridge's separator), trimmed. */
const TITLE_RE = /^[\x21-\x7b\x7d\x7e](?:[\x20-\x7b\x7d\x7e]{0,126}[\x21-\x7b\x7d\x7e])?$/;

/** Every group of {@link RescueTitles}, each a list of titles; else null. */
function parseRescueTitles(v: unknown): RescueTitles | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (Object.keys(r).some((k) => !(RESCUE_TITLE_GROUPS as readonly string[]).includes(k))) {
    return null;
  }
  const out: Record<string, string[]> = {};
  for (const g of RESCUE_TITLE_GROUPS) {
    const list = r[g];
    if (!Array.isArray(list) || list.length > RESCUE_MAX_VEHICLES) return null;
    if (!list.every((t) => typeof t === 'string' && TITLE_RE.test(t))) return null;
    out[g] = list as string[];
  }
  return out as unknown as RescueTitles;
}

/** Keys of settings saved before T58 (the XATC station was called ROPS) → today's keys. */
const LEGACY_KEYS = {
  rops: 'xatc',
  ropsStandAside: 'xatcStandAside',
  ropsRandomDirects: 'xatcRandomDirects',
} as const;

/** Old keys read as today's; a today's key, when present, wins. */
function legacyKeys(r: Record<string, unknown>): Record<string, unknown> {
  const out = { ...r };
  for (const [old, key] of Object.entries(LEGACY_KEYS)) {
    if (old in out && !(key in out)) out[key] = out[old];
    delete out[old];
  }
  // T59 (decision of 2026-10-23): `simulator` before T59; its `msfs` was the default, so it becomes `auto`.
  if ('simulator' in out && !('simChoice' in out)) {
    out['simChoice'] = out['simulator'] === 'xplane' ? 'xplane' : 'auto';
  }
  delete out['simulator'];
  return out;
}

/** Settings from disk: unknown or bad values fall back to the defaults, one by one. */
export function sanitize(raw: unknown, defaults: Settings): Settings {
  if (typeof raw !== 'object' || raw === null) return defaults;
  const r = legacyKeys(raw as Record<string, unknown>);
  let s = defaults;
  const keys = [
    'language',
    'transport',
    'stationTemplate',
    'bridgePort',
    'simChoice',
    'recordFlights',
    'liveData',
    'soundOnMessage',
    'messageHints',
    'messageGapSec',
    'xatc',
    'datalink',
    'datalinkSatcom',
    'aircraftIcaoHex',
    'hubIcao',
    'simTime',
    'turnaround',
    'datalinkHeaderInText',
    'xatcStandAside',
    'xatcRandomDirects',
    'specialSport',
    'specialAviation',
    'specialOther',
    'rescue',
    'rescueTitles',
    'rescueFlipped',
    'droneRisk',
  ] as const;
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
  const chances: Record<string, number> = {};
  if (typeof r['chances'] === 'object' && r['chances'] !== null) {
    for (const [id, p] of Object.entries(r['chances'] as Record<string, unknown>)) {
      if (SCENARIO_ID_RE.test(id) && isChance(p)) chances[id] = p;
    }
  }
  return { ...s, scenarios, chances };
}

/** Percent 0–100, at most one decimal. */
export const isChance = (p: unknown): p is number =>
  typeof p === 'number' && p >= 0 && p <= 100 && Math.round(p * 10) === p * 10;

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
    if (!SCENARIO_ID_RE.test(id)) throw bad('scenario', 'bad id', 'unknown_scenario');
    const s = await this.get();
    return this.save({ ...s, scenarios: { ...s.scenarios, [id]: enabled } });
  }

  /** The same for several scenarios in one write (a whole category, U-10). */
  async setScenarios(ids: readonly string[], enabled: boolean): Promise<Settings> {
    for (const id of ids) {
      if (!SCENARIO_ID_RE.test(id)) throw bad('scenario', 'bad id', 'unknown_scenario');
    }
    const s = await this.get();
    const scenarios = { ...s.scenarios };
    for (const id of ids) scenarios[id] = enabled;
    return this.save({ ...s, scenarios });
  }

  /** Chance in percent, null = the scenario file's. */
  async setChance(id: string, percent: number | null): Promise<Settings> {
    if (!SCENARIO_ID_RE.test(id)) throw bad('scenario', 'bad id', 'unknown_scenario');
    if (percent !== null && !isChance(percent))
      throw bad('chance', '0..100, one decimal', 'chance_range');
    const s = await this.get();
    const chances = { ...s.chances };
    if (percent === null) delete chances[id];
    else chances[id] = percent;
    return this.save({ ...s, chances });
  }

  private async save(s: Settings): Promise<Settings> {
    await writeTextFileAtomic(this.file, `${JSON.stringify(s, null, 2)}\n`);
    this.current = s;
    return s;
  }
}
