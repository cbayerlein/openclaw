import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSessionStore, saveSessionStore } from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
import { getPlanCompletionAdvisoryMessage, shouldWarnAboutPlanCompletion } from "../guardrails.js";
import { createUpdatePlanTool } from "./update-plan-tool.js";

const tempDirs: string[] = [];

async function createStoreFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-plan-"));
  tempDirs.push(dir);
  const storePath = path.join(dir, "sessions.json");
  const sessionKey = "agent:main:main";
  const entry: SessionEntry = {
    sessionId: "sess-1",
    updatedAt: Date.now(),
  };
  await saveSessionStore(storePath, { [sessionKey]: entry });
  return { storePath, sessionKey };
}

afterEach(async () => {
  resetAgentEventsForTest();
  resetSystemEventsForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("update_plan tool", () => {
  it("returns a compact success payload when no session persistence is configured", async () => {
    const tool = createUpdatePlanTool();
    const result = await tool.execute("call-1", {
      explanation: "Started work",
      plan: [
        { step: "Inspect harness", status: "completed" },
        { step: "Add tool", status: "in_progress" },
        { step: "Run tests", status: "pending" },
      ],
    });

    expect(result.content).toEqual([]);
    expect(result.details).toEqual({
      status: "updated",
      explanation: "Started work",
      plan: [
        { step: "Inspect harness", status: "completed" },
        { step: "Add tool", status: "in_progress" },
        { step: "Run tests", status: "pending" },
      ],
    });
  });

  it("rejects multiple in-progress steps in ephemeral mode", async () => {
    const tool = createUpdatePlanTool();

    await expect(
      tool.execute("call-1", {
        plan: [
          { step: "One", status: "in_progress" },
          { step: "Two", status: "in_progress" },
        ],
      }),
    ).rejects.toThrow("plan can contain at most one in_progress step");
  });

  it("persists the active session plan and returns a summary", async () => {
    const { storePath, sessionKey } = await createStoreFixture();
    const activePlanRef: { value?: SessionEntry["activePlan"] } = {};
    const tool = createUpdatePlanTool({
      sessionKey,
      storePath,
      runId: "run-1",
      activePlanRef,
      persistSessionPlan: true,
    });

    const result = await tool.execute("call-1", {
      explanation: "Ship the feature cleanly",
      plan: [
        { step: "Inspect architecture", status: "completed" },
        { step: "Implement core guardrails", status: "in_progress" },
      ],
    });

    const firstBlock = result.content[0];
    expect(firstBlock?.type).toBe("text");
    if (!firstBlock || firstBlock.type !== "text") {
      throw new Error("expected text result block");
    }
    expect(firstBlock.text).toContain("Plan updated:");
    expect(activePlanRef.value?.steps).toHaveLength(2);

    const persisted = loadSessionStore(storePath)[sessionKey];
    expect(persisted?.activePlan?.explanation).toBe("Ship the feature cleanly");
    expect(persisted?.activePlan?.steps).toEqual([
      { step: "Inspect architecture", status: "completed" },
      { step: "Implement core guardrails", status: "in_progress" },
    ]);
  });

  it("rejects invalid plan shapes in persisted mode", async () => {
    const { storePath, sessionKey } = await createStoreFixture();
    const tool = createUpdatePlanTool({
      sessionKey,
      storePath,
      runId: "run-2",
      persistSessionPlan: true,
    });

    await expect(
      tool.execute("call-2", {
        plan: [
          { step: "Inspect the current agent architecture", status: "in_progress" },
          { step: "Implement the planning guardrail changes", status: "in_progress" },
        ],
      }),
    ).rejects.toThrow("Only one plan step may be in_progress");
  });

  it("rejects plans with too few or too-generic steps", async () => {
    const { storePath, sessionKey } = await createStoreFixture();
    const tool = createUpdatePlanTool({
      sessionKey,
      storePath,
      runId: "run-2b",
      persistSessionPlan: true,
    });
    if (!tool) {
      throw new Error("expected update_plan tool");
    }

    await expect(
      tool.execute("call-2b", {
        plan: [{ step: "Inspect architecture", status: "in_progress" }],
      }),
    ).rejects.toThrow("at least two concrete steps");

    await expect(
      tool.execute("call-2c", {
        plan: [
          { step: "Continue", status: "in_progress" },
          { step: "Do work", status: "pending" },
        ],
      }),
    ).rejects.toThrow("too generic");
  });

  it("creates a minimal session entry when only an explicit session id is available", async () => {
    const { storePath, sessionKey } = await createStoreFixture();
    const store = loadSessionStore(storePath);
    delete store[sessionKey];
    await saveSessionStore(storePath, store);

    const tool = createUpdatePlanTool({
      sessionKey,
      sessionId: "explicit-session-id",
      storePath,
      runId: "run-3",
      persistSessionPlan: true,
    });

    await tool.execute("call-3", {
      explanation: "Recover from explicit session-id runs",
      plan: [
        { step: "Create the active plan entry", status: "in_progress" },
        { step: "Continue the requested work", status: "pending" },
      ],
    });

    const persisted = loadSessionStore(storePath)[sessionKey];
    expect(persisted?.sessionId).toBe("explicit-session-id");
    expect(persisted?.activePlan?.steps).toEqual([
      { step: "Create the active plan entry", status: "in_progress" },
      { step: "Continue the requested work", status: "pending" },
    ]);
  });

  it("flags plans with no completed steps for completion advisory", () => {
    expect(
      shouldWarnAboutPlanCompletion({
        updatedAt: Date.now(),
        steps: [
          { step: "Inspect architecture", status: "in_progress" },
          { step: "Implement guardrails", status: "pending" },
        ],
      }),
    ).toBe(true);
    expect(
      shouldWarnAboutPlanCompletion({
        updatedAt: Date.now(),
        steps: [
          { step: "Inspect architecture", status: "completed" },
          { step: "Implement guardrails", status: "in_progress" },
        ],
      }),
    ).toBe(false);
    expect(getPlanCompletionAdvisoryMessage()).toContain("no completed plan steps");
  });
});
