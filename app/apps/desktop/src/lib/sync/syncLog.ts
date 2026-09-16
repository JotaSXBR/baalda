// The vault's recent sync history, in sentences.
//
// Everything the sync layer knows about why a vault is or is not synced already
// exists — as `console.info` lines nobody reading the Health page can see. This
// is the same information, kept in memory, in the words a user would use.
//
// Deliberately a pure leaf module: no imports beyond the shared type, so it runs
// under vitest in Node and can be read by any layer without creating a cycle
// (same posture as `vaultScope.ts`).

import type { SyncLogEntry, SyncLogLevel } from "../health/types";

export type { SyncLogEntry, SyncLogLevel };

/** Entries kept. Past this the oldest are dropped, so the buffer is bounded by
 *  a session's worst behaviour rather than by its length. */
export const SYNC_LOG_CAPACITY = 200;

/**
 * How close two identical events have to be to count as one.
 *
 * A reconnect storm is the case this exists for: a server that refuses a token
 * fails every doc in the vault in seconds, and a channel that flaps emits
 * "Connection lost" once per attempt. Writing each of those as its own line
 * fills a 200-entry buffer with one sentence repeated, pushing out the
 * registering/uploading history that actually explains the vault's state.
 *
 * Two seconds is wide enough to fold a burst and far too narrow to hide a real
 * sequence: a user watching the page sees the timestamp advance instead of a
 * new row, which is the honest rendering of "this is still happening".
 */
export const SYNC_LOG_COALESCE_MS = 2_000;

/** What a repeat has to match to fold into the entry before it. `message` is in
 *  the key on purpose: two `push-failed`s for the same doc with different
 *  reasons are two different facts. */
function sameEvent(a: SyncLogEntry, b: Omit<SyncLogEntry, "at">): boolean {
  return (
    a.event === b.event &&
    a.message === b.message &&
    (a.docId ?? null) === (b.docId ?? null)
  );
}

/**
 * A bounded, oldest-first ring of sync events with a subscription.
 *
 * One per vault session (`SyncManager` re-creates it on every enable and clears
 * it on teardown), because a line about the vault you left explains nothing
 * about the one you are looking at.
 */
export class SyncLog {
  private readonly cap: number;
  private buf: SyncLogEntry[] = [];
  private listeners = new Set<() => void>();

  constructor(cap: number = SYNC_LOG_CAPACITY) {
    this.cap = Math.max(1, cap);
  }

  /**
   * Record one event. `at` defaults to now; pass it only to make a test
   * deterministic.
   *
   * A repeat of the previous entry inside {@link SYNC_LOG_COALESCE_MS} bumps
   * that entry's timestamp instead of appending — the line stays the newest
   * thing on the page and says when it last happened, which is what a reader
   * wants from "reconnecting" repeated forty times.
   */
  push(entry: Omit<SyncLogEntry, "at"> & { at?: number }): void {
    const { at, ...rest } = entry;
    const stamp = at ?? Date.now();
    const last = this.buf[this.buf.length - 1];
    if (last && sameEvent(last, rest) && stamp - last.at <= SYNC_LOG_COALESCE_MS) {
      last.at = stamp;
      this.emit();
      return;
    }
    this.buf.push({ ...rest, at: stamp });
    if (this.buf.length > this.cap) this.buf.splice(0, this.buf.length - this.cap);
    this.emit();
  }

  /** Oldest first. A copy, so a consumer holding it across a later push sees a
   *  stable array (React's snapshot comparison depends on that). */
  entries(): SyncLogEntry[] {
    return this.buf.map((e) => ({ ...e }));
  }

  /** Returns the unsubscribe. */
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  clear(): void {
    if (this.buf.length === 0) return;
    this.buf = [];
    this.emit();
  }

  private emit(): void {
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch (e) {
        console.warn("[sync] sync-log listener threw", e);
      }
    }
  }
}
