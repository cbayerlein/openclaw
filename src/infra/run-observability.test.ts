import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getRunObservabilitySummary,
  listRunObservabilityEvents,
  listRunObservabilitySummaries,
  persistRunObservabilityEvent,
} from "./run-observability.js";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const originalFast = process.env.OPENCLAW_TEST_FAST;
const cleanupDirs: string[] = [];

async function createStateDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-run-observability-"));
  cleanupDirs.push(dir);
  process.env.OPENCLAW_STATE_DIR = dir;
  process.env.OPENCLAW_TEST_FAST = "1";
  return dir;
}

describe("run observability store", () => {
  beforeEach(async () => {
    await createStateDir();
  });

  afterEach(async () => {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    if (originalFast === undefined) {
      delete process.env.OPENCLAW_TEST_FAST;
    } else {
      process.env.OPENCLAW_TEST_FAST = originalFast;
    }
    await Promise.all(
      cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("persists run summaries and event timelines with filters", async () => {
    const now = Date.now();
    await persistRunObservabilityEvent({
      runId: "run-a",
      seq: 1,
      ts: now,
      stream: "lifecycle",
      sessionKey: "agent:main:main",
      data: {
        phase: "start",
        startedAt: now,
        selectedProvider: "openai",
        selectedModel: "gpt-5.4",
      },
    });
    await persistRunObservabilityEvent({
      runId: "run-a",
      seq: 2,
      ts: now + 100,
      stream: "tool",
      sessionKey: "agent:main:main",
      data: { phase: "start", toolName: "read" },
    });
    await persistRunObservabilityEvent({
      runId: "run-a",
      seq: 3,
      ts: now + 200,
      stream: "tool",
      sessionKey: "agent:main:main",
      data: { phase: "result", toolName: "read" },
    });
    await persistRunObservabilityEvent({
      runId: "run-a",
      seq: 4,
      ts: now + 300,
      stream: "lifecycle",
      sessionKey: "agent:main:main",
      data: { phase: "end", endedAt: now + 300 },
    });
    await persistRunObservabilityEvent({
      runId: "run-b",
      seq: 1,
      ts: now + 1000,
      stream: "lifecycle",
      sessionKey: "agent:ops:ops",
      data: { phase: "error", error: "boom" },
    });

    const summary = await getRunObservabilitySummary("run-a");
    expect(summary).toMatchObject({
      runId: "run-a",
      sessionKey: "agent:main:main",
      agentId: "main",
      status: "done",
      provider: "openai",
      model: "gpt-5.4",
      eventCount: 4,
      toolCount: 1,
      lastEventKind: "run_finished",
    });

    const list = await listRunObservabilitySummaries({
      sessionKey: "agent:main:main",
      limit: 10,
    });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.runId).toBe("run-a");

    const failed = await listRunObservabilitySummaries({
      status: "failed",
      limit: 10,
    });
    expect(failed.items.map((item) => item.runId)).toEqual(["run-b"]);

    const page1 = await listRunObservabilityEvents({ runId: "run-a", limit: 2 });
    expect(page1.items.map((item) => item.kind)).toEqual(["tool_finished", "run_finished"]);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBe("3");

    const page2 = await listRunObservabilityEvents({
      runId: "run-a",
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.items.map((item) => item.kind)).toEqual(["run_started", "tool_started"]);
  });
});
