// The integrity checks the Health page shows, in the order they appear.
//
// Rust (`src-tauri/src/checks.rs`, `ipc.vaultChecks`) only reports counts and
// the affected files per `VaultCheckId`; everything a person reads about a check
// lives here, so the wording can be reviewed in one place and a new check is one
// Rust arm plus one row below.
//
// Pure data + two pure helpers, so it is unit-tested without React.

import type { VaultCheckId, VaultCheckResult, VaultChecks } from "./types";

/** How loudly a FAILING check should read. `info` is housekeeping, not a fault. */
export type CheckSeverity = "info" | "warn" | "error";

/** Which of the page's actions make sense on this check's items / as a whole. */
export type CheckAction =
  | "open"
  | "reveal"
  | "delete"
  | "export-copy"
  | "reset-history"
  | "reclaim"
  | "empty-trash"
  | "rebuild-index"
  | "sync-now";

export interface CheckDefinition {
  id: VaultCheckId;
  /** Section the check is grouped under. */
  group: "files" | "names" | "links" | "storage";
  label: string;
  /** What the check looks for — shown when it passes too, so a green row still
   *  tells you what was verified. */
  looksFor: string;
  /** Why it matters when it fails, in the user's terms. One or two sentences. */
  whyItMatters: string;
  /** What to do about it. Prose, best first. */
  howToFix: string[];
  severity: CheckSeverity;
  /** Per-item actions, in order. */
  itemActions: CheckAction[];
  /** One action for the whole check (a button in the row header). */
  bulkAction?: CheckAction;
  /** The check reports a byte total worth showing next to the count. */
  showsBytes?: boolean;
}

export const CHECK_DEFINITIONS: CheckDefinition[] = [
  // ── Files ────────────────────────────────────────────────────────────────
  {
    id: "empty-notes",
    group: "files",
    label: "Empty notes",
    looksFor: "Notes whose file is 0 bytes.",
    whyItMatters:
      "An empty note syncs fine, but a note that used to have text and is now empty " +
      "usually means a save that never landed or a file another app truncated.",
    howToFix: [
      "Open the note — if it should have content, restore it from Versioning.",
      "Delete notes you never filled in.",
    ],
    severity: "info",
    itemActions: ["open", "reveal", "delete"],
  },
  {
    id: "unreadable-notes",
    group: "files",
    label: "Unreadable notes",
    looksFor: "Note files that are not valid text (not UTF-8, or binary).",
    whyItMatters:
      "Baalda cannot open, index or sync a note it cannot read as text. These files are " +
      "skipped silently everywhere else, so this is the only place you will see them.",
    howToFix: [
      "Open the file in a text editor and save it as UTF-8.",
      "If it is not really a note (an image or export with a .md name), move it out of the vault or rename it.",
    ],
    severity: "error",
    itemActions: ["reveal", "export-copy", "delete"],
  },
  {
    id: "bad-frontmatter",
    group: "files",
    label: "Broken properties block",
    looksFor:
      "A note that starts with --- but the properties block never closes, or holds lines that are not key: value.",
    whyItMatters:
      "Properties Baalda cannot read are shown as plain text and never touched, so nothing is " +
      "lost — but tags and dates in that block will not be found by search or filters.",
    howToFix: [
      "Open the note and close the block with a line containing only ---.",
      "Keep one property per line as key: value.",
    ],
    severity: "warn",
    itemActions: ["open", "reveal"],
  },
  {
    id: "oversized-notes",
    group: "files",
    label: "Notes over the size limit",
    looksFor: "Notes at or above 10 MB, the most the server accepts for one note.",
    whyItMatters:
      "A note this size cannot be uploaded, so its only copy is on this device. Large notes " +
      "are almost always pasted images or data tables.",
    howToFix: [
      "Move big images and files into attachments and link to them.",
      "Split the note, or save a copy outside the vault and shorten it.",
    ],
    severity: "error",
    itemActions: ["open", "reveal", "export-copy"],
    showsBytes: true,
  },
  {
    id: "stale-index",
    group: "files",
    label: "Search index out of date",
    looksFor: "Notes that changed on disk after they were last indexed, or whose file is gone.",
    whyItMatters:
      "Search, tags, backlinks and the graph read the index, so a stale row means results " +
      "that miss recent edits or point at a file that no longer exists.",
    howToFix: ["Rebuild the index — it reads every note again and takes a few seconds."],
    severity: "warn",
    itemActions: ["open", "reveal"],
    bulkAction: "rebuild-index",
  },
  {
    id: "unindexed-markdown",
    group: "files",
    label: "Markdown not picked up",
    looksFor: "Markdown files on disk that have no entry in the index.",
    whyItMatters:
      "A file the index never saw is invisible to search and is not synced — usually one " +
      "that was copied in while Baalda was not running.",
    howToFix: ["Rebuild the index, then Sync now to register them."],
    severity: "warn",
    itemActions: ["reveal"],
    bulkAction: "rebuild-index",
  },

  // ── Names & paths ────────────────────────────────────────────────────────
  {
    id: "case-collisions",
    group: "names",
    label: "Names that differ only by case",
    looksFor: "Two paths that are the same once you ignore upper and lower case.",
    whyItMatters:
      "On a Mac or Windows these are ONE file; on the server and on Linux they are two. " +
      "That mismatch is the single most common cause of a note that keeps re-syncing forever.",
    howToFix: ["Rename one of the pair so the names differ by more than case."],
    severity: "error",
    itemActions: ["reveal"],
  },
  {
    id: "illegal-names",
    group: "names",
    label: "Names Windows cannot use",
    looksFor:
      'Names containing < > : " | ? *, ending in a dot or a space, or reserved words such as CON or NUL.',
    whyItMatters:
      "A teammate on Windows cannot create these files, so their vault silently misses them.",
    howToFix: ["Rename the file or folder without the offending character."],
    severity: "warn",
    itemActions: ["reveal"],
  },
  {
    id: "long-paths",
    group: "names",
    label: "Very long paths",
    looksFor: "Paths longer than 200 characters from the vault root.",
    whyItMatters: "Windows and some backup tools refuse paths past 260 characters in total.",
    howToFix: ["Shorten the folder or file name."],
    severity: "info",
    itemActions: ["reveal"],
  },
  {
    id: "duplicate-titles",
    group: "names",
    label: "Notes with the same title",
    looksFor: "Two or more notes sharing one title.",
    whyItMatters:
      "A [[wikilink]] to that title is ambiguous, so it may open a different note than you meant.",
    howToFix: ["Give one of them a more specific title, or link by path."],
    severity: "info",
    itemActions: ["open", "reveal"],
  },

  // ── Links ────────────────────────────────────────────────────────────────
  {
    id: "broken-links",
    group: "links",
    label: "Links to missing notes",
    looksFor: "[[wikilinks]] that point at no note in the vault.",
    whyItMatters: "Clicking one creates a new empty note instead of opening what you meant.",
    howToFix: ["Open the note and fix the link, or create the missing note."],
    severity: "info",
    itemActions: ["open"],
  },
  {
    id: "missing-embeds",
    group: "links",
    label: "Missing images and attachments",
    looksFor: "![[embeds]] and ![](images) whose file is not in the vault.",
    whyItMatters:
      "The note shows a broken image. Usually the file was never copied in, or was deleted " +
      "from attachments while a note still used it.",
    howToFix: ["Drop the file back into the note, or remove the embed."],
    severity: "warn",
    itemActions: ["open"],
  },

  // ── Storage ──────────────────────────────────────────────────────────────
  {
    id: "heavy-history",
    group: "storage",
    label: "Notes with heavy edit history",
    looksFor: "Notes whose local edit history is many times the size of the note itself.",
    whyItMatters:
      "History this large slows opening and syncing the note and can push it over the server's " +
      "limit even when the text is small.",
    howToFix: [
      "Reset the note's history — it keeps the text and starts a fresh history on every device.",
    ],
    severity: "warn",
    itemActions: ["open", "reset-history"],
    showsBytes: true,
  },
  {
    id: "orphan-history",
    group: "storage",
    label: "Leftover edit history",
    looksFor: "Edit history for notes this vault no longer has.",
    whyItMatters: "It only takes up space. Nothing you can see depends on it.",
    howToFix: ["Reclaim it."],
    severity: "info",
    itemActions: [],
    bulkAction: "reclaim",
    showsBytes: true,
  },
  {
    id: "trash",
    group: "storage",
    label: "Recovery copies of deleted notes",
    looksFor: "Copies Baalda keeps in .context/trash when a note is deleted.",
    whyItMatters:
      "They are your safety net for an accidental delete, and they take up space until emptied.",
    howToFix: ["Empty the trash when you are sure you do not need them."],
    severity: "info",
    itemActions: ["reveal"],
    bulkAction: "empty-trash",
    showsBytes: true,
  },
];

