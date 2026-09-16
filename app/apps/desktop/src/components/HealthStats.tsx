/* Vault Settings → Health — the census: what is actually in this vault.
   A compact metrics strip, a twelve-week activity strip and one "largest" table
   behind a segmented control. Everything here comes from the Rust census in
   `VaultStats`; nothing is derived from the sync layer, so this whole block is
   just as true for a vault that has never had a server. */
import { useState } from "react";
import type { HistoryFootprint, SizedFile, VaultCheckId, VaultStats } from "../lib/health/types";
import { activityLevel, formatBytes, relativeTime } from "../lib/health/format";
import { MAX_NOTE_BYTES } from "../lib/sync/contentUpload";
import { AsyncButton } from "./AsyncButton";
import { Glyph, PathText, type GlyphName, type HealthHandlers } from "./HealthShared";

/** Amber before the hard ceiling: a note this size is one paste from being
 *  refused, and the warning is only useful while it can still be acted on. */
const NOTE_WARN_BYTES = 8 * 1024 * 1024;

// ── Metrics strip ─────────────────────────────────────────────────────────────

interface Metric {
  icon: GlyphName;
  label: string;
  value: string;
  /** Tooltip detail; kept off the strip so it stays one quiet row. */
  sub?: string;
  /** Short inline note when something is off ("1 broken"), amber. */
  flag?: string;
  /** The check that lists the affected files; the flag becomes a link to it. */
  check?: VaultCheckId;
  action?: "reclaim";
}

/**
 * The census as one compact strip under the verdict card: ten numbers, each a
 * value over a tiny label, with the detail on hover. It used to be three groups
 * of tall cards further down the page, which pushed everything a person came
 * for (what failed, and why) below the fold behind numbers that rarely change.
 */
