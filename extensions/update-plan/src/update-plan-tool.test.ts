import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../../../src/plugins/types.js";
import { createUpdatePlanTool } from "./update-plan-tool.js";

function createApi(stateDir: string): OpenClawPluginApi {
  return {
    id: "update-plan",
    name: "update-plan",
    source: "test",
    config: {},
    pluginConfig: {},
    runtime: {
      version: "test",
      state: {
        resolveStateDir: () => stateDir,
      },
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    registerTool() {},
    registerHook() {},
    registerHttpHandler() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService() {},
    registerProvider() {},
    registerCommand() {},
    resolvePath: (value: string) => value,
    on() {},
  } as unknown as OpenClawPluginApi;
}

function createContext(
  overrides: Partial<OpenClawPluginToolContext> = {},
): OpenClawPluginToolContext {
  return {
    workspaceDir: "/tmp/workspace",
    agentDir: "/tmp/agent",
    agentId: "main",
    sessionKey: "agent:main:default",
    messageChannel: "terminal",
    sandboxed: false,
    ...overrides,
  };
}

describe("update_plan tool", () => {
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-plan-"));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("accepts a valid plan, returns a summary, and persists it", async () => {
    const tool = createUpdatePlanTool(createApi(stateDir), createContext());

    const result = await tool.execute("call-1", {
      explanation: "Work through the main implementation.",
      plan: [
        { step: "Inspect plugin APIs", status: "completed" },
        { step: "Implement update_plan tool", status: "in_progress" },
        { step: "Add tests", status: "pending" },
      ],
    });

    const firstContent = result.content[0];
    expect(firstContent?.type).toBe("text");
    expect(firstContent && firstContent.type === "text" ? firstContent.text : "").toContain(
      "Plan updated: 3 step(s)",
    );
    expect(firstContent && firstContent.type === "text" ? firstContent.text : "").toContain(
      "- [in_progress] Implement update_plan tool",
    );
    expect(result.details).toMatchObject({
      counts: { pending: 1, in_progress: 1, completed: 1 },
    });

    const lastPlanPath = path.join(stateDir, "plugins", "update-plan", "last-plan.json");
    const sessionPath = path.join(
      stateDir,
      "plugins",
      "update-plan",
      "sessions",
      "agent_main_default.json",
    );
    const lastPlanRaw = await fs.readFile(lastPlanPath, "utf8");
    const sessionRaw = await fs.readFile(sessionPath, "utf8");
    const lastPlan = JSON.parse(lastPlanRaw) as { sessionKey?: string; plan?: unknown[] };
    const perSession = JSON.parse(sessionRaw) as { sessionKey?: string; plan?: unknown[] };

    expect(lastPlan.sessionKey).toBe("agent:main:default");
    expect(perSession.sessionKey).toBe("agent:main:default");
    expect(lastPlan.plan).toHaveLength(3);
    expect(perSession.plan).toHaveLength(3);
  });

  it("rejects empty step strings", async () => {
    const tool = createUpdatePlanTool(createApi(stateDir), createContext());

    await expect(
      tool.execute("call-empty", {
        plan: [{ step: "   ", status: "pending" }],
      }),
    ).rejects.toThrow(/non-empty string/i);
  });

  it("rejects payloads with multiple in_progress steps", async () => {
    const tool = createUpdatePlanTool(createApi(stateDir), createContext());

    await expect(
      tool.execute("call-multi-progress", {
        plan: [
          { step: "step 1", status: "in_progress" },
          { step: "step 2", status: "in_progress" },
        ],
      }),
    ).rejects.toThrow(/at most one/i);
  });

  it("rejects invalid status values", async () => {
    const tool = createUpdatePlanTool(createApi(stateDir), createContext());

    await expect(
      tool.execute("call-bad-status", {
        // oxlint-disable-next-line typescript/no-explicit-any
        plan: [{ step: "step 1", status: "banana" as any }],
      }),
    ).rejects.toThrow(/Invalid update_plan status value/i);
  });

  it("normalizes common status variants before persisting", async () => {
    const tool = createUpdatePlanTool(createApi(stateDir), createContext());

    const result = await tool.execute("call-normalized", {
      plan: [
        { step: "step 1", status: "NOT_STARTED" },
        { step: "step 2", status: "in-progress" },
        { step: "step 3", status: "done" },
      ],
    });

    expect(result.details).toMatchObject({
      plan: [
        { step: "step 1", status: "pending" },
        { step: "step 2", status: "in_progress" },
        { step: "step 3", status: "completed" },
      ],
      counts: { pending: 1, in_progress: 1, completed: 1 },
    });
  });

  it("returns precise diagnostics when status variants are unmappable", async () => {
    const tool = createUpdatePlanTool(createApi(stateDir), createContext());

    await expect(
      tool.execute("call-unmappable", {
        plan: [
          { step: "step 1", status: "teleporting" },
          { step: "step 2", status: "pending" },
        ],
      }),
    ).rejects.toThrow(/Auto-normalization was attempted once/i);
  });

  it("stores only last-plan when no session key is provided", async () => {
    const tool = createUpdatePlanTool(
      createApi(stateDir),
      createContext({ sessionKey: undefined }),
    );

    const result = await tool.execute("call-no-session", {
      plan: [{ step: "Do work", status: "pending" }],
    });

    expect(result.details).toMatchObject({
      persisted: {
        sessionPath: undefined,
      },
    });

    const sessionDir = path.join(stateDir, "plugins", "update-plan", "sessions");
    await expect(fs.stat(sessionDir)).rejects.toThrow();
  });
});
