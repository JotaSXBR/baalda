/* Vault Settings → Health. The page that answers, in this order: is my work
   safe, where exactly does the pipeline stop, WHY, what do I do about it, what
   did Baalda verify about these files, and what is in this vault.

   Split in two on purpose. `HealthTab` is the container: it owns the hook, the
   note list the inspector completes against, and the upgrade dialog.
   `HealthView` is pure — hand it a `VaultHealthSnapshot` and it renders, which
   is what lets a fixture drive it without a vault, a server or a Tauri host
   underneath.

   The sections live in `HealthIssues`, `HealthChecks`, `HealthInspector`,
   `HealthTimeline` and `HealthStats`; this file owns the layout, the verdict
   card, the pipeline strip, the sync bar and every destructive confirm. The
   confirms live HERE rather than inside the row that raised them, so a row
   unmounting mid-dialog — a refresh landing, a filter changing — cannot take
   the dialog with it.

   The whole page has to survive a vault that has never synced: `report.counts`
   is null, the last two pipeline stages are `off`, and the analytics below are
   still the point. Nothing here may assume a server. */
import { useEffect, useState } from "react";
import { useStore } from "../store";
import type { NoteTitle } from "../lib/ipc";
import type { HealthStage, HealthStageId, VaultHealthSnapshot } from "../lib/health/types";
import { useVaultHealth } from "../lib/health/useVaultHealth";
import { formatBytes, verdictLabel, verdictTone } from "../lib/health/format";
import { toast } from "../lib/toast";
import { AsyncButton } from "./AsyncButton";
import { ConfirmDialog } from "./ConfirmDialog";
import { UpgradeDialog } from "./UpgradeDialog";
import { HealthIssues } from "./HealthIssues";
import { HealthChecks } from "./HealthChecks";
import { HealthInspector } from "./HealthInspector";
import { HealthTimeline } from "./HealthTimeline";
import { HealthActivity, HealthLargest, HealthStats } from "./HealthStats";
import { Section, type ConfirmState, type HealthHandlers } from "./HealthShared";
import "./health.css";

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
  // The one store read on this page, and it stays in the CONTAINER so
  // `HealthView` keeps rendering from nothing but its props — a fixture, in the
  // tests.
  const notes = useStore((s) => s.titles);

  return (
    <>
      <HealthView
        snapshot={snapshot}
        notes={notes}
        onGoToGeneral={onGoToGeneral}
        onClose={onClose}
      />
      {upgradeOpen && <UpgradeDialog onClose={() => setUpgradeOpen(false)} />}
    </>
  );
}

// ── The page ──────────────────────────────────────────────────────────────────

export function HealthView({
  snapshot,
  notes = [],
  onGoToGeneral,
  onClose,
}: {
  snapshot: VaultHealthSnapshot;
  notes?: NoteTitle[];
  onGoToGeneral?: () => void;
  onClose?: () => void;
}) {
  const { report, stats, checks, statsError, loading, log, refresh, actions } = snapshot;
  // Relative times go stale while the dialog sits open; a slow tick is enough
  // and costs one render a minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const [confirming, setConfirming] = useState<ConfirmState | null>(null);
  const [focusIssue, setFocusIssue] = useState<string | null>(null);
  const [inspectRequest, setInspectRequest] = useState<{ path: string; n: number } | null>(
    null,
  );

  const handlers: HealthHandlers = {
    actions,
    now,
    confirm: setConfirming,
    openNote(path) {
      actions.openNote(path);
      // The note is behind the settings card; leaving it open would look like
      // nothing happened.
      onClose?.();
    },
    async reclaim() {
      const { docsRemoved, bytesReclaimed } = await actions.reclaimOrphans();
      toast(
        docsRemoved === 0
          ? "Nothing to reclaim"
          : `Reclaimed ${formatBytes(bytesReclaimed)} from ${docsRemoved.toLocaleString()} ` +
              `orphan ${docsRemoved === 1 ? "doc" : "docs"}`,
      );
    },
  };

  return (
    <div className="health-tab">
      <VerdictCard snapshot={snapshot} onRefresh={refresh} loading={loading} />

      {/* The vault's numbers sit right under the verdict as one quiet strip:
          they frame everything below ("15 notes, 259 KB") without competing
          with it. */}
      <HealthStats stats={stats} loading={loading} statsError={statsError} handlers={handlers} />

      <Pipeline stages={report.stages} />

      <Section title="Sync">
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
      </Section>

      <Section
        title="Needs attention"
        description="Open a row for the full reasoning."
      >
        <HealthIssues
          issues={report.issues}
          handlers={handlers}
          syncEnabled={report.counts != null}
          focusKey={focusIssue}
        />
      </Section>

      <Section title="Check a note">
        <HealthInspector
          notes={notes}
          handlers={handlers}
          request={inspectRequest}
          onShowIssue={setFocusIssue}
        />
      </Section>

      <Section
        title="Checks"
        description="What Baalda verifies about the files in this vault."
      >
        <HealthChecks
          checks={checks}
          loading={loading}
          handlers={handlers}
          onRefresh={refresh}
        />
      </Section>

      {stats && (
        <>
          <Section title="Activity">
            <HealthActivity activity={stats.activity} />
          </Section>

          <Section title="Largest">
            <HealthLargest stats={stats} handlers={handlers} />
          </Section>
        </>
      )}

      <Section
        title="Timeline"
        description="What the sync layer has done since this app launched."
      >
        <HealthTimeline
          log={log}
          now={now}
          onInspect={(path) => setInspectRequest((r) => ({ path, n: (r?.n ?? 0) + 1 }))}
        />
      </Section>

      <Confirms
        confirming={confirming}
        onDone={() => setConfirming(null)}
        actions={actions}
      />
    </div>
  );
}

