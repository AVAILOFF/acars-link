import type { AppError, ErrorCode, Result } from '../shared/api.js';

/** An expected failure the UI shows to the user (translated by `code`). */
export class AppFailure extends Error {
  override readonly name = 'AppFailure';
  constructor(
    readonly code: ErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

export function toAppError(e: unknown): AppError {
  if (e instanceof AppFailure) return { code: e.code, detail: e.detail };
  // Unexpected errors: only the message. Our transports and stores never put secrets into
  // error messages (see `fetchHttpClient`), so it is safe to show.
  return { code: 'internal', detail: e instanceof Error ? e.message : String(e) };
}

/** Runs `fn` and turns any throw into `{ ok: false }`, so IPC never rejects. */
export async function guard<T>(fn: () => T | Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: toAppError(e) };
  }
}
