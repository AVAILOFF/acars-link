import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CacheEntry, DataCache } from '@acars/data-sources';
import { readTextFile, writeTextFileAtomic } from './files.js';

/**
 * External-data cache on disk (T13): one JSON file per key in `<userData>/cache`, so OSM stands
 * (30 days) and the other sources survive a restart and the free APIs are asked less. The
 * service checks every value it reads back; a broken file is a cache miss.
 */
/** File name of a key: anything but A–Z, a–z, 0–9 and `-` becomes `_`. */
const name = (key: string) => key.replace(/[^A-Za-z0-9-]/g, '_');

export class FileDataCache implements DataCache {
  constructor(private readonly dir: string) {}

  private file(key: string): string {
    return join(this.dir, `${name(key)}.json`);
  }

  /**
   * Deletes the entries of keys starting with `prefix` fetched more than `maxAgeMs` before `now`,
   * and broken ones (T55 R5: AeroDataBox route statistics stay at most 7 days). Returns how many
   * went; errors leave a file for the next start.
   */
  async purgeOlder(prefix: string, maxAgeMs: number, now: number): Promise<number> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return 0;
    }
    let gone = 0;
    for (const f of files.filter((x) => x.startsWith(name(prefix)) && x.endsWith('.json'))) {
      const key = f.slice(0, -'.json'.length);
      const e = await this.get(key).catch(() => null);
      if (e !== null && now - e.t >= 0 && now - e.t <= maxAgeMs) continue;
      try {
        await rm(join(this.dir, f), { force: true });
        gone++;
      } catch {
        // Next start tries again.
      }
    }
    return gone;
  }

  async get(key: string): Promise<CacheEntry | null> {
    const text = await readTextFile(this.file(key));
    if (text === null) return null;
    try {
      const e = JSON.parse(text) as unknown;
      if (typeof e !== 'object' || e === null || typeof (e as CacheEntry).t !== 'number') {
        return null;
      }
      return { t: (e as CacheEntry).t, value: (e as CacheEntry).value };
    } catch {
      return null;
    }
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    await writeTextFileAtomic(this.file(key), JSON.stringify(entry));
  }
}
