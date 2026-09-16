// The React half of Vault Settings → Health: read the store and the sync layer,
// fold them through the pure model, and expose the actions the page can take.
//
// Everything with a decision in it lives in `model.ts` (pure, tested); this file
// is wiring only. The split is deliberate — the verdict a user is going to trust
// should not be reachable only through a rendered component.
//
// Nothing here invents a server route. Every action is an existing code path:
// the sidebar's own delete, the sync pill's retry, the startup CRDT sweep, the
// copy-link clipboard helper.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import * as ipc from "../ipc";
import { useStore } from "../../store";
import { syncManager } from "../sync/docSession";
import { collectCrdtGarbage } from "../sync/crdtGc";
import { deletePaths } from "../vault/mutatePaths";
import { removeFromOrder } from "../ordering";
import { copyText } from "../clipboard";
import { buildHealthReport, type HealthFailures, type HealthInput } from "./model";
import type { HealthActions, VaultHealthSnapshot, VaultStats } from "./types";

export interface UseVaultHealthOptions {
  /** Open the billing/upgrade surface. Absent ⇒ the `upgrade` remedy no-ops. */
  onOpenUpgrade?: () => void;
  /** Put the sign-in card up. Absent ⇒ the `sign-in` remedy no-ops. */
  onRequestSignIn?: () => void;
}

/** Empty failure set — what the sync layer reports when it isn't running. */
const NO_FAILURES: HealthFailures = { registry: [], content: [], limitCode: null };

