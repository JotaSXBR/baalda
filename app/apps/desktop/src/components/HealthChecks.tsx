/* Vault Settings → Health — the integrity checks.
   Fifteen questions Rust asks about the files on disk and the rows in the local
   index. The wording of every one of them lives in `lib/health/checks.ts`; this
   file only decides what a passing row looks like versus a failing one.

   The two rows are deliberately unequal. A PASSING row is a tick and a label,
   nothing else — its `looksFor` moves to the label's tooltip, because fifteen
   explanatory sentences stacked up is what made this section unreadable. A
   FAILING row is loud: a filled badge in the severity colour, the count as a
   filled pill beside the label, and ONE line of cause. Everything else waits
   behind the chevron.

   A passing row still exists, though, and that is the point of listing all
   fifteen: "no case collisions" is information, and a page that hides its
   passes cannot be trusted to have run them. */
import { useState } from "react";
import {
  CHECK_GROUP_LABELS,
  checkRows,
  summarizeChecks,
  type CheckAction,
  type CheckRow,
} from "../lib/health/checks";
import type { VaultCheckItem, VaultChecks } from "../lib/health/types";
import { formatBytes } from "../lib/health/format";
import { AsyncButton } from "./AsyncButton";
import { Eyebrow, Glyph, PathText, type HealthHandlers } from "./HealthShared";

/**
 * The lead sentence of a check's `whyItMatters`, for the collapsed row. The
 * rest is not lost — the expanded panel prints the whole thing — but a list of
 * fifteen rows cannot carry fifteen paragraphs and still be scannable.
 */
export function firstSentence(text: string): string {
  const t = text.trim();
  const m = /^(.*?[.!?])(?:\s|$)/.exec(t);
  return m ? m[1] : t;
}

export function HealthChecks({
  checks,
  loading,
  handlers,
  onRefresh,
}: {
  checks: VaultChecks | null;
  loading: boolean;
  handlers: HealthHandlers;
  onRefresh: () => void;
}) {
  if (checks == null) {
    if (loading) {
      return (
        <ul className="health-checks" aria-busy="true">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i} className="health-check is-skeleton" aria-hidden="true">
              <span className="health-check-glyph" />
              <span className="health-check-label" />
            </li>
          ))}
        </ul>
      );
    }
    return <p className="muted">Checks are not available for this vault.</p>;
  }

  const rows = checkRows(checks);
  const summary = summarizeChecks(rows);
  // Rust sends all fifteen ids in union order, count 0 when a check passes, so
  // this set is normally complete. It is tracked anyway: an OLDER core sends
  // fewer, and `checkRows` fills the gap with a zero result. A zero Rust never
  // measured is not a pass, so those rows read "Not run" in grey instead of
  // green — the one thing this section must never do is claim a check it did
  // not run.
  const reported = new Set(checks.results.map((r) => r.id));
  const notRun = rows.filter((r) => !reported.has(r.def.id)).length;
  const groups = (["files", "names", "links", "storage"] as const).map((group) => ({
    group,
    rows: rows.filter((r) => r.def.group === group),
  }));

  return (
    <>
      <div className="health-checks-head" data-tone={summaryTone(summary)}>
        <span className="health-checks-headline">
          {summary.headline}
          {notRun > 0 && ` · ${notRun} not run`}
        </span>
        <button type="button" className="ghost-pill sm" onClick={onRefresh}>
          Run again
        </button>
      </div>
      {groups.map(({ group, rows: inGroup }) =>
        inGroup.length === 0 ? null : (
          <div className="health-check-group" key={group}>
            <Eyebrow>{CHECK_GROUP_LABELS[group]}</Eyebrow>
            <ul className="health-checks">
              {inGroup.map((row) => (
                <CheckItem
                  key={row.def.id}
                  row={row}
                  state={
                    !reported.has(row.def.id) ? "unknown" : row.passed ? "passed" : "failed"
                  }
                  handlers={handlers}
                />
              ))}
            </ul>
          </div>
        ),
      )}
    </>
  );
}

