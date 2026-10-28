// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { AppError, ErrorCode, ErrorReason, Result } from '../shared/api.js';

/**
 * An expected failure the UI shows to the user (translated by `code`, and by `reason` when the
 * detail is ours: T56 U-14). `detail` is the English text for logs.
 */
export class AppFailure extends Error {
  override readonly name = 'AppFailure';
  constructor(
    readonly code: ErrorCode,
    readonly detail: string,
    readonly reason?: ErrorReason,
    readonly params?: Readonly<Record<string, string>>,
  ) {
    super(`${code}: ${detail}`);
  }
}

export function toAppError(e: unknown): AppError {
  if (e instanceof AppFailure) {
    return {
      code: e.code,
      detail: e.detail,
      ...(e.reason === undefined ? {} : { reason: e.reason }),
      ...(e.params === undefined ? {} : { params: e.params }),
    };
  }
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
