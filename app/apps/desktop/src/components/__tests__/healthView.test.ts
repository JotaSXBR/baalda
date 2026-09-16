// A render smoke test for the Health page.
//
// React Testing Library is NOT a dependency of this workspace and adding one
// was out of scope, so this drives `HealthView` through `react-dom/server`
// instead: no DOM, no store, no Tauri host — exactly the reason the tab was
// split into a container and a pure view. It is written in `.ts` with
// `createElement` rather than `.tsx` because `vitest.config.ts` includes only
// `src/**/*.test.ts`; a `.tsx` suite here would never run.
//
// What it is for: the page is fed by a Rust census and a sync-layer fold, and
// the states that break a renderer are the empty ones — a vault with no stats,
// no counts, no issues and no files. Those are the fixtures below.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HealthView } from "../HealthTab";
import type {
  HealthActions,
  HealthReport,
  VaultHealthSnapshot,
  VaultStats,
} from "../../lib/health/types";

function actions(): HealthActions {
  return {
    syncNow: vi.fn(async () => {}),
    retryDoc: vi.fn(async () => {}),
    resetHistory: vi.fn(async () => ({ bytesFreed: 0 })),
    reclaimOrphans: vi.fn(async () => ({ docsRemoved: 0, bytesReclaimed: 0 })),
    openNote: vi.fn(),
    reveal: vi.fn(async () => {}),
    deleteNote: vi.fn(async () => {}),
    openUpgrade: vi.fn(),
    requestSignIn: vi.fn(),
    copyDiagnostics: vi.fn(async () => ""),
  };
}

const localReport: HealthReport = {
  verdict: "local",
  headline: "Sync is off for this folder",
  detail: "12 notes live here on this device only.",
  stages: [
    { id: "disk", label: "Files on disk", state: "ok", headline: "12", detail: "d" },
    { id: "index", label: "Local index", state: "ok", headline: "12", detail: "i" },
    { id: "history", label: "Local history", state: "ok", headline: "3", detail: "h" },
    { id: "connection", label: "Connection", state: "off", headline: "Off", detail: "c" },
    { id: "server", label: "Server", state: "off", headline: "Off", detail: "s" },
  ],
  counts: null,
  issues: [],
  lastSyncedAt: null,
  serverHost: null,
};

const stats: VaultStats = {
  computedAt: 1_700_000_000_000,
  notes: { count: 12, bytes: 4096, empty: 1 },
  folders: 3,
  attachments: { count: 0, bytes: 0 },
  otherFiles: { count: 0, bytes: 0 },
  tags: 5,
  links: 9,
  brokenLinks: 2,
  index: { bytes: 65_536 },
  history: { docs: 3, updates: 40, bytes: 2048, orphanDocs: 2, orphanBytes: 1024 },
  largestNotes: [{ path: "a/b/big.md", bytes: 12 * 1024 * 1024, mtime: 1_699_000_000_000 }],
  largestFiles: [],
  heaviestHistory: [
    { docId: "doc-1", path: "a/b/big.md", updates: 30, bytes: 1536 },
    { docId: "doc-2", path: null, updates: 10, bytes: 512 },
  ],
  activity: { modifiedLast7d: 4, modifiedLast30d: 9, weeks: [0, 1, 2, 0, 0, 3, 1, 0, 2, 5, 1, 4] },
};

function snapshot(over: Partial<VaultHealthSnapshot> = {}): VaultHealthSnapshot {
  return {
    report: localReport,
    stats,
    statsError: null,
    loading: false,
    refresh: vi.fn(),
    actions: actions(),
    ...over,
  };
}

const render = (s: VaultHealthSnapshot) =>
  renderToStaticMarkup(createElement(HealthView, { snapshot: s }));

describe("HealthView", () => {
  it("renders a local vault without a sync breakdown", () => {
    const html = render(snapshot());
    expect(html).toContain("Local only");
    expect(html).toContain("Sync is off for this folder");
    expect(html).toContain("Nothing needs attention");
    // No bar, because there are no counts to put in it.
    expect(html).not.toContain("health-bar-seg");
    // And "Sync now" is dead on a folder with nothing to sync to.
    expect(html).toContain("This folder does not sync");
    expect(html).toContain("disabled");
  });

  it("survives a vault with no census at all", () => {
    const html = render(snapshot({ stats: null, loading: true }));
    expect(html).toContain("is-skeleton");
    expect(html).not.toContain("Largest notes");
  });

  it("shows a stats error inline", () => {
    const html = render(snapshot({ stats: null, loading: false, statsError: "no vault" }));
    expect(html).toContain("no vault");
  });

  it("badges a note over the server's cap", () => {
    const html = render(snapshot());
    expect(html).toContain("over the limit");
    expect(html).toContain("12.0 MB");
  });

  it("offers a reclaim button while orphan history exists", () => {
    const html = render(snapshot());
    expect(html).toContain("2 orphan docs");
    expect(html).toContain("Reclaim");
  });

  it("draws the bar and the issue list for a synced vault", () => {
    const html = render(
      snapshot({
        report: {
          ...localReport,
          verdict: "attention",
          counts: {
            total: 10,
            synced: 6,
            pending: 1,
            failed: 2,
            unsynced: 1,
            unreported: 0,
          },
          serverHost: "api.baalda.com",
          issues: [
            {
              key: "doc-1",
              docId: "doc-1",
              path: "Projects/2026/Research/Interviews/Transcripts/session-seventeen.md",
              kind: "too-large",
              severity: "error",
              title: "Too large to sync",
              why: "This note is 12.4 MB; the server accepts up to 10 MB.",
              remedies: ["open", "reveal", "delete"],
              code: null,
            },
          ],
        },
      }),
    );
    expect(html).toContain("Needs attention");
    expect(html).toContain("health-bar-seg");
    expect(html).toContain("60% of 10 notes confirmed");
    expect(html).toContain("Too large to sync");
    // The path is elided in the middle but kept whole in the tooltip.
    expect(html).toContain("…");
    expect(html).toContain(
      'title="Projects/2026/Research/Interviews/Transcripts/session-seventeen.md"',
    );
  });

  it("only offers the remedies an issue actually carries", () => {
    const html = render(
      snapshot({
        report: {
          ...localReport,
          verdict: "signed-out",
          issues: [
            {
              key: "signed-out",
              docId: null,
              path: null,
              kind: "no-access",
              severity: "error",
              title: "Signed out",
              why: "Nothing syncs until you sign in.",
              remedies: ["sign-in"],
              code: null,
            },
          ],
        },
      }),
    );
    expect(html).toContain("Sign in");
    expect(html).not.toContain(">Retry<");
    expect(html).not.toContain(">Delete<");
  });
});
