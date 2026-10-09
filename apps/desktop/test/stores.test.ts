import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppFailure } from '../src/main/errors.js';
import { SecretStore } from '../src/main/secrets.js';
import { defaultSettings, SettingsStore, sanitize, validatePatch } from '../src/main/settings.js';
import { FakeCipher, tempDir } from './support.js';

describe('SecretStore (OS-encrypted file)', () => {
  it('round-trips values; the file holds only ciphertext', async () => {
    const dir = await tempDir();
    const file = join(dir, 'secrets.json');
    const store = new SecretStore(file, new FakeCipher());
    expect(await store.get('hoppieLogon')).toBeNull();
    await store.set('hoppieLogon', 'SECRETCODE123');
    await store.set('simbriefUsername', 'pilot42');
    expect(await store.has('hoppieLogon')).toBe(true);

    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain('SECRETCODE123');
    expect(raw).not.toContain('pilot42');

    const reopened = new SecretStore(file, new FakeCipher());
    expect(await reopened.get('hoppieLogon')).toBe('SECRETCODE123');
    expect(await reopened.get('simbriefUsername')).toBe('pilot42');
    await reopened.delete('hoppieLogon');
    expect(await new SecretStore(file, new FakeCipher()).has('hoppieLogon')).toBe(false);
  });

  it('refuses to save without the OS store (never falls back to plain text)', async () => {
    const dir = await tempDir();
    const cipher = new FakeCipher();
    cipher.ok = false;
    const store = new SecretStore(join(dir, 'secrets.json'), cipher);
    await expect(store.set('hoppieLogon', 'X')).rejects.toMatchObject({
      code: 'secure_storage_unavailable',
    });
  });

  it('a corrupt or undecryptable file reads as empty', async () => {
    const dir = await tempDir();
    const file = join(dir, 'secrets.json');
    await writeFile(file, '{not json');
    expect(await new SecretStore(file, new FakeCipher()).get('hoppieLogon')).toBeNull();
    await writeFile(file, JSON.stringify({ v: 1, entries: { hoppieLogon: 'Zm9v' } }));
    expect(await new SecretStore(file, new FakeCipher()).get('hoppieLogon')).toBeNull();
  });
});

describe('settings', () => {
  const defaults = defaultSettings('en-US');

  it('defaults: language from the OS locale, OPS{flight}, bridge port 47830, Hoppie', () => {
    expect(defaults).toEqual({
      language: 'en',
      transport: 'hoppie',
      stationTemplate: 'OPS{flight}',
      bridgePort: 47830,
      recordFlights: true,
      liveData: true,
      soundOnMessage: false,
      messageGapSec: 60,
      rops: false,
      ropsStandAside: true,
      ropsRandomDirects: true,
      specialSport: true,
      specialAviation: true,
      specialOther: true,
      scenarios: {},
      chances: {},
    });
    expect(defaultSettings('ru-RU').language).toBe('ru');
  });

  it('validates patches from the renderer', () => {
    expect(validatePatch({ language: 'ru', stationTemplate: '{airline}OPS' })).toEqual({
      language: 'ru',
      stationTemplate: '{airline}OPS',
    });
    for (const bad of [
      { language: 'de' },
      { transport: 'sayintentions' },
      { stationTemplate: 'OPS {flight}' },
      { stationTemplate: '{callsign}' },
      { stationTemplate: '' },
      { bridgePort: 80 },
      { bridgePort: 47830.5 },
      { recordFlights: 'yes' },
      { rops: 1 },
      { ropsStandAside: 'no' },
      { ropsRandomDirects: 'off' },
      { messageGapSec: -1 },
      { messageGapSec: 1.5 },
      { messageGapSec: 601 },
      { scenarios: {} },
      { chances: {} },
      { evil: 1 },
      null,
      [],
    ]) {
      expect(() => validatePatch(bad), JSON.stringify(bad)).toThrow(AppFailure);
    }
  });

  it('sanitizes the file field by field', () => {
    expect(
      sanitize(
        {
          language: 'ru',
          transport: 'carrier-pigeon',
          bridgePort: 47831,
          recordFlights: 'no',
          scenarios: { fuel_slip: false, 'BAD ID': true, crew_info: 'yes' },
          chances: { medical_onboard: 25, dg_notoc: 150, vip_onboard: 2.55, 'BAD ID': 5 },
        },
        defaults,
      ),
    ).toEqual({
      ...defaults,
      language: 'ru',
      bridgePort: 47831,
      scenarios: { fuel_slip: false },
      chances: { medical_onboard: 25 },
    });
    expect(sanitize({ recordFlights: false }, defaults).recordFlights).toBe(false);
    expect(sanitize('garbage', defaults)).toEqual(defaults);
  });

  it('persists updates and scenario switches', async () => {
    const file = join(await tempDir(), 'settings.json');
    const store = new SettingsStore(file, defaults);
    await store.update({ transport: 'offline' });
    await store.setScenario('fuel_slip', false);
    const again = await new SettingsStore(file, defaults).get();
    expect(again.transport).toBe('offline');
    expect(again.scenarios).toEqual({ fuel_slip: false });
    await expect(store.setScenario('../x', true)).rejects.toThrow(AppFailure);
    await store.setChance('medical_onboard', 12.5);
    await store.setChance('dg_notoc', 0);
    expect((await new SettingsStore(file, defaults).get()).chances).toEqual({
      medical_onboard: 12.5,
      dg_notoc: 0,
    });
    await store.setChance('dg_notoc', null);
    expect((await store.get()).chances).toEqual({ medical_onboard: 12.5 });
    await expect(store.setChance('dg_notoc', 101)).rejects.toThrow(AppFailure);
    await expect(store.setChance('dg_notoc', 1.25)).rejects.toThrow(AppFailure);
  });
});
