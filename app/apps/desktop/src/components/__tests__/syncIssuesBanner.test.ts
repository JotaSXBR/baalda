// The strip that says a finished sync run left notes behind.
//
// Its one decision is whether to be up at all, and every refusal in it is a way
// of alarming someone about nothing: a local vault that never syncs, a run still
// moving, a run that failed with no named casualty, and a failure the user has
// already read and waved away.

import { describe, expect, it } from "vitest";
import { syncIssuesBanner } from "../SyncIssuesBanner";
import type { SyncProgress } from "../../lib/sync/vaultScope";

const run = (p: Partial<SyncProgress>): SyncProgress => ({
  phase: "error",
  done: 500,
  total: 500,
  failed: 0,
  ...p,
});

const args = (over: Partial<Parameters<typeof syncIssuesBanner>[0]> = {}) => ({
  syncEnabled: true,
  progress: run({ failed: 12 }),
  runToken: 1,
  dismissedRunToken: null,
  ...over,
});

describe("syncIssuesBanner", () => {
  it("is up when a run ended in failure with notes left behind", () => {
    expect(syncIssuesBanner(args())).toEqual({ show: true, failed: 12 });
  });

  it("says nothing on a vault that is not syncing at all", () => {
    expect(syncIssuesBanner(args({ syncEnabled: false }))).toEqual({
      show: false,
      failed: 0,
    });
  });

  it("says nothing while a run is still moving", () => {
    for (const phase of ["idle", "registering", "uploading", "downloading", "done"] as const) {
      expect(syncIssuesBanner(args({ progress: run({ phase, failed: 12 }) })).show).toBe(
        false,
      );
    }
    expect(syncIssuesBanner(args({ progress: null })).show).toBe(false);
  });

  it("says nothing when the run failed without naming a note", () => {
    // The channel watchdog: the app never reached the server, so there is no
    // per-note reason for the Health page to show. The pill reads "Retrying…".
    expect(syncIssuesBanner(args({ progress: run({ failed: 0 }) }))).toEqual({
      show: false,
      failed: 0,
    });
  });

  it("stays down for the run the user dismissed", () => {
    expect(syncIssuesBanner(args({ dismissedRunToken: 1 }))).toEqual({
      show: false,
      failed: 12,
    });
  });

  it("comes back for the NEXT failing run", () => {
    // Dismiss is about one failure, not about the feature.
    expect(syncIssuesBanner(args({ runToken: 2, dismissedRunToken: 1 }))).toEqual({
      show: true,
      failed: 12,
    });
  });

  it("reports the count it was given, so the copy and the pill agree", () => {
    expect(syncIssuesBanner(args({ progress: run({ failed: 1 }) })).failed).toBe(1);
    expect(syncIssuesBanner(args({ progress: run({ failed: 307 }) })).failed).toBe(307);
  });
});
