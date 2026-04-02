import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.ts";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

describe("runEmbeddedPiAgent active plan forwarding", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
  });

  it("forwards the active session plan into the embedded attempt", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["done"],
      }),
    );

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-active-plan-forwarding",
      activePlan: {
        updatedAt: 123,
        steps: [
          { step: "Inspect the repository", status: "in_progress" },
          { step: "Report the result", status: "pending" },
        ],
      },
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        activePlan: {
          updatedAt: 123,
          steps: [
            { step: "Inspect the repository", status: "in_progress" },
            { step: "Report the result", status: "pending" },
          ],
        },
      }),
    );
  });
});
