import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileRecordings, recordingName } from '../src/main/recording.js';
import { tempDir } from './support.js';

const T = Date.UTC(2026, 9, 8, 7, 45, 3);

describe('recording files', () => {
  it('names sort by UTC time and keep only safe characters', () => {
    expect(recordingName('sjx822', T)).toBe('20261008-074503-SJX822.jsonl');
    expect(recordingName('../x y', T)).toBe('20261008-074503-XY.jsonl');
    expect(recordingName('', T)).toBe('20261008-074503-FLIGHT.jsonl');
  });

  it('writes lines, never overwrites, keeps the newest N and leaves other files alone', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'notes.txt'), 'mine');
    const open = fileRecordings(dir, 3);
    const a = open('SJX822', T);
    a.write('{"a":1}\n');
    a.write('{"a":2}\n');
    a.close();
    a.close();
    expect(await readFile(a.file, 'utf8')).toBe('{"a":1}\n{"a":2}\n');

    const b = open('SJX822', T);
    expect(b.file).not.toBe(a.file);
    expect(b.file.endsWith('20261008-074503-SJX822-1.jsonl')).toBe(true);
    b.close();
    for (let i = 1; i <= 3; i++) open('SJX822', T + i * 60_000).close();
    expect((await readdir(dir)).sort()).toEqual([
      '20261008-074603-SJX822.jsonl',
      '20261008-074703-SJX822.jsonl',
      '20261008-074803-SJX822.jsonl',
      'notes.txt',
    ]);
  });
});