// ── Confirms ──────────────────────────────────────────────────────────────────

/** Every irreversible action on the page, in one place. Each one names what it
 *  will do to the file in front of the reader rather than to "the document". */
function Confirms({
  confirming,
  onDone,
  actions,
}: {
  confirming: ConfirmState | null;
  onDone: () => void;
  actions: VaultHealthSnapshot["actions"];
}) {
  if (!confirming) return null;

  switch (confirming.kind) {
    case "delete":
      return (
        <ConfirmDialog
          title="Delete this note?"
          confirmLabel="Delete"
          onCancel={onDone}
          onConfirm={async () => {
            await actions.deleteNote(confirming.path);
            onDone();
          }}
        >
          <p className="muted">
            <code>{confirming.path}</code> is removed from this vault, and from every
            device that syncs it. A vault checkpoint can bring it back.
          </p>
        </ConfirmDialog>
      );
    case "reset":
      return (
        <ConfirmDialog
          title="Reset this note's history?"
          confirmLabel="Reset history"
          onCancel={onDone}
          onConfirm={async () => {
            const { bytesFreed } = await actions.resetHistory(confirming.docId);
            onDone();
            toast(`History reset · ${formatBytes(bytesFreed)} freed`);
          }}
        >
          <p className="muted">
            {confirming.path ? <code>{confirming.path}</code> : "This document"} starts over
            from the file on disk. The text you have now is kept, but the edit history
            behind it is discarded on every device, and undo cannot reach past this point.
          </p>
        </ConfirmDialog>
      );
    case "reregister":
      return (
        <ConfirmDialog
          title="Put this file back on the server?"
          confirmLabel="Re-register"
          tone="accent"
          onCancel={onDone}
          onConfirm={async () => {
            await actions.reregister(confirming.path);
            onDone();
            toast("Registered — its content is uploading now");
          }}
        >
          <p className="muted">
            Registers <code>{confirming.path}</code> with the server as a note again and
            uploads its content. Everyone with access to this vault will see it.
          </p>
        </ConfirmDialog>
      );
    case "empty-trash":
      return (
        <ConfirmDialog
          title="Empty the recovery copies?"
          confirmLabel="Empty trash"
          onCancel={onDone}
          onConfirm={async () => {
            const { filesRemoved, bytesFreed } = await actions.emptyTrash();
            onDone();
            toast(
              filesRemoved === 0
                ? "Nothing to empty"
                : `Removed ${filesRemoved.toLocaleString()} ${
                    filesRemoved === 1 ? "copy" : "copies"
                  } · ${formatBytes(bytesFreed)} freed`,
            );
          }}
        >
          <p className="muted">
            Baalda keeps a copy of every note it deletes. Emptying them frees the space and
            removes your safety net for those deletes. Notes still in the vault are
            untouched.
          </p>
        </ConfirmDialog>
      );
    case "rebuild-index":
      return (
        <ConfirmDialog
          title="Rebuild the search index?"
          confirmLabel="Rebuild"
          tone="accent"
          onCancel={onDone}
          onConfirm={async () => {
            await actions.rebuildIndex();
            onDone();
            toast("Index rebuilt");
          }}
        >
          <p className="muted">
            Reads every note again and builds search, tags and backlinks from scratch.
            Search may be briefly incomplete while it runs. Your notes are not touched.
          </p>
        </ConfirmDialog>
      );
  }
}

// ── Verdict ───────────────────────────────────────────────────────────────────

/**
 * Pull the trailing " · <host>" the model folds into `detail` back out, so the
 * card can set it as a quiet mono chip instead of ending a plain sentence in
 * "…baalda-production.up.railway.app.". The model keeps owning the wording;
 * this only decides where the host is painted.
 */
export function splitHost(
  detail: string,
  host: string | null,
): { text: string; host: string | null } {
  if (!host) return { text: detail, host: null };
  const needle = ` · ${host}`;
  const at = detail.lastIndexOf(needle);
  if (at < 0) return { text: detail, host: null };
  const text = (detail.slice(0, at) + detail.slice(at + needle.length))
    // The host sometimes sits between a sentence's own full stop and the one
    // the template adds, which leaves ".." behind once it is lifted out.
    .replace(/\s*\.\s*\.\s*$/, ".")
    .trim();
  return { text, host };
}

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
  const { text, host } = splitHost(report.detail, report.serverHost);

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
        {/* The model already folds "Last confirmed …" into `detail` (see
            `model.ts` → `describe`), so the card prints it verbatim rather than
            assembling a second, contradictory version. Only the server host is
            lifted out, and only to be set as a chip. */}
        <p className="health-detail">
          {text}
          {host && <span className="health-host">{host}</span>}
        </p>
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
              local ? "This folder does not sync" : syncing ? "Already syncing" : undefined
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