export function HealthStats({
  stats,
  loading,
  statsError,
  handlers,
  onFlag,
}: {
  stats: VaultStats | null;
  loading: boolean;
  statsError: string | null;
  handlers: HealthHandlers;
  /** A flag like "1 broken" is a dead end unless it leads somewhere: this opens
   *  the check that lists the files. */
  onFlag?: (check: VaultCheckId) => void;
}) {
  if (!stats) {
    return (
      <>
        {statsError && <div className="auth-error">{statsError}</div>}
        <ul className="health-metrics" aria-busy={loading || undefined}>
          {Array.from({ length: 10 }, (_, i) => (
            <li key={i} className="health-metric is-skeleton" aria-hidden="true">
              <span className="health-metric-value" />
              <span className="health-metric-label" />
            </li>
          ))}
        </ul>
        {!loading && !statsError && (
          <p className="muted">These numbers are not available for this vault yet.</p>
        )}
      </>
    );
  }

  const orphans = stats.history.orphanDocs;
  const totalBytes = stats.notes.bytes + stats.attachments.bytes + stats.otherFiles.bytes;

  const metrics: Metric[] = [
    { icon: "note", label: "Notes", value: stats.notes.count.toLocaleString(), sub: formatBytes(stats.notes.bytes) },
    { icon: "folder", label: "Folders", value: stats.folders.toLocaleString() },
    {
      icon: "paperclip",
      label: "Attachments",
      value: stats.attachments.count.toLocaleString(),
      sub: formatBytes(stats.attachments.bytes),
    },
    {
      icon: "file",
      label: "Other files",
      value: stats.otherFiles.count.toLocaleString(),
      sub: formatBytes(stats.otherFiles.bytes),
    },
    { icon: "tag", label: "Tags", value: stats.tags.toLocaleString() },
    {
      icon: "link",
      label: "Links",
      value: stats.links.toLocaleString(),
      flag: stats.brokenLinks > 0 ? `${stats.brokenLinks.toLocaleString()} broken` : undefined,
      check: "broken-links",
    },
    {
      icon: "empty",
      label: "Empty notes",
      value: stats.notes.empty.toLocaleString(),
      flag: stats.notes.empty > 0 ? "0 bytes" : undefined,
      check: "empty-notes",
    },
    {
      icon: "disk",
      label: "Total size",
      value: formatBytes(totalBytes),
      sub: "Notes, attachments and other files",
    },
    {
      icon: "database",
      label: "Index",
      value: formatBytes(stats.index.bytes),
      sub: `${stats.notes.count.toLocaleString()} notes indexed`,
    },
    {
      icon: "history",
      label: "History",
      value: formatBytes(stats.history.bytes),
      sub: `${stats.history.docs.toLocaleString()} notes · ${stats.history.updates.toLocaleString()} updates`,
      flag:
        orphans > 0
          ? `${formatBytes(stats.history.orphanBytes)} reclaimable`
          : undefined,
      check: "orphan-history",
      action: orphans > 0 ? "reclaim" : undefined,
    },
  ];

  return (
    <>
      {statsError && <div className="auth-error">{statsError}</div>}
      <ul className="health-metrics" aria-label="Vault at a glance">
        {metrics.map((m) => (
          <li
            className="health-metric"
            data-flag={m.flag ? "" : undefined}
            key={m.label}
            title={m.sub ? `${m.label}: ${m.sub}` : undefined}
          >
            <span className="health-metric-value">{m.value}</span>
            <span className="health-metric-label">
              <Glyph name={m.icon} size={12} />
              {m.label}
            </span>
            {m.flag &&
              (m.check && onFlag ? (
                <button
                  type="button"
                  className="health-metric-flag"
                  title="Show the affected files"
                  onClick={() => onFlag(m.check as VaultCheckId)}
                >
                  {m.flag}
                </button>
              ) : (
                <span className="health-metric-flag">{m.flag}</span>
              ))}
            {m.action === "reclaim" && (
              <AsyncButton className="link-btn health-metric-action" onClick={handlers.reclaim}>
                Reclaim
              </AsyncButton>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

// ── Activity ──────────────────────────────────────────────────────────────────

/**
 * Twelve rolling seven-day windows as a contribution strip.
 *
 * v1 drew these as bar heights, which failed the commonest case there is: a
 * vault whose notes were all touched this week rendered eleven invisible stubs
 * beside one full-height block. A filled cell with its count inside is legible
 * at every distribution, including a single week and a flat one.
 */
export function HealthActivity({ activity }: { activity: VaultStats["activity"] }) {
  const weeks = activity.weeks ?? [];
  const peak = Math.max(0, ...weeks);
  const caption =
    `${activity.modifiedLast7d.toLocaleString()} ${activity.modifiedLast7d === 1 ? "note" : "notes"} ` +
    `edited in the last 7 days · ${activity.modifiedLast30d.toLocaleString()} in 30 days`;

  return (
    <div className="health-activity">
      <p className="health-activity-lead">{caption}</p>
      <div
        className="health-weeks"
        role="img"
        aria-label={
          weeks.length === 0
            ? caption
            : `Notes edited per week, oldest first: ${weeks.join(", ")}. ${caption}`
        }
      >
        {weeks.map((n, i) => (
          <span
            key={i}
            className="health-week"
            data-level={activityLevel(n, peak)}
            data-current={i === weeks.length - 1 ? "" : undefined}
            title={
              i === weeks.length - 1
                ? `This week · ${n.toLocaleString()}`
                : `${weeks.length - 1 - i} ${weeks.length - 2 === i ? "week" : "weeks"} ago · ${n.toLocaleString()}`
            }
          >
            <span className="health-week-n">{n > 0 ? n.toLocaleString() : ""}</span>
          </span>
        ))}
      </div>
      <div className="health-weeks-axis" aria-hidden="true">
        <span>12 wk ago</span>
        <span>this week</span>
      </div>
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

type Pane = "notes" | "files" | "history";

export function HealthLargest({
  stats,
  handlers,
}: {
  stats: VaultStats;
  handlers: HealthHandlers;
}) {
  const [pane, setPane] = useState<Pane>("notes");
  const panes: Array<[Pane, string, number]> = [
    ["notes", "Notes", stats.largestNotes.length],
    ["files", "Files", stats.largestFiles.length],
    ["history", "History", stats.heaviestHistory.length],
  ];

  return (
    <div className="health-largest">
      <div className="segmented health-segmented" role="tablist" aria-label="Largest by kind">
        {panes.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={pane === id}
            className={pane === id ? "active" : ""}
            onClick={() => setPane(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {pane === "history" ? (
        <HistoryTable stats={stats} handlers={handlers} />
      ) : (
        <FileTable
          rows={pane === "notes" ? stats.largestNotes : stats.largestFiles}
          empty={pane === "notes" ? "No notes yet." : "No attachments or other files."}
          openable={pane === "notes"}
          handlers={handlers}
        />
      )}
    </div>
  );
}

function FileTable({
  rows,
  empty,
  openable,
  handlers,
}: {
  rows: SizedFile[];
  empty: string;
  openable: boolean;
  handlers: HealthHandlers;
}) {
  if (rows.length === 0) return <p className="muted">{empty}</p>;
  return (
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
                <PathText path={row.path} />
              </td>
              <td className="health-num" data-tone={badge ?? undefined}>
                {formatBytes(row.bytes)}
                {badge && (
                  <span className="health-size-badge">
                    {badge === "bad" ? "over the limit" : "near the limit"}
                  </span>
                )}
              </td>
              <td className="health-num">{relativeTime(row.mtime, handlers.now)}</td>
              <td className="health-row-actions">
                {openable && (
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => handlers.openNote(row.path)}
                  >
                    Open
                  </button>
                )}
                <AsyncButton
                  className="link-btn"
                  onClick={() => handlers.actions.reveal(row.path)}
                >
                  Reveal
                </AsyncButton>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function HistoryTable({
  stats,
  handlers,
}: {
  stats: VaultStats;
  handlers: HealthHandlers;
}) {
  if (stats.heaviestHistory.length === 0) {
    return <p className="muted">No local edit history yet.</p>;
  }
  return (
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
                <PathText path={row.path} />
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
                  onClick={() =>
                    handlers.confirm({ kind: "reset", docId: row.docId, path: row.path })
                  }
                >
                  Reset history
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
