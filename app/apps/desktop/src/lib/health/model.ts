// Vault Health — folding store + sync-layer state into the one report the
// Health tab renders.
//
// Pure and dependency-free, exactly like `syncRollup.ts` and `locks.ts`: plain
// data in, plain data out, no React, no Tauri, no store. Every input is passed
// by the hook (`useVaultHealth.ts`), so the whole verdict is unit-testable and
// so this module can never accidentally acquire a side effect.
//
// THE RULE THIS FILE EXISTS TO KEEP: honesty over optimism. The page is the
// answer to "is my work safe?", so nothing here may report a note as synced
// that nothing confirmed. The counts come straight from `buildTreeSyncIndex` —
// which already refuses to credit an unmapped note, keeps an honest denominator
// and tracks `unreported` separately — rather than being recomputed here, and
// the verdict degrades to the WORST applicable state rather than the friendliest.

import { buildTreeSyncIndex } from "../syncRollup";
// `format.ts` is the one place elapsed time is worded, so the verdict card's
// "Last confirmed …" cannot phrase it differently from the table rows directly
// under it. That module imports a type and nothing else, so this keeps the model
// dependency-free.
import { relativeTime } from "./format";
import { isBulkPhase, type DocSyncState, type SyncProgress } from "../sync/vaultScope";
import type { SyncStatus } from "../sync/syncManager";
import type { AuthStatus } from "../../store";
import type {
  HealthCounts,
  HealthIssue,
  HealthRemedy,
  HealthReport,
  HealthStage,
  HealthStageState,
  HealthVerdict,
  VaultStats,
} from "./types";

// ── Inputs ────────────────────────────────────────────────────────────────────

/** One note's content push that did not land. Mirrors `contentUpload.ts`
 *  `UploadFailure` and the `content` half of `SyncManager.syncFailures()`. */
export interface HealthContentFailure {
  docId: string;
  relPath: string;
  reason: string;
  /** Retrying cannot help (today: over `MAX_NOTE_BYTES`). */
  permanent?: boolean;
}

/** One row the registry could not create/move. Mirrors `registry.ts`
 *  `RegistryFailure`. Kept structural so the model needs no value import from
 *  the sync layer. */
export interface HealthRegistryFailure {
  kind: "folder" | "note" | "materialize" | "inbound" | "orphan";
  path: string;
  docId: string | null;
  reason: string;
  code: string | null;
}

/** Exactly what `syncManager.syncFailures()` returns. */
export interface HealthFailures {
  registry: HealthRegistryFailure[];
  content: HealthContentFailure[];
  /** The plan limit that stopped the run, if one did. */
  limitCode: string | null;
}

export interface HealthInput {
  /** `store.syncEnabled` — is the sync layer live for this vault? */
  syncEnabled: boolean;
  /** `store.syncStatus` — the OPEN doc's socket status (stale when none is open). */
  syncStatus: SyncStatus;
  /** `store.authStatus`. */
  authStatus: AuthStatus;
  /** True once a session object exists (`store.session != null`) — mirrors
   *  `notSyncingReason`'s own check, so a half-established session cannot read
   *  as signed in. */
  hasSession: boolean;
  /** `store.openFolderIsSynced`: the folder's own `.context` stamp, or null
   *  while the peek is still in flight. */
  openFolderIsSynced: boolean | null;
  syncProgress: SyncProgress | null;
  lastSyncedAt: number | null;
  /** `store.serverUrl`; only its host is shown. */
  serverUrl: string;
  now: number;
  /** `store.docIdByPath`. */
  docIdByPath: Record<string, string>;
  /** `store.docSyncState`. */
  docSyncState: Record<string, DocSyncState>;
  /** Every note path the local index knows (`store.titles`). */
  localNotePaths: Iterable<string>;
  failures: HealthFailures;
  /** The Rust census, when it has landed. */
  stats: VaultStats | null;
}

// ── Small text helpers (deliberately `Intl`-free) ─────────────────────────────

/** Thousands separators without pulling in `Intl` — the tests compare strings. */
export function num(n: number): string {
  const s = String(Math.trunc(Math.abs(n)));
  const grouped = s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return n < 0 ? `-${grouped}` : grouped;
}

