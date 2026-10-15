import { AppFailure } from './errors.js';
import { readTextFile, writeTextFileAtomic } from './files.js';

/**
 * User secrets (CLAUDE.md, invariant 2): encrypted by the OS store — Electron `safeStorage`
 * (Windows DPAPI, macOS Keychain, Linux Secret Service) — and kept as base64 in a file in the
 * app's user-data folder. Nothing is ever written in plain text: without the OS store the
 * secrets cannot be saved at all.
 */

export interface Cipher {
  available(): Promise<boolean>;
  encrypt(plain: string): Promise<Uint8Array>;
  decrypt(data: Uint8Array): Promise<string>;
}

/** `aerodataboxKey`: the user's RapidAPI key for AeroDataBox (T30). */
export type SecretKey = 'simbriefUsername' | 'hoppieLogon' | 'aerodataboxKey';
const KEYS: readonly SecretKey[] = ['simbriefUsername', 'hoppieLogon', 'aerodataboxKey'];

interface SecretFile {
  readonly v: 1;
  readonly entries: Partial<Record<SecretKey, string>>;
}

export class SecretStore {
  private cache: Partial<Record<SecretKey, string>> | null = null;

  constructor(
    private readonly file: string,
    private readonly cipher: Cipher,
  ) {}

  available(): Promise<boolean> {
    return this.cipher.available();
  }

  async has(key: SecretKey): Promise<boolean> {
    return (await this.entries())[key] !== undefined;
  }

  /** Decrypted value, or null when not stored (or no longer decryptable, e.g. another OS user). */
  async get(key: SecretKey): Promise<string | null> {
    const data = (await this.entries())[key];
    if (data === undefined || !(await this.cipher.available())) return null;
    try {
      return await this.cipher.decrypt(Buffer.from(data, 'base64'));
    } catch {
      return null;
    }
  }

  async set(key: SecretKey, value: string): Promise<void> {
    if (!(await this.cipher.available())) {
      throw new AppFailure('secure_storage_unavailable', 'OS secure storage is not available');
    }
    const enc = Buffer.from(await this.cipher.encrypt(value)).toString('base64');
    await this.save({ ...(await this.entries()), [key]: enc });
  }

  async delete(key: SecretKey): Promise<void> {
    const { [key]: _, ...rest } = await this.entries();
    await this.save(rest);
  }

  private async entries(): Promise<Partial<Record<SecretKey, string>>> {
    if (this.cache !== null) return this.cache;
    const text = await readTextFile(this.file);
    const out: Partial<Record<SecretKey, string>> = {};
    if (text !== null) {
      try {
        const parsed = JSON.parse(text) as Partial<SecretFile> | null;
        const entries = parsed?.entries ?? {};
        for (const k of KEYS) {
          const v = (entries as Record<string, unknown>)[k];
          if (typeof v === 'string' && v !== '') out[k] = v;
        }
      } catch {
        // Corrupt file: start empty; it is overwritten on the next save.
      }
    }
    this.cache = out;
    return out;
  }

  private async save(entries: Partial<Record<SecretKey, string>>): Promise<void> {
    const body: SecretFile = { v: 1, entries };
    await writeTextFileAtomic(this.file, `${JSON.stringify(body, null, 2)}\n`);
    this.cache = entries;
  }
}
