import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import { wrapToolWithBeforeToolCallHook } from "./pi-tools.before-tool-call.js";
import { createUpdatePlanTool } from "./tools/update-plan-tool.js";

const tempDirs: string[] = [];

afterEach(async () => {
  resetAgentEventsForTest();
  resetSystemEventsForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("guardrail before_tool_call behavior", () => {
  it("blocks substantive tool calls when no active plan exists", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
    const off = onAgentEvent((evt) => {
      events.push({ stream: evt.stream, data: evt.data });
    });
    const tool = wrapToolWithBeforeToolCallHook({ name: "read", execute } as never, {
      sessionKey: "agent:main:main",
      sessionId: "sess-1",
      runId: "run-1",
      guardrails: {
        planningMode: "enforced",
        persistSessionPlan: true,
        planningRequirement: "almost_always",
        editPreferenceMode: "enforced",
        preferredEditTool: "apply_patch",
      },
      activePlanRef: {},
    });

    await expect(tool.execute("call-1", { path: "README.md" })).rejects.toThrow(
      "Planning required before substantial work",
    );
    expect(execute).not.toHaveBeenCalled();
    expect(peekSystemEvents("agent:main:main")[0]).toContain(
      "Planning required before substantial work",
    );
    expect(events.some((evt) => evt.data.event === "plan_missing_blocked")).toBe(true);
    off();
  });

  it("emits only an advisory when planning mode is advisory", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
    const off = onAgentEvent((evt) => {
      events.push({ stream: evt.stream, data: evt.data });
    });
    const tool = wrapToolWithBeforeToolCallHook({ name: "read", execute } as never, {
      sessionKey: "agent:main:main",
      sessionId: "sess-adv-1",
      runId: "run-adv-1",
      guardrails: {
        planningMode: "advisory",
        persistSessionPlan: true,
        planningRequirement: "almost_always",
        editPreferenceMode: "enforced",
        preferredEditTool: "apply_patch",
      },
      activePlanRef: {},
    });

    await expect(tool.execute("call-adv-1", { path: "README.md" })).resolves.toEqual({
      content: [],
      details: { ok: true },
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(events.some((evt) => evt.data.event === "plan_missing_advisory")).toBe(true);
    expect(peekSystemEvents("agent:main:main")[0]).toContain(
      "Planning required before substantial work",
    );
    off();
  });

  it("allows clearly trivial tool calls without a plan under almost_always", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
    const off = onAgentEvent((evt) => {
      events.push({ stream: evt.stream, data: evt.data });
    });
    const tool = wrapToolWithBeforeToolCallHook({ name: "ls", execute } as never, {
      sessionKey: "agent:main:main",
      sessionId: "sess-trivial-1",
      runId: "run-trivial-1",
      guardrails: {
        planningMode: "enforced",
        persistSessionPlan: true,
        planningRequirement: "almost_always",
        editPreferenceMode: "enforced",
        preferredEditTool: "apply_patch",
      },
      activePlanRef: {},
    });

    await expect(tool.execute("call-trivial-1", { path: "." })).resolves.toEqual({
      content: [],
      details: { ok: true },
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(events).toHaveLength(0);
    expect(peekSystemEvents("agent:main:main")).toHaveLength(0);
    off();
  });

  it("blocks obvious exec-based file writes and directs the agent to apply_patch", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook({ name: "exec", execute } as never, {
      sessionKey: "agent:main:main",
      sessionId: "sess-2",
      runId: "run-2",
      workspaceDir: "/tmp/openclaw",
      guardrails: {
        planningMode: "enforced",
        persistSessionPlan: true,
        planningRequirement: "almost_always",
        editPreferenceMode: "enforced",
        preferredEditTool: "apply_patch",
      },
      activePlanRef: {
        value: {
          updatedAt: Date.now(),
          steps: [{ step: "Implement change", status: "in_progress" }],
        },
      },
    });

    await expect(
      tool.execute("call-2", { command: "cat <<'EOF' > src/file.ts\ntext\nEOF" }),
    ).rejects.toThrow("Structured edits must use apply_patch");
    expect(execute).not.toHaveBeenCalled();
  });

  it("blocks overwriting existing files through write", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-guardrail-write-"));
    tempDirs.push(dir);
    const target = path.join(dir, "existing.ts");
    await fs.writeFile(target, "old", "utf8");

    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook({ name: "write", execute } as never, {
      sessionKey: "agent:main:main",
      sessionId: "sess-3",
      runId: "run-3",
      workspaceDir: dir,
      guardrails: {
        planningMode: "enforced",
        persistSessionPlan: true,
        planningRequirement: "almost_always",
        editPreferenceMode: "enforced",
        preferredEditTool: "apply_patch",
      },
      activePlanRef: {
        value: {
          updatedAt: Date.now(),
          steps: [{ step: "Implement change", status: "in_progress" }],
        },
      },
    });

    await expect(tool.execute("call-3", { path: "existing.ts", content: "new" })).rejects.toThrow(
      "Overwriting an existing file should use apply_patch",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("lets read proceed after update_plan succeeds in the same session", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-guardrail-plan-"));
    tempDirs.push(dir);
    const activePlanRef: {
      value?: {
        updatedAt: number;
        explanation?: string;
        steps: Array<{ step: string; status: "pending" | "in_progress" | "completed" }>;
      };
    } = {};
    const updatePlan = createUpdatePlanTool({
      sessionKey: "agent:main:main",
      sessionId: "sess-plan-1",
      storePath: path.join(dir, "sessions.json"),
      runId: "run-plan-1",
      activePlanRef,
      persistSessionPlan: true,
    });
    const readExecute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "guardrail regression fixture" }],
      details: { ok: true },
    });
    const read = wrapToolWithBeforeToolCallHook({ name: "read", execute: readExecute } as never, {
      sessionKey: "agent:main:main",
      sessionId: "sess-plan-1",
      runId: "run-plan-1",
      guardrails: {
        planningMode: "enforced",
        persistSessionPlan: true,
        planningRequirement: "almost_always",
        editPreferenceMode: "enforced",
        preferredEditTool: "apply_patch",
      },
      activePlanRef,
    });

    await expect(read.execute("call-plan-read-blocked", { path: "README.md" })).rejects.toThrow(
      "Planning required before substantial work",
    );
    expect(readExecute).not.toHaveBeenCalled();

    await expect(
      updatePlan.execute("call-plan-update", {
        plan: [
          { step: "Inspect the regression path", status: "completed" },
          { step: "Read the requested file", status: "in_progress" },
        ],
      }),
    ).resolves.toBeDefined();

    expect(activePlanRef.value?.steps).toEqual([
      { step: "Inspect the regression path", status: "completed" },
      { step: "Read the requested file", status: "in_progress" },
    ]);

    await expect(read.execute("call-plan-read-ok", { path: "README.md" })).resolves.toEqual(
      expect.objectContaining({
        content: expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("guardrail regression fixture"),
          }),
        ]),
      }),
    );
    expect(readExecute).toHaveBeenCalledOnce();
  });
});
