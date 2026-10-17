import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Contents of `file`, or null when it does not exist. */
export async function readTextFile(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

let tmpSeq = 0;

/**
 * Write to a temp file, then rename: a crash never leaves a half-written file. Every write has
 * its own temp name, so two writes of the same file never share (and rename away) one temp file.
 */
export async function writeTextFileAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  tmpSeq++;
  const tmp = `${file}.${process.pid}.${tmpSeq}.tmp`;
  await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, file);
}

/**
 * Runs read-modify-write steps of one store one after another: two IPC calls that overlap
 * (a settings switch and a scenario switch) must not both read the old file and lose a change.
 */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}
