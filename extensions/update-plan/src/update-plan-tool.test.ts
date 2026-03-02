import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    resolvePath: (value) => value,
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

    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("Plan updated: 3 step(s)");
    expect(result.content[0]?.text).toContain("- [in_progress] Implement update_plan tool");
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
        plan: [{ step: "step 1", status: "running" as any }],
      }),
    ).rejects.toThrow(/must be one of/i);
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
