// Display helpers for Vault Settings → Health.
//
// Pure and dependency-free (no React, no store, no Tauri) so they unit-test in
// the plain Node vitest environment alongside `model.ts`, the same way
// `components/versionFormat.ts` sits outside `VersionPanel.tsx`.
//
// On reuse: `versionFormat.formatVersionSize` and `Identity.relativeAgo` cover
// the DENSE surfaces — a version row, a sidebar pill — where "4.1 MB" and "3d
// ago" have to fit in a few characters. The Health page is the opposite: a wide
// panel where numbers are the content, so it spells units out ("3 min ago",
// "2 days ago") and carries GB, which the version formatter stops short of.
// Same reason both exist rather than one: they are different registers, not a
// duplicated implementation.

import type { HealthVerdict } from "./types";

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/**
 * A size for a stat tile or a table cell: "812 B", "94 KB", "4.1 MB", "1.2 GB".
 *
 * Whole numbers below a megabyte — a tenth of a kilobyte is noise nobody acts
 * on — and one decimal above it, where the tenth is the difference between a
 * note that syncs and one the server refuses. Negative, NaN and Infinity all
 * come back as "0 B" rather than throwing: every one of these is fed by a
 * count the Rust census produced, and a broken census must not blank the page.
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < KB) return `${Math.round(n)} B`;
  if (n < MB) return `${Math.round(n / KB).toLocaleString()} KB`;
  if (n < GB) return `${(n / MB).toFixed(1)} MB`;
  return `${(n / GB).toFixed(1)} GB`;
}

/**
 * How long ago something happened, spelled out: "just now", "3 min ago",
 * "5 hours ago", "2 days ago". A future timestamp (a clock skew between this
 * device and a file's mtime) reads as "just now" rather than "in 3 minutes",
 * which would send the reader looking for a bug that isn't theirs.
 */
export function relativeTime(ms: number, now: number): string {
  if (!Number.isFinite(ms)) return "—";
  const secs = Math.floor((now - ms) / 1000);
  if (secs < 45) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${Math.max(1, mins)} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} ${months === 1 ? "month" : "months"} ago`;
  const years = Math.floor(days / 365);
  return `${years} ${years === 1 ? "year" : "years"} ago`;
}

/**
 * Shorten a path from the MIDDLE: "Projects/Q3/…/meeting-notes.md". The two
 * ends are the two things a reader needs — which folder it came from and which
 * file it is — and an end-truncated path throws the filename away, which is the
 * half that identifies the row.
 *
 * The full path always goes in a `title` attribute at the call site; this is
 * only what fits on the line.
 */
export function middleTruncate(path: string, max: number): string {
  if (max <= 1) return "…";
  if (path.length <= max) return path;
  // One character of the budget is the ellipsis itself; the head keeps the
  // extra when the remainder is odd, because the leading folder disambiguates
  // more often than the second-to-last character of a filename does.
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${path.slice(0, head)}…${tail > 0 ? path.slice(path.length - tail) : ""}`;
}

/** The verdict pill's words. Sentence case, like every other label in settings. */
export function verdictLabel(v: HealthVerdict): string {
  switch (v) {
    case "local":
      return "Local only";
    case "signed-out":
      return "Signed out";
    case "no-access":
      return "No access";
    case "offline":
      return "Offline";
    case "connecting":
      return "Connecting";
    case "syncing":
      return "Syncing";
    case "attention":
      return "Needs attention";
    case "healthy":
      return "Healthy";
  }
}

/** The tone a verdict paints in. Maps to the `--success/--warning/--danger`
 *  families in `health.css`; `muted` is the deliberate no-colour case, because
 *  a local vault is not in a degraded state — it simply isn't syncing. */
export function verdictTone(
  v: HealthVerdict,
): "good" | "busy" | "warn" | "bad" | "muted" {
  switch (v) {
    case "healthy":
      return "good";
    case "connecting":
    case "syncing":
      return "busy";
    case "attention":
    case "offline":
      return "warn";
    case "signed-out":
    case "no-access":
      return "bad";
    case "local":
      return "muted";
  }
}
