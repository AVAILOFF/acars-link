import { join } from 'node:path';
import type { CacheEntry, DataCache } from '@acars/data-sources';
import { readTextFile, writeTextFileAtomic } from './files.js';

/**
 * External-data cache on disk (T13): one JSON file per key in `<userData>/cache`, so OSM stands
 * (30 days) and the other sources survive a restart and the free APIs are asked less. The
 * service checks every value it reads back; a broken file is a cache miss.
 */
export class FileDataCache implements DataCache {
  constructor(private readonly dir: string) {}

  private file(key: string): string {
    return join(this.dir, `${key.replace(/[^A-Za-z0-9-]/g, '_')}.json`);
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