function plural(n: number, word: string): string {
  return `${num(n)} ${word}${n === 1 ? "" : "s"}`;
}

/** Host of the server this vault syncs against, or null when unparseable. */
export function serverHostOf(serverUrl: string): string | null {
  try {
    const host = new URL(serverUrl).host;
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

// ── Failure → issue mapping ───────────────────────────────────────────────────

/** Plan-limit codes. Only two exist server-side today (`auth/auth.ts`), but any
 *  future `*_limit_reached` is the same conversation with the user. */
export function isLimitCode(code: string | null | undefined): boolean {
  return typeof code === "string" && code.endsWith("_limit_reached");
}

/**
 * Pull the two numbers out of `contentUpload.ts`'s too-large reason so the issue
 * can say "12.4 MB; the limit is 10 MB" in the user's own terms rather than
 * echoing an engineer's sentence. Two shapes exist — the FILE is over the cap,
 * or the doc's edit HISTORY is — and they have different remedies, so they are
 * told apart here rather than merged.
 */
function describeTooLarge(reason: string): string {
  const m = /\(([\d.]+) MB( of edit history)?; the limit is (\d+) MB\)/.exec(reason);
  if (!m) {
    // Unknown wording: quote the sync layer rather than invent a number.
    return `The server refused this note: ${reason}`;
  }
  const [, size, history, cap] = m;
  if (history) {
    return (
      `This note's edit history is ${size} MB; the server accepts up to ${cap} MB. ` +
      `Resetting its history clears the history without touching the note's text.`
    );
  }
  return (
    `This note is ${size} MB; the server accepts up to ${cap} MB. ` +
    `It has to get smaller before it can sync.`
  );
}

const TOO_LARGE_REMEDIES: HealthRemedy[] = ["open", "reveal", "reset-history", "delete"];
const UPLOAD_REMEDIES: HealthRemedy[] = ["retry", "open", "reveal"];

function contentIssue(f: HealthContentFailure): HealthIssue {
  if (f.permanent) {
    return {
      key: f.docId,
      docId: f.docId,
      path: f.relPath,
      kind: "too-large",
      severity: "error",
      title: "Too large to sync",
      why: describeTooLarge(f.reason),
      remedies: TOO_LARGE_REMEDIES,
      code: null,
    };
  }
  return {
    key: f.docId,
    docId: f.docId,
    path: f.relPath,
    kind: "upload-failed",
    severity: "error",
    title: "Couldn't upload",
    why:
      `This note's content did not reach the server. ${capitalize(f.reason)} ` +
      `Its only copy is on this device.`,
    remedies: UPLOAD_REMEDIES,
    code: null,
  };
}

function capitalize(s: string): string {
  const t = s.trim();
  if (t === "") return "";
  const head = t[0].toUpperCase() + t.slice(1);
  return /[.!?]$/.test(head) ? head : `${head}.`;
}

function registryIssue(f: HealthRegistryFailure): HealthIssue {
  const key = f.docId ?? f.path;
  if (isLimitCode(f.code)) {
    return {
      key,
      docId: f.docId,
      path: f.path,
      kind: "limit",
      severity: "error",
      title: "Plan limit reached",
      why:
        f.code === "member_limit_reached"
          ? "This vault has as many members as the free plan allows, so the server " +
            "refused. Upgrade to add more."
          : "This account has as many vaults as the free plan allows, so the server " +
            "refused to create more. Upgrade to keep syncing.",
      remedies: ["upgrade"],
      code: f.code,
    };
  }
  if (f.kind === "materialize" || f.kind === "inbound") {
    return {
      key,
      docId: f.docId,
      path: f.path,
      kind: "materialize-failed",
      severity: "error",
      title: "Couldn't write this to disk",
      why:
        `The server has this note, but it could not be written into your vault ` +
        `folder. ${capitalize(f.reason)}`,
      remedies: ["retry"],
      code: f.code,
    };
  }
  if (f.kind === "orphan") {
    // `registry.ts` records `orphan` for a file the server has deleted (or
    // revoked) whose content THIS device never confirmed upstream. It is left on
    // disk on purpose — removing it could destroy the only copy — and it stops
    // claiming its path so a later pass can re-register it.
    return {
      key,
      docId: f.docId,
      path: f.path,
      kind: "left-behind",
      severity: "error",
      title: "Left on disk — not on the server",
      why:
        `${capitalize(f.reason)} It was kept here rather than removed, because ` +
        `this device may hold the only copy. Open it to check, then delete it if ` +
        `you don't need it.`,
      remedies: ["open", "reveal", "delete"],
      code: f.code,
    };
  }
  const isFolder = f.kind === "folder";
  return {
    key,
    docId: f.docId,
    path: f.path,
    kind: "register-failed",
    severity: "error",
    title: isFolder ? "Folder couldn't be registered" : "Couldn't be registered",
    why:
      `The server has no row for this ${isFolder ? "folder" : "note"}, so nothing ` +
      `under it can sync. ${capitalize(f.reason)}`,
    remedies: isFolder ? ["retry", "reveal"] : UPLOAD_REMEDIES,
    code: f.code,
  };
}

/** Cap on the `unregistered` warnings emitted. A vault mid-registration can have
 *  thousands; 50 rows say everything 5,000 would, and the total lands in the
 *  report's `detail` instead of in 4,950 DOM nodes. */
export const MAX_UNREGISTERED_ISSUES = 50;

// ── The report ────────────────────────────────────────────────────────────────

function emptyCounts(): HealthCounts {
  return { total: 0, synced: 0, pending: 0, failed: 0, unsynced: 0, unreported: 0 };
}

/**
 * Mirrors `NotSyncingBanner.tsx` `notSyncingReason`'s signed-out half.
 *
 * Duplicated rather than imported: that function lives in a `.tsx` module that
 * imports React, and this one has to stay importable from a Node test with no
 * DOM. The three refusals are the same and must stay in lockstep — a folder that
 * was never a synced vault says nothing, `authStatus: "unknown"` says nothing
 * (it is the window between paint and session restore), and only then is a
 * missing session reported.
 */
function isSignedOutOnSyncedFolder(input: HealthInput): boolean {
  if (input.openFolderIsSynced !== true) return false;
  if (input.authStatus === "unknown") return false;
  return input.authStatus !== "signed-in" || !input.hasSession;
}

export function buildHealthReport(input: HealthInput): HealthReport {
  const serverHost = serverHostOf(input.serverUrl);
  const bulk = isBulkPhase(input.syncProgress?.phase);
  const signedOut = isSignedOutOnSyncedFolder(input);
  const signedIn = input.authStatus === "signed-in" && input.hasSession;

  const index = buildTreeSyncIndex({
    docIdByPath: input.docIdByPath,
    docSyncState: input.docSyncState,
    localNotePaths: input.localNotePaths,
  });
  const v = index.vault;
  const counts: HealthCounts = v
    ? {
        total: v.total,
        synced: v.synced,
        pending: v.pending,
        failed: v.failed,
        unsynced: Math.max(0, v.total - v.synced - v.pending - v.failed),
        unreported: v.unreported,
      }
    : emptyCounts();

  const { issues, unregisteredTotal } = buildIssues(input, {
    bulk,
    signedIn,
    mappedPaths: index.notes,
  });
  const errors = issues.filter((i) => i.severity === "error");

  const verdict = decideVerdict(input, { bulk, signedOut, counts, errors: errors.length });
  const stages = buildStages(input, { verdict, counts, issues, bulk, serverHost });
  const { headline, detail } = describe(input, {
    verdict,
    counts,
    errors: errors.length,
    serverHost,
    unregisteredTotal,
  });

  return {
    verdict,
    headline,
    detail,
    stages,
    counts: input.syncEnabled ? counts : null,
    issues,
    lastSyncedAt: input.lastSyncedAt,
    serverHost: input.syncEnabled ? serverHost : null,
  };
}

// ── Verdict ───────────────────────────────────────────────────────────────────

function decideVerdict(
  input: HealthInput,
  ctx: { bulk: boolean; signedOut: boolean; counts: HealthCounts; errors: number },
): HealthVerdict {
  if (!input.syncEnabled) return "local";
  if (ctx.signedOut) return "signed-out";
  if (input.syncStatus === "no-access") return "no-access";
  // A bulk run outranks the socket statuses, which belong to the OPEN doc and
  // read "offline" whenever no note is on screen — including through the whole
  // of a launch backfill. Work that is demonstrably moving is not offline.
  // (This is the one place the precedence list is reordered, and only here.)
  if (ctx.bulk) return "syncing";
  if (input.syncStatus === "offline") return "offline";
  if (input.syncStatus === "connecting") return "connecting";
  if (ctx.errors > 0 || ctx.counts.failed > 0 || input.syncProgress?.phase === "error") {
    return "attention";
  }
  // Nothing errored, but notes are still not on the server. `healthy` means
  // EVERYTHING confirmed, so this cannot be it — a settled run that left a note
  // behind is precisely the silent divergence this page exists to expose.
  //
  // `unreported` is excluded, and that exclusion is load-bearing: a mapped note
  // nobody has spoken for yet is not work (see `syncRollup.ts`), and counting it
  // would put every fresh launch into `attention` until the first batch of
  // `synced` stamps lands.
  const remaining = ctx.counts.total - ctx.counts.synced - ctx.counts.unreported;
  if (remaining > 0) return "attention";
  return "healthy";
}

// ── Issues ────────────────────────────────────────────────────────────────────

function buildIssues(
  input: HealthInput,
  ctx: { bulk: boolean; signedIn: boolean; mappedPaths: Map<string, DocSyncState> },
): { issues: HealthIssue[]; unregisteredTotal: number } {
  const issues: HealthIssue[] = [];
  const seen = new Set<string>();
  const push = (issue: HealthIssue): void => {
    if (seen.has(issue.key)) return;
    seen.add(issue.key);
    issues.push(issue);
  };

  // Content first: these are the failures that name a specific note whose only
  // copy is here.
  for (const f of input.failures.content) push(contentIssue(f));
  for (const f of input.failures.registry) push(registryIssue(f));

  // A limit that stopped the run but was recorded against nothing the user can
  // see still has to be said once.
  if (isLimitCode(input.failures.limitCode) && !issues.some((i) => i.kind === "limit")) {
    push({
      key: `limit:${input.failures.limitCode}`,
      docId: null,
      path: null,
      kind: "limit",
      severity: "error",
      title: "Plan limit reached",
      why: "The server stopped this sync run at a plan limit. Upgrade to continue.",
      remedies: ["upgrade"],
      code: input.failures.limitCode,
    });
  }

  if (input.syncEnabled && ctx.signedIn && input.syncStatus === "no-access") {
    push({
      key: "vault:no-access",
      docId: null,
      path: null,
      kind: "no-access",
      severity: "error",
      title: "No access to this vault",
      why:
        "The server refused a sync token for this vault, so nothing is uploading " +
        "or downloading. Ask the vault's owner to share it with you again.",
      remedies: [],
      code: null,
    });
  }

  // Notes on disk the registry has never mapped. Only meaningful once the run is
  // NOT in a bulk phase: during registration every unmapped note is simply
  // in-flight, and warning about it would turn a working vault into a wall of
  // alarms for as long as the pass takes.
  let unregisteredTotal = 0;
  if (input.syncEnabled && ctx.signedIn && !ctx.bulk && input.syncStatus !== "no-access") {
    const failedPaths = new Set<string>([
      ...input.failures.registry.map((f) => f.path),
      ...input.failures.content.map((f) => f.relPath),
    ]);
    for (const path of ctx.mappedPaths.keys()) {
      if (input.docIdByPath[path] !== undefined) continue;
      if (failedPaths.has(path)) continue;
      unregisteredTotal++;
      if (unregisteredTotal > MAX_UNREGISTERED_ISSUES) continue;
      push({
        key: path,
        docId: null,
        path,
        kind: "unregistered",
        severity: "warn",
        title: "Not on the server yet",
        why:
          "This note exists only on this device: the server has no row for it, " +
          "and nothing has reported a failure. A sync run should pick it up.",
        remedies: ["retry", "open", "reveal"],
        code: null,
      });
    }
  }

  const orphanDocs = input.stats?.history.orphanDocs ?? 0;
  if (orphanDocs > 0) {
    push({
      key: "history:orphans",
      docId: null,
      path: null,
      kind: "orphan-history",
      severity: "warn",
      title: "Reclaimable edit history",
      why:
        `This vault's local index still holds edit history for ${plural(orphanDocs, "note")} ` +
        `it no longer has. Reclaiming it frees the space and changes nothing you can see.`,
      remedies: ["reclaim"],
      code: null,
    });
  }

  issues.sort(compareIssues);
  return { issues, unregisteredTotal };
}

/** Errors before warnings; within a severity, by path (vault-level issues, which
 *  have no path, sort first because they explain the rest). Total and stable. */
function compareIssues(a: HealthIssue, b: HealthIssue): number {
  if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
  if (a.path === null && b.path !== null) return -1;
  if (a.path !== null && b.path === null) return 1;
  if (a.path !== null && b.path !== null && a.path !== b.path) {
    return a.path < b.path ? -1 : 1;
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

// ── Stages ────────────────────────────────────────────────────────────────────

function buildStages(
  input: HealthInput,
  ctx: {
    verdict: HealthVerdict;
    counts: HealthCounts;
    issues: HealthIssue[];
    bulk: boolean;
    serverHost: string | null;
  },
): HealthStage[] {
  const { verdict, counts, issues, serverHost } = ctx;
  const stats = input.stats;
  const off = !input.syncEnabled;

  // The FIRST stage that explains the verdict carries the error; every later one
  // stays quiet, so the diagram points at one place rather than lighting up.
  const connectionBroken =
    verdict === "signed-out" || verdict === "no-access" || verdict === "offline";
  const hasError = issues.some((i) => i.severity === "error");

  const disk: HealthStage = {
    id: "disk",
    label: "Files on disk",
    state: "ok",
    headline: num(stats ? stats.notes.count : counts.total),
    detail: stats
      ? `${plural(stats.notes.count, "note")}, ${plural(stats.folders, "folder")} and ` +
        `${plural(stats.attachments.count + stats.otherFiles.count, "other file")} in this vault.`
      : `${plural(counts.total, "note")} in this vault.`,
  };

  const index: HealthStage = {
    id: "index",
    label: "Local index",
    state: "ok",
    headline: stats ? num(stats.notes.count) : "Indexed",
    detail: stats
      ? `${plural(stats.tags, "tag")} and ${plural(stats.links, "link")} indexed` +
        (stats.brokenLinks > 0
          ? `, plus ${plural(stats.brokenLinks, "link")} that point at nothing.`
          : ".")
      : "Search and links are built from the local index.",
  };

  const orphanDocs = stats?.history.orphanDocs ?? 0;
  const history: HealthStage = {
    id: "history",
    label: "Local history",
    state: orphanDocs > 0 ? "warn" : "ok",
    headline: stats ? num(stats.history.docs) : "—",
    detail: stats
      ? `${plural(stats.history.docs, "note")} have edit history stored on this device` +
        (orphanDocs > 0
          ? `, of which ${num(orphanDocs)} belong to notes this vault no longer has.`
          : ".")
      : "Edit history is kept locally so offline edits merge instead of clobbering.",
  };

  const connection: HealthStage = {
    id: "connection",
    label: "Connection",
    state: off
      ? "off"
      : connectionBroken
        ? "error"
        : verdict === "connecting"
          ? "busy"
          : input.syncStatus === "read-only"
            ? "warn"
            : "ok",
    headline: off
      ? "Off"
      : verdict === "signed-out"
        ? "Signed out"
        : verdict === "no-access"
          ? "No access"
          : verdict === "offline"
            ? "Offline"
            : verdict === "connecting"
              ? "Reconnecting…"
              : input.syncStatus === "read-only"
                ? "View only"
                : "Connected",
    detail: off
      ? "This vault is not connected to any server."
      : verdict === "signed-out"
        ? "Sign in to start syncing again. Edits stay on this device until you do."
        : verdict === "no-access"
          ? "The server refused a sync token for this vault."
          : verdict === "offline"
            ? `Not reachable right now${serverHost ? ` · ${serverHost}` : ""}.`
            : verdict === "connecting"
              ? "Establishing the connection."
              : input.syncStatus === "read-only"
                ? "You have view-only access, so your edits stay on this device."
                : `Connected${serverHost ? ` to ${serverHost}` : ""}.`,
  };

  const serverState: HealthStageState = off
    ? "off"
    : connectionBroken
      ? "ok" // the connection stage already owns this failure
      : ctx.bulk
        ? "busy"
        : hasError || counts.failed > 0
          ? "error"
          : counts.unreported > 0 || counts.unsynced > 0
            ? "warn"
            : "ok";

  const server: HealthStage = {
    id: "server",
    label: "Server",
    state: serverState,
    headline: off ? "—" : num(counts.synced),
    detail: off
      ? "Turn on sync to keep a copy on the server."
      : `${num(counts.synced)} of ${plural(counts.total, "note")} confirmed on the server` +
        (serverHost ? ` · ${serverHost}` : "") +
        ".",
  };

  return [disk, index, history, connection, server];
}

// ── Headline / detail ─────────────────────────────────────────────────────────

function describe(
  input: HealthInput,
  ctx: {
    verdict: HealthVerdict;
    counts: HealthCounts;
    errors: number;
    serverHost: string | null;
    unregisteredTotal: number;
  },
): { headline: string; detail: string } {
  const { verdict, counts, errors, serverHost } = ctx;
  const behind = Math.max(0, counts.total - counts.synced);
  const where = serverHost ? ` · ${serverHost}` : "";
  const last =
    input.lastSyncedAt != null
      ? `Last confirmed ${relativeTime(input.lastSyncedAt, input.now)}`
      : "Nothing confirmed yet this session";
  const overflow =
    ctx.unregisteredTotal > MAX_UNREGISTERED_ISSUES
      ? ` Showing the first ${num(MAX_UNREGISTERED_ISSUES)} of ${num(ctx.unregisteredTotal)} unregistered notes.`
      : "";

  switch (verdict) {
    case "local":
      return {
        headline: "Sync is off for this folder",
        detail:
          `${plural(counts.total, "note")} live here on this device only. ` +
          `Turn on sync to reach your other devices and your team.`,
      };
    case "signed-out":
      return {
        headline: "Signed out — nothing is syncing",
        detail:
          `This vault syncs with${serverHost ? ` ${serverHost}` : " its server"}. ` +
          `Sign in to resume. Your edits are safe on disk in the meantime.`,
      };
    case "no-access":
      return {
        headline: "You no longer have access to this vault",
        detail:
          `The server refused a sync token, so nothing is moving in either ` +
          `direction. Ask the vault's owner to share it with you again.${where}`,
      };
    case "offline":
      return {
        headline: `Offline — ${num(counts.synced)} of ${plural(counts.total, "note")} are on the server`,
        detail: `${last}. Syncing resumes on its own when the connection comes back.${where}`,
      };
    case "connecting":
      return {
        headline: "Connecting…",
        detail: `${last}${where}.`,
      };
    case "syncing": {
      const p = input.syncProgress;
      const of = p && p.total > 0 ? `${num(p.done)} of ${num(p.total)}` : num(behind);
      return {
        headline: `Syncing — ${of}`,
        detail:
          `${num(counts.synced)} of ${plural(counts.total, "note")} are confirmed so far` +
          `${where}.${overflow}`,
      };
    }
    case "attention":
      return {
        headline:
          behind === 0
            ? `${plural(errors, "thing")} need${errors === 1 ? "s" : ""} you`
            : errors > 0
              ? `${plural(behind, "note")} not on the server — ${num(errors)} need you`
              : `${plural(behind, "note")} ${behind === 1 ? "is" : "are"} not on the server`,
        detail: `${last}${where}.${overflow}`,
      };
    case "healthy":
    default:
      return {
        headline:
          counts.total === 0
            ? "This vault is empty"
            : `All ${plural(counts.total, "note")} are on the server`,
        detail: `${last}${where}.${overflow}`,
      };
  }
}