// ── Pipeline strip ────────────────────────────────────────────────────────────

/** A stage that is `off` is not a fault — a local vault's connection and server
 *  nodes are simply not in play — so the diagnosis walks past it looking for the
 *  first stage that is actually degraded or moving. */
function isSettled(stage: HealthStage): boolean {
  return stage.state === "ok" || stage.state === "off";
}

/** The two stages that are normally NOISE. Nobody opens this page to be told
 *  the local index holds nineteen rows; they open it because something is not
 *  on the server. So these appear only when they are the thing that is wrong,
 *  in their natural position, marked as surfaced deliberately. */
const CONDITIONAL: ReadonlySet<HealthStageId> = new Set<HealthStageId>([
  "index",
  "history",
]);

/** The page's own words. The model calls the last stage "Server"; on this page
 *  it is the reader's own vault up there, not a machine. */
const STAGE_LABELS: Partial<Record<HealthStageId, string>> = {
  server: "Remote vault",
};

export function Pipeline({ stages }: { stages: HealthStage[] }) {
  const shown = stages.filter((s) => !CONDITIONAL.has(s.id) || !isSettled(s));
  // The first unsettled stage is where the pipeline stops; -1 when everything
  // that can be confirmed is confirmed.
  const focus = shown.findIndex((s) => !isSettled(s));
  const [picked, setPicked] = useState<number | null>(null);
  // A pick survives until the diagnosis itself moves, so re-reading a stage
  // does not fight the auto-focus on the next poll.
  useEffect(() => setPicked(null), [focus]);

  if (shown.length === 0) return null;
  const at = picked ?? (focus >= 0 ? focus : shown.length - 1);
  const legend = shown[at];
  // The line under the strip restates the highlighted card's own number on a
  // healthy vault ("19" in the card, "19 notes and 3 folders…" below it), so it
  // only appears when it has something the card does not: a stage that is
  // actually degraded, or one the reader asked about by clicking it.
  const showLegend = legend != null && (picked != null || !isSettled(legend));

  return (
    <div className="health-pipeline-wrap">
      <ol className="health-pipeline" aria-label="Sync pipeline">
        {shown.map((stage, i) => {
          const conditional = CONDITIONAL.has(stage.id);
          return (
            <li key={stage.id} className="health-stage-cell">
              {i > 0 && (
                <span
                  className="health-edge"
                  data-state={stage.state}
                  data-broken={i === focus ? "" : undefined}
                  aria-hidden="true"
                />
              )}
              <button
                type="button"
                className="health-node"
                data-state={stage.state}
                data-focus={i === focus ? "" : undefined}
                data-picked={i === at ? "" : undefined}
                data-conditional={conditional ? "" : undefined}
                title={stage.detail}
                aria-current={i === at ? "step" : undefined}
                onClick={() => setPicked(i)}
              >
                <span className="health-node-top">
                  <span className="health-node-dot" aria-hidden="true" />
                  <span className="health-node-label">
                    {STAGE_LABELS[stage.id] ?? stage.label}
                  </span>
                </span>
                <span className="health-node-headline">{stage.headline}</span>
                {conditional && (
                  <span className="health-node-note">shown because it needs attention</span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
      {showLegend && (
        <p className="health-legend" data-state={legend.state}>
          <strong>{STAGE_LABELS[legend.id] ?? legend.label}</strong> {legend.detail}
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
    { key: "pending", label: "Pending", value: counts.pending, tone: "busy" },
    { key: "failed", label: "Failed", value: counts.failed, tone: "bad" },
    { key: "unsynced", label: "Not on server", value: counts.unsynced, tone: "warn" },
    // The fifth segment is what keeps the bar honest: a mapped note nobody has
    // reported on yet is neither synced nor failed, and folding it into either
    // would make the bar claim something the sync layer has not said.
    { key: "unreported", label: "Unreported", value: counts.unreported, tone: "muted" },
  ].filter((s) => s.value > 0);

  // Widths come off the segments' own sum, not `total`, so the bar always fills
  // its track even if the tallies disagree by a note.
  const sum = segments.reduce((n, s) => n + s.value, 0);
  // The percentage lives in the bar's accessible name only. On screen the
  // legend chips already carry every number, and the verdict card above carries
  // the sentence — a lead line here said "19" for the third time.
  const pct = counts.total > 0 ? Math.floor((counts.synced / counts.total) * 100) : 100;

  return (
    <div className="health-breakdown">
      <div
        className="health-bar"
        role="img"
        aria-label={`${pct}% synced — ${counts.synced.toLocaleString()} of ${counts.total.toLocaleString()} notes`}
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
