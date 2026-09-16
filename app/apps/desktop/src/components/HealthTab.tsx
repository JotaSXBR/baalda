/* Vault Settings → Health. The page that answers, in this order: is my work
   safe, where exactly does the pipeline stop, what do I have to do about it,
   and what is in this vault.

   Split in two on purpose. `HealthTab` is the container: it owns the hook, the
   upgrade dialog and nothing else. `HealthView` is pure — hand it a
   `VaultHealthSnapshot` and it renders, which is what lets a fixture drive it
   without a vault, a server or a Tauri host underneath.

   The whole page has to survive a vault that has never synced: `report.counts`
   is null, the last two pipeline stages are `off`, and the analytics below are
   still the point. Nothing here may assume a server. */
import { useEffect, useMemo, useState } from "react";
import type {
  HealthActions,
  HealthIssue,
  HealthStage,
  HistoryFootprint,
  SizedFile,
  VaultHealthSnapshot,
  VaultStats,
} from "../lib/health/types";
import { useVaultHealth } from "../lib/health/useVaultHealth";
import {
  formatBytes,
  middleTruncate,
  relativeTime,
  verdictLabel,
  verdictTone,
} from "../lib/health/format";
import { MAX_NOTE_BYTES } from "../lib/sync/contentUpload";
import { toast } from "../lib/toast";
import { AsyncButton } from "./AsyncButton";
import { ConfirmDialog } from "./ConfirmDialog";
import { UpgradeDialog } from "./UpgradeDialog";
import "./health.css";

/** Amber before the hard ceiling: a note this size is one paste from being
 *  refused, and the warning is only useful while it can still be acted on. */
const NOTE_WARN_BYTES = 8 * 1024 * 1024;

/** Past this many issues the list needs a way to narrow itself. */
const FILTER_AT = 5;

/** Characters of a path that fit on one row before the middle is elided. */
const PATH_CHARS = 52;

export interface HealthTabProps {
  /** Open the plan dialog. Omitted ⇒ this tab raises its own, like Billing. */
  onOpenUpgrade?: () => void;
  onRequestSignIn?: () => void;
  /** Jump to General, where sync is turned on. */
  onGoToGeneral?: () => void;
  /** Close settings — opening a note has to get the dialog out of the way. */
  onClose?: () => void;
}

export function HealthTab({
  onOpenUpgrade,
  onRequestSignIn,
  onGoToGeneral,
  onClose,
}: HealthTabProps) {
  // Same shape as the Billing and Members tabs: the dialog is rendered by the
  // tab that needs it rather than hoisted into VaultSettingsDialog, so the
  // upgrade path is self-contained wherever it is raised from. A caller may
  // still pass its own opener.
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const snapshot = useVaultHealth({
    onOpenUpgrade: onOpenUpgrade ?? (() => setUpgradeOpen(true)),
    onRequestSignIn,
  });

  return (
    <>
      <HealthView
        snapshot={snapshot}
        onGoToGeneral={onGoToGeneral}
        onClose={onClose}
      />
      {upgradeOpen && <UpgradeDialog onClose={() => setUpgradeOpen(false)} />}
    </>
  );
}

// ── The page ──────────────────────────────────────────────────────────────────

type ConfirmState =
  | { kind: "delete"; path: string }
  | { kind: "reset"; docId: string; path: string | null };