export const CHECK_BY_ID: ReadonlyMap<VaultCheckId, CheckDefinition> = new Map(
  CHECK_DEFINITIONS.map((d) => [d.id, d]),
);

export const CHECK_GROUP_LABELS: Record<CheckDefinition["group"], string> = {
  files: "Files",
  names: "Names & paths",
  links: "Links",
  storage: "Storage",
};

/** One check joined to its result, ready to render. */
export interface CheckRow {
  def: CheckDefinition;
  result: VaultCheckResult;
  passed: boolean;
}

/**
 * Join definitions to results in definition order. A result Rust did not send
 * (older binary) renders as passed-with-zero rather than vanishing, so the list
 * always has the same rows and a missing check is visible as "0", not absent.
 */
export function checkRows(checks: VaultChecks | null): CheckRow[] {
  const byId = new Map(checks?.results.map((r) => [r.id, r]) ?? []);
  return CHECK_DEFINITIONS.map((def) => {
    const result = byId.get(def.id) ?? { id: def.id, count: 0, items: [] };
    return { def, result, passed: result.count === 0 };
  });
}

export interface CheckSummary {
  total: number;
  passed: number;
  /** Failing checks by their severity. */
  errors: number;
  warnings: number;
  infos: number;
  /** "All 15 checks passed" / "2 checks need a look · 1 is housekeeping". */
  headline: string;
}

export function summarizeChecks(rows: CheckRow[]): CheckSummary {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const r of rows) {
    if (r.passed) continue;
    if (r.def.severity === "error") errors++;
    else if (r.def.severity === "warn") warnings++;
    else infos++;
  }
  const passed = rows.length - errors - warnings - infos;
  const attention = errors + warnings;
  let headline: string;
  if (attention === 0 && infos === 0) headline = `All ${rows.length} checks passed`;
  else if (attention === 0) {
    headline = `${passed} of ${rows.length} checks passed · ${infos} housekeeping`;
  } else {
    headline =
      `${attention} check${attention === 1 ? "" : "s"} need${attention === 1 ? "s" : ""} a look` +
      (infos > 0 ? ` · ${infos} housekeeping` : "");
  }
  return { total: rows.length, passed, errors, warnings, infos, headline };
}
