// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { FeedEntry, SystemCode } from '../shared/api.js';

type Outbound = Extract<FeedEntry, { kind: 'outbound' }>;
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** Message feed shown in the UI: newest last, at most `cap` entries. */
export class Feed {
  private list: FeedEntry[] = [];
  private seq = 0;
  /** Bumped on every change, for cheap "did anything change" checks. */
  version = 0;

  constructor(private readonly cap = 300) {}

  get entries(): readonly FeedEntry[] {
    return this.list;
  }

  add(entry: DistributiveOmit<FeedEntry, 'id'>): string {
    this.seq++;
    const id = `f${this.seq}`;
    this.list.push({ ...entry, id } as FeedEntry);
    if (this.list.length > this.cap) this.list.splice(0, this.list.length - this.cap);
    this.version++;
    return id;
  }

  system(t: number, code: SystemCode, params: Record<string, string> = {}): string {
    return this.add({ kind: 'system', t, code, params });
  }

  /** The feed now, to go back to when what follows fails (T64: a flight that cannot be restored). */
  save(): { readonly list: readonly FeedEntry[]; readonly seq: number } {
    return { list: [...this.list], seq: this.seq };
  }

  restore(s: { readonly list: readonly FeedEntry[]; readonly seq: number }): void {
    this.list = [...s.list];
    this.seq = s.seq;
    this.version++;
  }

  updateOutbound(id: string, patch: Partial<Pick<Outbound, 'delivery' | 'detail' | 't'>>): void {
    const i = this.list.findIndex((e) => e.id === id);
    const e = this.list[i];
    if (e === undefined || e.kind !== 'outbound') return;
    this.list[i] = { ...e, ...patch };
    this.version++;
  }
}
