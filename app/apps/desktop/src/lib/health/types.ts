// Shared contract for Vault Settings → Health: the page that answers "what is
// synced, what is not, why, and what is in this vault".
//
// Three producers meet here and MUST agree on these shapes:
//   - Rust `vault_stats` (src-tauri) serialises a `VaultStats` (camelCase).
//   - `lib/health/model.ts` folds store + sync-layer state into a `HealthReport`.
//   - `components/HealthTab.tsx` renders both and drives `HealthActions`.
//
// Pure types only. No imports from React, Tauri or the store, so the model and
// its tests stay dependency-free like `syncRollup.ts`.

// ── Vault analytics (Rust) ─────────────────────────────────────────────────────

/** One file, for "largest" lists. `bytes` is the on-disk size. */
export interface SizedFile {
  path: string;
  bytes: number;
  /** Last modification, ms since epoch. */
  mtime: number;
}

/** One note's local CRDT footprint (the `.context/index.sqlite` yjs tables). */
export interface HistoryFootprint {
  docId: string;
  /** The note's path when the index still knows the doc, else null (orphan). */
  path: string | null;
  /** `yjs_updates` rows for this doc. */
  updates: number;
  /** Bytes across its update log AND its snapshot. */
  bytes: number;
}

/**
 * A one-shot census of the open vault, computed by Rust in one pass over the
 * disk (same ignore rules as the tree: `.context/`, `.git`, dotfiles skipped)
 * plus a few aggregate queries over the SQLite index. Cheap enough to recompute
 * on demand; never cached across vaults.
 */
export interface VaultStats {
  /** When this census was taken, ms since epoch. */
  computedAt: number;
  notes: {
    /** Files the index treats as notes (rows in `notes`). */
    count: number;
    bytes: number;
    /** Notes whose file is 0 bytes. */
    empty: number;
  };
  /** Directories under the vault root (ignored ones excluded). */
  folders: number;
  /** Files under the vault-root `attachments/` store. */
  attachments: { count: number; bytes: number };
  /** Every other non-ignored file (images/PDFs next to notes, code, …). */
  otherFiles: { count: number; bytes: number };
  /** Distinct tags in the index. */
  tags: number;
  /** Wikilinks the index resolved to a note. */
  links: number;
  /** Wikilinks that point at no note. */
  brokenLinks: number;
  /** `index.sqlite` (+ its WAL) on disk. */
  index: { bytes: number };
  /** The local CRDT store, in aggregate. */
  history: {
    /** Distinct doc ids with any update or snapshot. */
    docs: number;
    updates: number;
    /** Update log + snapshots, all docs. */
    bytes: number;
    /** Docs whose id is not in `notes` any more — reclaimable. */
    orphanDocs: number;
    orphanBytes: number;
  };
  /** Top 10 by file size, largest first. */
  largestNotes: SizedFile[];
  /** Top 10 across `attachments/` and other files, largest first. */
  largestFiles: SizedFile[];
  /** Top 10 by CRDT bytes, heaviest first. */
  heaviestHistory: HistoryFootprint[];
  activity: {
    modifiedLast7d: number;
    modifiedLast30d: number;
    /** Notes modified per rolling 7-day window for the last 12 windows,
     *  OLDEST first; index 11 is the window ending now. */
    weeks: number[];
  };
}

// ── Sync health (TS model) ─────────────────────────────────────────────────────

/**
 * The one-word answer at the top of the page, most urgent first when several
 * apply. `local` = sync is off for this vault; `attention` = synced vault with
 * at least one issue the user must act on; `healthy` = everything confirmed.
 */
export type HealthVerdict =
  | "local"
  | "signed-out"
  | "no-access"
  | "offline"
  | "connecting"
  | "syncing"
  | "attention"
  | "healthy";

export type HealthStageId = "disk" | "index" | "history" | "connection" | "server";

export type HealthStageState = "ok" | "busy" | "warn" | "error" | "off";

/**
 * One node of the pipeline diagram: files on disk → local index → local
 * history (CRDT) → connection → server. The FIRST non-ok stage, left to right,
 * is where the problem is; the diagram highlights that edge.
 */