export function HealthView({
  snapshot,
  onGoToGeneral,
  onClose,
}: {
  snapshot: VaultHealthSnapshot;
  onGoToGeneral?: () => void;
  onClose?: () => void;
}) {
  const { report, stats, statsError, loading, refresh, actions } = snapshot;
  // Relative times go stale while the dialog sits open; a slow tick is enough
  // and costs one render a minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const [confirming, setConfirming] = useState<ConfirmState | null>(null);

  const openNote = (path: string) => {
    actions.openNote(path);
    // The note is behind the settings card; leaving it open would look like
    // nothing happened.
    onClose?.();
  };

  const reclaim = async () => {
    const { docsRemoved, bytesReclaimed } = await actions.reclaimOrphans();
    toast(
      docsRemoved === 0
        ? "Nothing to reclaim"
        : `Reclaimed ${formatBytes(bytesReclaimed)} from ${docsRemoved.toLocaleString()} ` +
            `orphan ${docsRemoved === 1 ? "doc" : "docs"}`,
    );
  };

  return (
    <div className="health-tab">
      <VerdictCard snapshot={snapshot} onRefresh={refresh} loading={loading} />

      <Pipeline stages={report.stages} />

      <div className="subhead">Sync</div>
      {report.counts ? (
        <SyncBreakdown counts={report.counts} />
      ) : (
        <div className="health-local-row">
          <span className="muted">Sync is off for this folder.</span>
          {onGoToGeneral && (
            <button type="button" className="link-btn" onClick={onGoToGeneral}>
              Turn on sync
            </button>
          )}
        </div>
      )}

      <div className="subhead">Needs attention</div>
      <IssueList
        issues={report.issues}
        actions={actions}
        onOpenNote={openNote}
        onConfirm={setConfirming}
        onReclaim={reclaim}
      />

      <div className="subhead">Vault at a glance</div>
      <StatTiles
        stats={stats}
        loading={loading}
        statsError={statsError}
        onReclaim={reclaim}
      />

      {stats && (
        <>
          <div className="subhead">Activity</div>
          <Activity activity={stats.activity} />

          <div className="subhead">Largest</div>
          <Largest
            stats={stats}
            now={now}
            onOpenNote={openNote}
            onReveal={actions.reveal}
            onResetHistory={(docId, path) =>
              setConfirming({ kind: "reset", docId, path })
            }
          />
        </>
      )}

      {confirming?.kind === "delete" && (
        <ConfirmDialog
          title="Delete this note?"
          confirmLabel="Delete"
          onCancel={() => setConfirming(null)}
          onConfirm={async () => {
            await actions.deleteNote(confirming.path);
            setConfirming(null);
          }}
        >
          <p className="muted">
            <code>{confirming.path}</code> is removed from this vault, and from
            every device that syncs it. A vault checkpoint can bring it back.
          </p>
        </ConfirmDialog>
      )}
      {confirming?.kind === "reset" && (
        <ConfirmDialog
          title="Reset this note's history?"
          confirmLabel="Reset history"
          onCancel={() => setConfirming(null)}
          onConfirm={async () => {
            const { bytesFreed } = await actions.resetHistory(confirming.docId);
            setConfirming(null);
            toast(`History reset · ${formatBytes(bytesFreed)} freed`);
          }}
        >
          <p className="muted">
            {confirming.path ? <code>{confirming.path}</code> : "This document"}{" "}
            starts over from the file on disk. The text you have now is kept, but
            the edit history behind it is discarded on every device, and undo
            cannot reach past this point.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

// ── Verdict ───────────────────────────────────────────────────────────────────

function VerdictCard({
  snapshot,
  onRefresh,
  loading,
}: {
  snapshot: VaultHealthSnapshot;
  onRefresh: () => void;
  loading: boolean;
}) {
  const { report, actions } = snapshot;
  const [copied, setCopied] = useState(false);
  const tone = verdictTone(report.verdict);
  const syncing = report.verdict === "syncing" || report.verdict === "connecting";
  const local = report.verdict === "local";
  // Signed out is a verdict, not an issue row (the model emits no `sign-in`
  // remedy), so the way back in lives here: there is no sync run to retry until
  // a session exists, and a disabled "Sync now" would say nothing about why.
  const signedOut = report.verdict === "signed-out";

  const copy = async () => {
    await actions.copyDiagnostics();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="health-verdict" data-tone={tone}>
      <div className="health-verdict-main">
        <span className="health-pill" data-tone={tone}>
          {verdictLabel(report.verdict)}
        </span>
        <h3 className="health-headline">{report.headline}</h3>
        {/* The model already folds "Last confirmed …" and the server host into
            `detail` (see `model.ts` → `describe`), so the card prints it
            verbatim rather than assembling a second, contradictory version. */}
        <p className="health-detail">{report.detail}</p>
      </div>
      <div className="health-verdict-actions">
        {signedOut ? (
          <button
            type="button"
            className="primary sm"
            onClick={() => actions.requestSignIn()}
          >
            Sign in
          </button>
        ) : (
          <AsyncButton
            className="primary sm"
            spinnerTone="on-accent"
            disabled={syncing || local}
            title={
              local
                ? "This folder does not sync"
                : syncing
                  ? "Already syncing"
                  : undefined
            }
            onClick={() => actions.syncNow()}
          >
            Sync now
          </AsyncButton>
        )}
        <button
          type="button"
          className="ghost-pill sm"
          disabled={loading}
          onClick={onRefresh}
        >
          Refresh
        </button>
        <AsyncButton className="ghost-pill sm" onClick={copy}>
          {copied ? "Copied ✓" : "Copy diagnostics"}
        </AsyncButton>
      </div>
    </div>
  );
}

// ── Pipeline diagram ──────────────────────────────────────────────────────────

/** A stage that is `off` is not a fault — a local vault's connection and server
 *  nodes are simply not in play — so the diagnosis walks past it looking for the
 *  first stage that is actually degraded or moving. */
function isSettled(stage: HealthStage): boolean {
  return stage.state === "ok" || stage.state === "off";
}

function Pipeline({ stages }: { stages: HealthStage[] }) {
  // The first unsettled stage is where the pipeline stops; -1 when everything
  // that can be confirmed is confirmed.
  const focus = stages.findIndex((s) => !isSettled(s));
  const [picked, setPicked] = useState<number | null>(null);
  // A pick survives until the diagnosis itself moves, so re-reading a stage
  // does not fight the auto-focus on the next poll.
  useEffect(() => setPicked(null), [focus]);

  const shown = picked ?? (focus >= 0 ? focus : stages.length - 1);
  const legend = stages[shown];
  if (stages.length === 0) return null;

  return (
    <div className="health-pipeline-wrap">
      <ol className="health-pipeline" aria-label="Sync pipeline">
        {stages.map((stage, i) => (
          <li key={stage.id} className="health-stage-cell">
            {i > 0 && (
              <span
                className="health-edge"
                data-state={stages[i].state}
                data-broken={i === focus ? "" : undefined}
                aria-hidden="true"
              />
            )}
            <button
              type="button"
              className="health-node"
              data-state={stage.state}
              data-focus={i === focus ? "" : undefined}
              data-picked={i === shown ? "" : undefined}
              title={stage.detail}
              aria-current={i === shown ? "step" : undefined}
              onClick={() => setPicked(i)}
            >
              <span className="health-node-dot" aria-hidden="true" />
              <span className="health-node-label">{stage.label}</span>
              <span className="health-node-headline">{stage.headline}</span>
            </button>
          </li>
        ))}
      </ol>
      {legend && (
        <p className="health-legend" data-state={legend.state}>
          <strong>{legend.label}</strong> {legend.detail}
        </p>
      )}
    </div>
  );
}

// ── Sync breakdown ────────────────────────────────────────────────────────────

function SyncBreakdown({
  counts,
}: {
  counts: NonNullable<VaultHealthSnapshot["report"]["counts"]>;
}) {
  const segments = [
    { key: "synced", label: "Synced", value: counts.synced, tone: "good" },
    { key: "pending", label: "Syncing", value: counts.pending, tone: "busy" },
    { key: "failed", label: "Failed", value: counts.failed, tone: "bad" },
    {
      key: "unsynced",
      label: "Not on server",
      value: counts.unsynced,
      tone: "warn",
    },
    // The fifth segment is what keeps the bar honest: a mapped note nobody has
    // reported on yet is neither synced nor failed, and folding it into either
    // would make the bar claim something the sync layer has not said.
    {
      key: "unreported",
      label: "Not confirmed yet",
      value: counts.unreported,
      tone: "muted",
    },
  ].filter((s) => s.value > 0);

  // Widths come off the segments' own sum, not `total`, so the bar always fills
  // its track even if the tallies disagree by a note.
  const sum = segments.reduce((n, s) => n + s.value, 0);
  const pct =
    counts.total > 0 ? Math.floor((counts.synced / counts.total) * 100) : 100;

  return (
    <div className="health-breakdown">
      <div
        className="health-bar"
        role="img"
        aria-label={`${counts.synced.toLocaleString()} of ${counts.total.toLocaleString()} notes synced`}
      >
        {sum === 0 ? (
          <span className="health-bar-seg" data-tone="muted" style={{ width: "100%" }} />
        ) : (
          segments.map((s) => (
            <span
              key={s.key}
              className="health-bar-seg"
              data-tone={s.tone}
              style={{ width: `${(s.value / sum) * 100}%` }}
              title={`${s.label} · ${s.value.toLocaleString()}`}
            />
          ))
        )}
      </div>
      <p className="health-bar-caption">
        {pct}% of {counts.total.toLocaleString()}{" "}
        {counts.total === 1 ? "note" : "notes"} confirmed on the server
      </p>
      <ul className="health-legend-list">
        {segments.map((s) => (
          <li key={s.key}>
            <span className="health-swatch" data-tone={s.tone} aria-hidden="true" />
            {s.label}
            <strong>{s.value.toLocaleString()}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Issues ────────────────────────────────────────────────────────────────────

type IssueFilter = "all" | "error" | "warn";

function IssueList({
  issues,
  actions,
  onOpenNote,
  onConfirm,
  onReclaim,
}: {
  issues: HealthIssue[];
  actions: HealthActions;
  onOpenNote: (path: string) => void;
  onConfirm: (c: ConfirmState) => void;
  onReclaim: () => Promise<void>;
}) {
  const [filter, setFilter] = useState<IssueFilter>("all");
  const shown = useMemo(
    () => (filter === "all" ? issues : issues.filter((i) => i.severity === filter)),
    [issues, filter],
  );

  if (issues.length === 0) {
    return (
      <div className="health-empty">
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
        Nothing needs attention
      </div>
    );
  }

  const errors = issues.filter((i) => i.severity === "error").length;

  return (
    <>
      {issues.length > FILTER_AT && (
        <div className="health-chips" role="group" aria-label="Filter issues">
          {(
            [
              ["all", `All ${issues.length}`],
              ["error", `Errors ${errors}`],
              ["warn", `Warnings ${issues.length - errors}`],
            ] as Array<[IssueFilter, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`health-chip${filter === id ? " active" : ""}`}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {shown.length === 0 ? (
        <div className="muted perm-empty">Nothing in this category.</div>
      ) : (
        <ul className="health-issues">
          {shown.map((issue) => (
            <IssueRow
              key={issue.key}
              issue={issue}
              actions={actions}
              onOpenNote={onOpenNote}
              onConfirm={onConfirm}
              onReclaim={onReclaim}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function IssueRow({
  issue,
  actions,
  onOpenNote,
  onConfirm,
  onReclaim,
}: {
  issue: HealthIssue;
  actions: HealthActions;
  onOpenNote: (path: string) => void;
  onConfirm: (c: ConfirmState) => void;
  onReclaim: () => Promise<void>;
}) {
  return (
    <li className="health-issue" data-severity={issue.severity}>
      <span className="health-dot" data-severity={issue.severity} aria-hidden="true" />
      <div className="health-issue-main">
        <span className="health-issue-title">{issue.title}</span>
        {issue.path && (
          <span className="health-path" title={issue.path}>
            {middleTruncate(issue.path, PATH_CHARS)}
          </span>
        )}
        <span className="health-why">{issue.why}</span>
      </div>
      <div className="health-issue-actions">
        {issue.remedies.map((remedy) => {
          switch (remedy) {
            case "retry":
              return issue.docId ? (
                <AsyncButton
                  key={remedy}
                  className="ghost-pill sm"
                  onClick={() => actions.retryDoc(issue.docId as string)}
                >
                  Retry
                </AsyncButton>
              ) : null;
            case "open":
              return issue.path ? (
                <button
                  key={remedy}
                  type="button"
                  className="link-btn"
                  onClick={() => onOpenNote(issue.path as string)}
                >
                  Open
                </button>
              ) : null;
            case "reveal":
              return issue.path ? (
                <AsyncButton
                  key={remedy}
                  className="link-btn"
                  onClick={() => actions.reveal(issue.path as string)}
                >
                  Reveal
                </AsyncButton>
              ) : null;
            case "delete":
              return issue.path ? (
                <button
                  key={remedy}
                  type="button"
                  className="link-btn danger"
                  onClick={() => onConfirm({ kind: "delete", path: issue.path as string })}
                >
                  Delete
                </button>
              ) : null;
            case "upgrade":
              return (
                <button
                  key={remedy}
                  type="button"
                  className="primary sm"
                  onClick={() => actions.openUpgrade()}
                >
                  Upgrade
                </button>
              );
            case "reset-history":
              return issue.docId ? (
                <button
                  key={remedy}
                  type="button"
                  className="link-btn danger"
                  onClick={() =>
                    onConfirm({
                      kind: "reset",
                      docId: issue.docId as string,
                      path: issue.path,
                    })
                  }
                >
                  Reset history
                </button>
              ) : null;
            case "reclaim":
              return (
                <AsyncButton key={remedy} className="ghost-pill sm" onClick={onReclaim}>
                  Reclaim
                </AsyncButton>
              );
            case "sign-in":
              return (
                <button
                  key={remedy}
                  type="button"
                  className="primary sm"
                  onClick={() => actions.requestSignIn()}
                >
                  Sign in
                </button>
              );
            default:
              return null;
          }
        })}
      </div>
    </li>
  );
}

// ── Vault at a glance ─────────────────────────────────────────────────────────

function StatTiles({
  stats,
  loading,
  statsError,
  onReclaim,
}: {
  stats: VaultStats | null;
  loading: boolean;
  statsError: string | null;
  onReclaim: () => Promise<void>;
}) {
  if (!stats) {
    return (
      <>
        {statsError && <div className="auth-error">{statsError}</div>}
        <ul className="health-tiles" aria-busy={loading || undefined}>
          {Array.from({ length: 9 }, (_, i) => (
            <li key={i} className="health-tile is-skeleton" aria-hidden="true">
              <span className="health-tile-value" />
              <span className="health-tile-label" />
            </li>
          ))}
        </ul>
        {!loading && !statsError && (
          <p className="muted">These numbers are not available for this vault yet.</p>
        )}
      </>
    );
  }

  const totalBytes =
    stats.notes.bytes + stats.attachments.bytes + stats.otherFiles.bytes;
  const tiles: Array<{ label: string; value: string; sub?: string }> = [
    { label: "Notes", value: stats.notes.count.toLocaleString() },
    { label: "Folders", value: stats.folders.toLocaleString() },
    {
      label: "Attachments",
      value: stats.attachments.count.toLocaleString(),
      sub: formatBytes(stats.attachments.bytes),
    },
    { label: "Tags", value: stats.tags.toLocaleString() },
    {
      label: "Links",
      value: stats.links.toLocaleString(),
      sub:
        stats.brokenLinks > 0
          ? `${stats.brokenLinks.toLocaleString()} broken`
          : "none broken",
    },
    { label: "Empty notes", value: stats.notes.empty.toLocaleString() },
    {
      label: "Total size",
      value: formatBytes(totalBytes),
      sub:
        stats.otherFiles.count > 0
          ? `${stats.otherFiles.count.toLocaleString()} other files`
          : undefined,
    },
    { label: "Index size", value: formatBytes(stats.index.bytes) },
  ];

  const orphans = stats.history.orphanDocs;

  return (
    <>
      {statsError && <div className="auth-error">{statsError}</div>}
      <ul className="health-tiles">
        {tiles.map((t) => (
          <li key={t.label} className="health-tile">
            <span className="health-tile-value">{t.value}</span>
            <span className="health-tile-label">{t.label}</span>
            {t.sub && <span className="health-tile-sub">{t.sub}</span>}
          </li>
        ))}
        <li className="health-tile">
          <span className="health-tile-value">{formatBytes(stats.history.bytes)}</span>
          <span className="health-tile-label">History size</span>
          <span className="health-tile-sub">
            {orphans > 0
              ? `${orphans.toLocaleString()} orphan ${orphans === 1 ? "doc" : "docs"} · ${formatBytes(stats.history.orphanBytes)} reclaimable`
              : `${stats.history.docs.toLocaleString()} docs · ${stats.history.updates.toLocaleString()} updates`}
          </span>
          {orphans > 0 && (
            <AsyncButton className="ghost-pill sm health-tile-action" onClick={onReclaim}>
              Reclaim
            </AsyncButton>
          )}
        </li>
      </ul>
    </>
  );
}

// ── Activity ──────────────────────────────────────────────────────────────────

function Activity({ activity }: { activity: VaultStats["activity"] }) {
  const weeks = activity.weeks ?? [];
  const peak = Math.max(1, ...weeks);
  const caption =
    `${activity.modifiedLast7d.toLocaleString()} ${activity.modifiedLast7d === 1 ? "note" : "notes"} ` +
    `edited in the last 7 days · ${activity.modifiedLast30d.toLocaleString()} in 30 days`;

  return (
    <div className="health-activity">
      <div
        className="health-bars"
        role="img"
        aria-label={`Notes edited per week over the last ${weeks.length} weeks: ${weeks.join(", ")}. ${caption}`}
      >
        {weeks.map((n, i) => (
          <span
            key={i}
            className="health-week"
            data-current={i === weeks.length - 1 ? "" : undefined}
            style={{ height: `${Math.max(3, (n / peak) * 100)}%` }}
            title={
              i === weeks.length - 1
                ? `This week · ${n.toLocaleString()}`
                : `${weeks.length - 1 - i} ${weeks.length - 2 === i ? "week" : "weeks"} ago · ${n.toLocaleString()}`
            }
          />
        ))}
      </div>
      <p className="health-detail">{caption}</p>
    </div>
  );
}

// ── Largest ───────────────────────────────────────────────────────────────────

function sizeBadge(bytes: number): "bad" | "warn" | null {
  if (bytes >= MAX_NOTE_BYTES) return "bad";
  if (bytes >= NOTE_WARN_BYTES) return "warn";
  return null;
}

function fileName(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut >= 0 ? path.slice(cut + 1) : path;
}

function Largest({
  stats,
  now,
  onOpenNote,
  onReveal,
  onResetHistory,
}: {
  stats: VaultStats;
  now: number;
  onOpenNote: (path: string) => void;
  onReveal: (path: string) => Promise<void>;
  onResetHistory: (docId: string, path: string | null) => void;
}) {
  return (
    <div className="health-largest">
      <LargestFiles
        title="Largest notes"
        rows={stats.largestNotes}
        now={now}
        empty="No notes yet."
        onReveal={onReveal}
        onOpenNote={onOpenNote}
      />
      <LargestFiles
        title="Largest files"
        rows={stats.largestFiles}
        now={now}
        empty="No attachments or other files."
        onReveal={onReveal}
      />
      <section className="health-table-block">
        <h4 className="health-table-title">Heaviest history</h4>
        {stats.heaviestHistory.length === 0 ? (
          <p className="muted">No local edit history yet.</p>
        ) : (
          <table className="health-table">
            <thead>
              <tr>
                <th scope="col">Note</th>
                <th scope="col" className="health-num">
                  Updates
                </th>
                <th scope="col" className="health-num">
                  Size
                </th>
                <th scope="col" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {stats.heaviestHistory.map((row: HistoryFootprint) => (
                <tr key={row.docId}>
                  <td>
                    {row.path ? (
                      <span className="health-path" title={row.path}>
                        {middleTruncate(row.path, PATH_CHARS)}
                      </span>
                    ) : (
                      <span className="muted">orphan · {row.docId.slice(0, 8)}</span>
                    )}
                  </td>
                  <td className="health-num">{row.updates.toLocaleString()}</td>
                  <td className="health-num">{formatBytes(row.bytes)}</td>
                  <td className="health-row-actions">
                    {row.path && (
                      <button
                        type="button"
                        className="link-btn danger"
                        onClick={() => onResetHistory(row.docId, row.path)}
                      >
                        Reset history
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function LargestFiles({
  title,
  rows,
  now,
  empty,
  onReveal,
  onOpenNote,
}: {
  title: string;
  rows: SizedFile[];
  now: number;
  empty: string;
  onReveal: (path: string) => Promise<void>;
  onOpenNote?: (path: string) => void;
}) {
  return (
    <section className="health-table-block">
      <h4 className="health-table-title">{title}</h4>
      {rows.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <table className="health-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col" className="health-num">
                Size
              </th>
              <th scope="col" className="health-num">
                Modified
              </th>
              <th scope="col" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const badge = sizeBadge(row.bytes);
              return (
                <tr key={row.path}>
                  <td>
                    <span className="health-file-name">{fileName(row.path)}</span>
                    <span className="health-path" title={row.path}>
                      {middleTruncate(row.path, PATH_CHARS)}
                    </span>
                  </td>
                  <td className="health-num">
                    {formatBytes(row.bytes)}
                    {badge && (
                      <span className="health-size-badge" data-tone={badge}>
                        {badge === "bad" ? "over the limit" : "near the limit"}
                      </span>
                    )}
                  </td>
                  <td className="health-num">{relativeTime(row.mtime, now)}</td>
                  <td className="health-row-actions">
                    {onOpenNote && (
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => onOpenNote(row.path)}
                      >
                        Open
                      </button>
                    )}
                    <AsyncButton className="link-btn" onClick={() => onReveal(row.path)}>
                      Reveal
                    </AsyncButton>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