function summaryTone(s: { errors: number; warnings: number }): "bad" | "warn" | "good" {
  if (s.errors > 0) return "bad";
  if (s.warnings > 0) return "warn";
  return "good";
}

/** What a row is actually saying. `unknown` exists so a check that never ran
 *  cannot be read as one that passed. */
type CheckState = "passed" | "failed" | "unknown";

/** A failing check takes its definition's severity; a passing one is always
 *  green, whatever it would have been; one that did not run has no colour at
 *  all, because it has no finding. */
function tone(def: CheckRow["def"], state: CheckState): "good" | "warn" | "bad" | "muted" {
  if (state === "unknown") return "muted";
  if (state === "passed") return "good";
  // Anything that fails is amber unless it is an error; a grey dot on a failing
  // row read as "nothing to see here", which is the opposite of a finding.
  return def.severity === "error" ? "bad" : "warn";
}

function CheckItem({
  row,
  state,
  handlers,
}: {
  row: CheckRow;
  state: CheckState;
  handlers: HealthHandlers;
}) {
  const [open, setOpen] = useState(false);
  const { def, result } = row;
  const panelId = `health-check-${def.id}`;
  const failed = state === "failed";
  // `trash` counts FILES while each item is one timestamped recovery folder, so
  // "and 387 more" under 25 rows would be wrong in both directions. Every other
  // check counts the things it lists.
  const isTrash = def.id === "trash";
  const more = isTrash ? 0 : Math.max(0, result.count - result.items.length);

  return (
    <li
      className="health-check"
      data-tone={tone(def, state)}
      data-state={state}
      data-passed={state === "passed" ? "" : undefined}
      data-open={failed && open ? "" : undefined}
    >
      <div className="health-check-head">
        <button
          type="button"
          className="health-check-summary"
          aria-expanded={open}
          aria-controls={panelId}
          disabled={!failed}
          onClick={() => setOpen((v) => !v)}
        >
          <CheckBadge def={def} state={state} />
          {/* The label carries what the check looks for as its tooltip, so a
              passing row is two words instead of a sentence. */}
          <span className="health-check-label" title={def.looksFor}>
            {def.label}
          </span>
          {failed && (
            <>
              <span className="health-check-count">
                {result.count.toLocaleString()}
                {def.showsBytes && result.bytes != null && result.bytes > 0 && (
                  <span className="health-check-bytes">{formatBytes(result.bytes)}</span>
                )}
              </span>
              {/* The panel opens with the full paragraph, so the one-line
                  brief steps aside instead of repeating its first sentence. */}
              {!open && (
                <span className="health-check-why-line">
                  {firstSentence(def.whyItMatters)}
                </span>
              )}
              <span className="health-chevron" data-open={open ? "" : undefined} aria-hidden="true">
                <Glyph name="chevron" />
              </span>
            </>
          )}
          {state === "unknown" && <span className="health-check-note">Not run</span>}
        </button>
        {failed && def.bulkAction && <BulkAction action={def.bulkAction} handlers={handlers} />}
      </div>

      {failed && open && (
        <div className="health-check-panel" id={panelId}>
          <p className="health-check-why">{def.whyItMatters}</p>
          <Eyebrow>What to do</Eyebrow>
          <ol className="health-fixes">
            {def.howToFix.map((fix, i) => (
              <li key={i}>{fix}</li>
            ))}
          </ol>
          {isTrash && (
            <p className="muted">
              {result.count.toLocaleString()} {result.count === 1 ? "file" : "files"} in{" "}
              {result.items.length.toLocaleString()}
              {result.items.length >= 25 ? " or more" : ""}{" "}
              {result.items.length === 1 ? "recovery set" : "recovery sets"}.
            </p>
          )}
          {result.items.length > 0 && (
            <ul className="health-check-items">
              {result.items.map((item, i) => (
                <li key={`${item.path}-${i}`}>
                  <PathText path={item.path} />
                  {item.detail && <span className="health-check-detail">{item.detail}</span>}
                  {item.bytes != null && item.bytes > 0 && (
                    <span className="health-check-detail">{formatBytes(item.bytes)}</span>
                  )}
                  <span className="health-check-item-actions">
                    {def.itemActions.map((a) => (
                      <ItemAction key={a} action={a} item={item} handlers={handlers} />
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {more > 0 && <p className="muted">and {more.toLocaleString()} more</p>}
        </div>
      )}
    </li>
  );
}

/**
 * The mark at the head of the row, and the loudest thing in this section.
 *
 * A failing check has to READ as a warning from across the page: a filled badge
 * in the severity colour. Housekeeping gets a filled dot rather than a triangle
 * — it is a fact, not a fault — and a passing check gets a bare green tick that
 * takes up almost no attention at all.
 */
function CheckBadge({ def, state }: { def: CheckRow["def"]; state: CheckState }) {
  if (state === "passed") {
    return (
      <span className="health-check-tick" aria-label="Passed">
        <Glyph name="check" size={14} />
      </span>
    );
  }
  if (state === "unknown") {
    return <span className="health-check-dot" data-hollow="" aria-label="Not run" />;
  }
  return (
    <span
      className="health-check-badge"
      aria-label={def.severity === "error" ? "Error" : "Warning"}
    >
      <Glyph name="alert" size={13} />
    </span>
  );
}

function BulkAction({
  action,
  handlers,
}: {
  action: CheckAction;
  handlers: HealthHandlers;
}) {
  switch (action) {
    case "rebuild-index":
      return (
        <button
          type="button"
          className="ghost-pill sm"
          onClick={() => handlers.confirm({ kind: "rebuild-index" })}
        >
          Rebuild index
        </button>
      );
    case "empty-trash":
      return (
        <button
          type="button"
          className="ghost-pill sm"
          onClick={() => handlers.confirm({ kind: "empty-trash" })}
        >
          Empty trash
        </button>
      );
    case "reclaim":
      return (
        <AsyncButton className="ghost-pill sm" onClick={handlers.reclaim}>
          Reclaim
        </AsyncButton>
      );
    case "sync-now":
      return (
        <AsyncButton className="ghost-pill sm" onClick={() => handlers.actions.syncNow()}>
          Sync now
        </AsyncButton>
      );
    default:
      return null;
  }
}

function ItemAction({
  action,
  item,
  handlers,
}: {
  action: CheckAction;
  item: VaultCheckItem;
  handlers: HealthHandlers;
}) {
  const { actions, confirm, openNote } = handlers;
  switch (action) {
    case "open":
      return (
        <button type="button" className="ghost-pill sm" onClick={() => openNote(item.path)}>
          Open
        </button>
      );
    case "reveal":
      return (
        <AsyncButton className="ghost-pill sm" onClick={() => actions.reveal(item.path)}>
          Reveal
        </AsyncButton>
      );
    case "delete":
      return (
        <button
          type="button"
          className="ghost-pill sm danger"
          onClick={() => confirm({ kind: "delete", path: item.path })}
        >
          Delete
        </button>
      );
    case "export-copy":
      return (
        <AsyncButton className="link-btn" onClick={() => actions.exportCopy(item.path)}>
          Save a copy
        </AsyncButton>
      );
    case "reset-history":
      // Only a doc id can be reset; a check item without one (an unindexed file)
      // has no history to discard, so the action is simply absent.
      return item.docId ? (
        <button
          type="button"
          className="ghost-pill sm danger"
          onClick={() =>
            confirm({ kind: "reset", docId: item.docId as string, path: item.path })
          }
        >
          Reset history
        </button>
      ) : null;
    default:
      return null;
  }
}