export function useVaultHealth(options: UseVaultHealthOptions = {}): VaultHealthSnapshot {
  const vault = useStore((s) => s.vault);
  const syncEnabled = useStore((s) => s.syncEnabled);
  const syncStatus = useStore((s) => s.syncStatus);
  const authStatus = useStore((s) => s.authStatus);
  const hasSession = useStore((s) => s.session != null);
  const openFolderIsSynced = useStore((s) => s.openFolderIsSynced);
  const syncProgress = useStore((s) => s.syncProgress);
  const lastSyncedAt = useStore((s) => s.lastSyncedAt);
  const serverUrl = useStore((s) => s.serverUrl);
  const docIdByPath = useStore((s) => s.docIdByPath);
  const docSyncState = useStore((s) => s.docSyncState);
  const titles = useStore((s) => s.titles);

  const [stats, setStats] = useState<VaultStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** Bumped by `refresh()` and by any action that changes what a census would
   *  say (reclaim, reset-history). */
  const [nonce, setNonce] = useState(0);

  const vaultPath = vault?.path ?? null;
  const vaultEpoch = vault?.epoch;

  // ── The Rust census ────────────────────────────────────────────────────────
  // Re-run on vault change and on every `refresh()`. A response that lands after
  // the vault moved on is dropped: it describes a folder the page is no longer
  // showing, and the epoch pin only protects Rust's side of that race.
  useEffect(() => {
    if (!vaultPath) {
      setStats(null);
      setStatsError(null);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    // The registry's ids are the second live id space (see `crdtGc.ts`): without
    // them a server-pulled note's history reads as an orphan the sweep then
    // refuses to remove — "18 reclaimable" beside a Reclaim that frees nothing.
    const liveDocs: Record<string, string> = {};
    for (const [path, docId] of Object.entries(useStore.getState().docIdByPath)) {
      liveDocs[docId] = path;
    }
    void ipc
      .vaultStats(liveDocs, vaultEpoch)
      .then((s) => {
        if (!live) return;
        setStats(s);
        setStatsError(null);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setStats(null);
        setStatsError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [vaultPath, vaultEpoch, nonce, docIdByPath]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // ── Sync-layer failures ────────────────────────────────────────────────────
  // `syncFailures()` is a synchronous read of state the sync layer already holds,
  // so there is nothing to poll: re-reading it whenever progress, per-doc state
  // or the socket status moves covers every transition that can create or clear
  // one.
  const failures = useMemo<HealthFailures>(() => {
    try {
      return syncManager.syncFailures();
    } catch {
      return NO_FAILURES;
    }
    // The deps are deliberately the store fields that MOVE when a failure could
    // have appeared or cleared, not the things the body reads: `syncManager` is a
    // process singleton with a stable identity, so listing it would change
    // nothing.
  }, [syncProgress, docSyncState, syncStatus, syncEnabled, nonce]);

  const localNotePaths = useMemo(() => titles.map((t) => t.path), [titles]);

  const report = useMemo(() => {
    const input: HealthInput = {
      syncEnabled,
      syncStatus,
      authStatus,
      hasSession,
      openFolderIsSynced,
      syncProgress,
      lastSyncedAt,
      serverUrl,
      now: Date.now(),
      docIdByPath,
      docSyncState,
      localNotePaths,
      failures,
      stats,
    };
    return buildHealthReport(input);
  }, [
    syncEnabled,
    syncStatus,
    authStatus,
    hasSession,
    openFolderIsSynced,
    syncProgress,
    lastSyncedAt,
    serverUrl,
    docIdByPath,
    docSyncState,
    localNotePaths,
    failures,
    stats,
  ]);

  // ── Actions ────────────────────────────────────────────────────────────────
  // Kept in a ref-backed object so the identity is stable across renders: the
  // tab passes these straight to row buttons, and a fresh object every render
  // would defeat any memoisation there.
  const reportRef = useRef(report);
  reportRef.current = report;
  const statsRef = useRef(stats);
  statsRef.current = stats;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const actions = useMemo<HealthActions>(
    () => ({
      syncNow: () => syncManager.retrySync(),

      retryDoc: (docId: string) => syncManager.retryDoc(docId),

      resetHistory: (docId: string) => syncManager.resetNoteHistory(docId),

      async reclaimOrphans() {
        // The live set must be COMPLETE — Rust refuses an empty one, and an
        // incomplete one would delete a live note's unsynced edits. Reuse the
        // startup sweep's own wiring rather than assembling a second allow-list:
        // it unions the registry's doc ids with the local index's `notes.id`, and
        // the open note is pinned on top.
        const st = useStore.getState();
        const openPath = st.openNote?.path;
        const pinned = openPath ? [st.docIdByPath[openPath]].filter(Boolean) : [];
        const out = await collectCrdtGarbage(
          { registryDocIds: () => syncManager.registry.allDocIds() },
          { epoch: st.vault?.epoch ?? undefined, pinned: pinned as string[] },
        );
        refresh();
        return {
          docsRemoved: out?.docsRemoved ?? 0,
          bytesReclaimed: out?.bytesReclaimed ?? 0,
        };
      },

      openNote(path: string) {
        void useStore.getState().openNoteByPath(path);
      },

      async reveal(path: string) {
        const root = useStore.getState().vault?.path;
        if (!root) return;
        await ipc.revealInFileManager(`${root}/${path}`);
      },

      async deleteNote(path: string) {
        // The sidebar's delete, verbatim: server row first (so a refusal leaves
        // the file alone instead of producing a reappearing ghost), then disk.
        const st = useStore.getState();
        const { deleted, failed } = await deletePaths([path], {
          epoch: st.vault?.epoch,
          deleteDisk: (p, epoch) => ipc.deletePath(p, epoch),
          unregister: (p) => syncManager.registry.deletePath(p),
        });
        if (failed.length > 0) throw new Error(failed[0].reason);
        if (deleted.length === 0) return;
        st.setItemOrder(removeFromOrder(st.itemOrder, path));
        st.pruneTabs([path]);
        refresh();
      },

      openUpgrade() {
        optionsRef.current.onOpenUpgrade?.();
      },

      requestSignIn() {
        optionsRef.current.onRequestSignIn?.();
      },

      async copyDiagnostics() {
        const text = await buildDiagnostics(reportRef.current, statsRef.current);
        await copyText(text);
        return text;
      },
    }),
    [refresh],
  );

  // A reset discards history on both sides, so the census it produced is stale.
  // Wrapping here (rather than inside the memo) keeps `actions` stable.
  const wrapped = useMemo<HealthActions>(
    () => ({
      ...actions,
      async resetHistory(docId: string) {
        const out = await actions.resetHistory(docId);
        refresh();
        return out;
      },
    }),
    [actions, refresh],
  );

  return { report, stats, statsError, loading, refresh, actions: wrapped };
}

// ── Diagnostics bundle ────────────────────────────────────────────────────────

/**
 * A plain-text dump for a bug report. Deliberately boring and deliberately
 * complete: it is what someone pastes into an issue instead of a screenshot.
 *
 * NO SECRETS. The server URL's host, the vault's name and the two server ids go
 * in — those are what make a report actionable — but never a token, a session,
 * an email, or the contents of any note.
 */
export async function buildDiagnostics(
  report: VaultHealthSnapshot["report"],
  stats: VaultStats | null,
): Promise<string> {
  const st = useStore.getState();
  let version = "unknown";
  try {
    version = await getVersion();
  } catch {
    /* not running under Tauri */
  }
  const platform =
    typeof navigator === "undefined" ? "unknown" : navigator.userAgent || "unknown";

  const lines: string[] = [];
  lines.push("Baalda vault health");
  lines.push(`app: ${version}`);
  lines.push(`platform: ${platform}`);
  lines.push(`server: ${report.serverHost ?? "(local only)"}`);
  lines.push(`vault: ${st.vault?.name ?? "(none)"}`);
  lines.push(`org id: ${st.session?.activeOrganizationId ?? "(none)"}`);
  lines.push(`collection id: ${syncManager.registry.vaultId ?? "(none)"}`);
  lines.push("");
  lines.push(`verdict: ${report.verdict}`);
  lines.push(`headline: ${report.headline}`);
  lines.push(`detail: ${report.detail}`);
  lines.push(
    `last synced: ${report.lastSyncedAt != null ? new Date(report.lastSyncedAt).toISOString() : "never"}`,
  );
  lines.push("");

  const c = report.counts;
  lines.push("counts:");
  if (!c) {
    lines.push("  (sync is off for this vault)");
  } else {
    lines.push(
      `  total=${c.total} synced=${c.synced} pending=${c.pending} ` +
        `failed=${c.failed} unsynced=${c.unsynced} unreported=${c.unreported}`,
    );
  }
  lines.push("");

  lines.push("stages:");
  for (const s of report.stages) {
    lines.push(`  ${s.id} [${s.state}] ${s.headline} — ${s.detail}`);
  }
  lines.push("");

  lines.push(`issues (${report.issues.length}):`);
  if (report.issues.length === 0) lines.push("  (none)");
  for (const i of report.issues) {
    lines.push(
      `  [${i.severity}] ${i.kind}` +
        `${i.code ? ` code=${i.code}` : ""}` +
        `${i.docId ? ` doc=${i.docId}` : ""}` +
        `${i.path ? ` path=${i.path}` : ""}`,
    );
    lines.push(`    ${i.why}`);
  }
  lines.push("");

  lines.push("stats:");
  if (!stats) {
    lines.push("  (not available)");
  } else {
    lines.push(
      `  notes=${stats.notes.count} bytes=${stats.notes.bytes} empty=${stats.notes.empty}`,
    );
    lines.push(
      `  folders=${stats.folders} attachments=${stats.attachments.count}/${stats.attachments.bytes} ` +
        `otherFiles=${stats.otherFiles.count}/${stats.otherFiles.bytes}`,
    );
    lines.push(
      `  tags=${stats.tags} links=${stats.links} brokenLinks=${stats.brokenLinks} ` +
        `index=${stats.index.bytes}`,
    );
    lines.push(
      `  history docs=${stats.history.docs} updates=${stats.history.updates} ` +
        `bytes=${stats.history.bytes} orphans=${stats.history.orphanDocs}/${stats.history.orphanBytes}`,
    );
    lines.push(
      `  activity 7d=${stats.activity.modifiedLast7d} 30d=${stats.activity.modifiedLast30d}`,
    );
  }
  return lines.join("\n");
}
