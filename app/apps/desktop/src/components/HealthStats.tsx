/* Vault Settings → Health — the census: what is actually in this vault.
   Three groups of cards, a twelve-week activity strip and one "largest" table
   behind a segmented control. Everything here comes from the Rust census in
   `VaultStats`; nothing is derived from the sync layer, so this whole block is
   just as true for a vault that has never had a server. */
import { useState } from "react";
import type { HistoryFootprint, SizedFile, VaultStats } from "../lib/health/types";
import { activityLevel, formatBytes, relativeTime } from "../lib/health/format";
import { MAX_NOTE_BYTES } from "../lib/sync/contentUpload";
import { AsyncButton } from "./AsyncButton";
import { Eyebrow, Glyph, PathText, type GlyphName, type HealthHandlers } from "./HealthShared";

/** Amber before the hard ceiling: a note this size is one paste from being
 *  refused, and the warning is only useful while it can still be acted on. */
const NOTE_WARN_BYTES = 8 * 1024 * 1024;

// ── Vault at a glance ─────────────────────────────────────────────────────────

interface Tile {
  icon: GlyphName;
  label: string;
  value: string;
  sub?: string;
  tone?: "good" | "warn" | "bad" | "busy" | "muted";
  action?: "reclaim";
}

export function HealthStats({
  stats,
  loading,
  statsError,
  handlers,
}: {
  stats: VaultStats | null;
  loading: boolean;
  statsError: string | null;
  handlers: HealthHandlers;
}) {
  if (!stats) {
    return (
      <>
        {statsError && <div className="auth-error">{statsError}</div>}
        <ul className="health-tiles" aria-busy={loading || undefined}>
          {Array.from({ length: 8 }, (_, i) => (
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

  const orphans = stats.history.orphanDocs;
  const totalBytes = stats.notes.bytes + stats.attachments.bytes + stats.otherFiles.bytes;

  const groups: Array<{ title: string; tiles: Tile[] }> = [
    {
      title: "Content",
      tiles: [
        {
          icon: "note",
          label: "Notes",
          value: stats.notes.count.toLocaleString(),
          sub: formatBytes(stats.notes.bytes),
          tone: "busy",
        },
        {
          icon: "folder",
          label: "Folders",
          value: stats.folders.toLocaleString(),
          sub: stats.folders === 0 ? "everything at the top level" : "in this vault",
          tone: "busy",
        },
        {
          icon: "paperclip",
          label: "Attachments",
          value: stats.attachments.count.toLocaleString(),
          sub: formatBytes(stats.attachments.bytes),
          tone: "busy",
        },
        {
          icon: "file",
          label: "Other files",
          value: stats.otherFiles.count.toLocaleString(),
          sub: formatBytes(stats.otherFiles.bytes),
          tone: "muted",
        },
      ],
    },
    {
      title: "Structure",
      tiles: [
        {
          icon: "tag",
          label: "Tags",
          value: stats.tags.toLocaleString(),
          sub: "distinct across the vault",
          tone: "good",
        },
        {
          icon: "link",
          label: "Links",
          value: stats.links.toLocaleString(),
          sub:
            stats.brokenLinks > 0
              ? `${stats.brokenLinks.toLocaleString()} broken`
              : "none broken",
          tone: stats.brokenLinks > 0 ? "warn" : "good",
        },
        {
          icon: "empty",
          label: "Empty notes",
          value: stats.notes.empty.toLocaleString(),
          sub: stats.notes.empty > 0 ? "0 bytes on disk" : "every note has text",
          tone: stats.notes.empty > 0 ? "warn" : "good",
        },
      ],
    },
    {
      title: "Storage",
      tiles: [
        {
          icon: "disk",
          label: "Total size",
          value: formatBytes(totalBytes),
          sub: "notes, attachments and other files",
          tone: "muted",
        },
        {
          icon: "database",
          label: "Search index",
          value: formatBytes(stats.index.bytes),
          sub: `${stats.notes.count.toLocaleString()} notes indexed`,
          tone: "muted",
        },
        {
          icon: "history",
          label: "Edit history",
          value: formatBytes(stats.history.bytes),
          sub:
            orphans > 0
              ? `${orphans.toLocaleString()} orphan · ${formatBytes(stats.history.orphanBytes)} reclaimable`
              : `${stats.history.docs.toLocaleString()} notes · ${stats.history.updates.toLocaleString()} updates`,
          tone: orphans > 0 ? "warn" : "muted",
          action: orphans > 0 ? "reclaim" : undefined,
        },
      ],
    },
  ];

  return (
    <>
      {statsError && <div className="auth-error">{statsError}</div>}
      {groups.map((g) => (
        <div className="health-tile-group" key={g.title}>
          <Eyebrow>{g.title}</Eyebrow>
          <ul className="health-tiles">
            {g.tiles.map((t) => (
              <li className="health-tile" data-tone={t.tone ?? "muted"} key={t.label}>
                <span className="health-tile-icon" aria-hidden="true">
                  <Glyph name={t.icon} />
                </span>
                <span className="health-tile-value">{t.value}</span>
                <span className="health-tile-label">{t.label}</span>
                {t.sub && <span className="health-tile-sub">{t.sub}</span>}
                {t.action === "reclaim" && (
                  <AsyncButton
                    className="ghost-pill sm health-tile-action"
                    onClick={handlers.reclaim}
                  >
                    Reclaim
                  </AsyncButton>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
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