export interface HealthStage {
  id: HealthStageId;
  label: string;
  state: HealthStageState;
  /** Big number or short status under the label, e.g. "1,204" or "Connected". */
  headline: string;
  /** One sentence for the tooltip / expanded row. */
  detail: string;
}

export type HealthIssueKind =
  /** Over the server's per-note cap; retrying cannot help. */
  | "too-large"
  /** Content push failed for a reason a retry may fix. */
  | "upload-failed"
  /** The registry could not create/move the server row. */
  | "register-failed"
  /** The server refused for a plan limit (`vault_limit_reached`, …). */
  | "limit"
  /** A note on disk with no server mapping and no failure recorded yet. */
  | "unregistered"
  /** Server says the doc exists but this user may not read it. */
  | "no-access"
  /** The server deleted or revoked this note but this device never confirmed
   *  its content upstream, so the file was left on disk rather than removed. */
  | "left-behind"
  /** A server note could not be written to disk. */
  | "materialize-failed"
  /** Local CRDT history for a doc the vault no longer has. */
  | "orphan-history";

export type HealthRemedy =
  | "retry"
  | "open"
  | "reveal"
  | "delete"
  | "upgrade"
  | "reset-history"
  | "reclaim"
  | "sign-in";

export interface HealthIssue {
  /** Stable key for React and for de-duplication: the docId when known, else the path. */
  key: string;
  docId: string | null;
  path: string | null;
  kind: HealthIssueKind;
  severity: "error" | "warn";
  /** Short label, e.g. "Too large to sync". */
  title: string;
  /** Plain-language cause, e.g. "This note is 12.4 MB; the server accepts up to 10 MB." */
  why: string;
  /** Offered in this order. Empty ⇒ informational only. */
  remedies: HealthRemedy[];
  /** Server error code when one was carried. */
  code: string | null;
}

/** The vault's per-note tally — the same numbers the sidebar dots roll up. */
export interface HealthCounts {
  total: number;
  synced: number;
  /** Queued or syncing right now. */
  pending: number;
  failed: number;
  /** No server mapping, or reported unsynced. */
  unsynced: number;
  /** Mapped but nothing reported yet this session (see `syncRollup.ts`). */
  unreported: number;
}

export interface HealthReport {
  verdict: HealthVerdict;
  /** e.g. "All 1,204 notes are on the server". */
  headline: string;
  /** e.g. "Last confirmed 2 minutes ago · api.baalda.com". */
  detail: string;
  stages: HealthStage[];
  /** Null when sync is off for this vault. */
  counts: HealthCounts | null;
  /** Errors first, then warnings; stable order within a severity. */
  issues: HealthIssue[];
  lastSyncedAt: number | null;
  /** Host of the server this vault syncs against, or null when local. */
  serverHost: string | null;
}

// ── Actions the page can take ──────────────────────────────────────────────────

export interface HealthActions {
  /** Re-pull the registry and re-run the content pass for everything unconfirmed. */
  syncNow(): Promise<void>;
  /** Re-queue ONE note's content, clearing any remembered permanent failure. */
  retryDoc(docId: string): Promise<void>;
  /** Discard a note's CRDT history everywhere and re-seed from its file. */
  resetHistory(docId: string): Promise<{ bytesFreed: number }>;
  /** Drop orphan CRDT docs and vacuum the index. */
  reclaimOrphans(): Promise<{ docsRemoved: number; bytesReclaimed: number }>;
  openNote(path: string): void;
  /** Show the file in Finder / Explorer. */
  reveal(path: string): Promise<void>;
  /** The sidebar's delete (soft, server-aware). */
  deleteNote(path: string): Promise<void>;
  openUpgrade(): void;
  requestSignIn(): void;
  /** Build the plain-text diagnostic bundle and copy it; returns the text. */
  copyDiagnostics(): Promise<string>;
}

/** What `useVaultHealth()` hands the tab. */
export interface VaultHealthSnapshot {
  report: HealthReport;
  stats: VaultStats | null;
  statsError: string | null;
  /** True while the first census is in flight. */
  loading: boolean;
  refresh(): void;
  actions: HealthActions;
}
