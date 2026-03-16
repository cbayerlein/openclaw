import { describe, expect, it, vi } from "vitest";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  PluginHookHandlerMap,
  PluginHookName,
} from "../../src/plugins/types.js";
import register from "./index.js";

function createApi(
  registerTool: OpenClawPluginApi["registerTool"],
  opts: {
    pluginConfig?: Record<string, unknown>;
    on?: OpenClawPluginApi["on"];
    logger?: OpenClawPluginApi["logger"];
  } = {},
): OpenClawPluginApi {
  return {
    id: "update-plan",
    name: "update-plan",
    source: "test",
    config: {},
    pluginConfig: opts.pluginConfig ?? {},
    runtime: {
      version: "test",
      state: {
        resolveStateDir: () => "/tmp",
      },
    },
    logger: opts.logger ?? { debug() {}, info() {}, warn() {}, error() {} },
    registerTool,
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
    on: opts.on ?? (() => {}),
  } as unknown as OpenClawPluginApi;
}

describe("update-plan plugin registration", () => {
  it("registers update_plan as an optional tool", () => {
    const registerTool = vi.fn();
    register(createApi(registerTool));

    expect(registerTool).toHaveBeenCalledTimes(1);
    const [factory, opts] = registerTool.mock.calls[0] as [
      (ctx: OpenClawPluginToolContext) => { name: string } | null | undefined,
      { optional?: boolean },
    ];
    expect(opts).toMatchObject({ optional: true });

    const tool = factory({
      sessionKey: "agent:main:test",
      agentId: "main",
      workspaceDir: "/tmp",
    });
    expect(tool?.name).toBe("update_plan");
  });

  it("blocks non-update_plan tool calls in block mode until update_plan is called", () => {
    const registerTool = vi.fn();
    const handlers = new Map<PluginHookName, PluginHookHandlerMap[PluginHookName]>();
    const on: OpenClawPluginApi["on"] = (hookName, handler) => {
      handlers.set(hookName, handler);
    };

    register(createApi(registerTool, { pluginConfig: { enforcementMode: "block" }, on }));

    const beforeModelResolve = handlers.get("before_model_resolve") as
      | PluginHookHandlerMap["before_model_resolve"]
      | undefined;
    const beforeToolCall = handlers.get("before_tool_call") as
      | PluginHookHandlerMap["before_tool_call"]
      | undefined;

    expect(beforeModelResolve).toBeTypeOf("function");
    expect(beforeToolCall).toBeTypeOf("function");

    beforeModelResolve?.(
      { prompt: "test prompt" },
      { sessionKey: "agent:main:test", agentId: "main" },
    );
    const blocked = beforeToolCall?.(
      { toolName: "read", params: {} },
      { sessionKey: "agent:main:test", agentId: "main", toolName: "read" },
    ) as { block?: boolean; blockReason?: string } | undefined;
    expect(blocked?.block).toBe(true);
    expect(blocked?.blockReason).toContain("update_plan");

    beforeToolCall?.(
      { toolName: "update_plan", params: { plan: [{ step: "x", status: "in_progress" }] } },
      { sessionKey: "agent:main:test", agentId: "main", toolName: "update_plan" },
    );
    const allowedAfterPlanning = beforeToolCall?.(
      { toolName: "read", params: {} },
      { sessionKey: "agent:main:test", agentId: "main", toolName: "read" },
    );
    expect(allowedAfterPlanning).toBeUndefined();
  });

  it("warn mode does not block but emits a warning", () => {
    const registerTool = vi.fn();
    const handlers = new Map<PluginHookName, PluginHookHandlerMap[PluginHookName]>();
    const on: OpenClawPluginApi["on"] = (hookName, handler) => {
      handlers.set(hookName, handler);
    };
    const logger = { debug() {}, info() {}, warn: vi.fn(), error() {} };

    register(createApi(registerTool, { pluginConfig: { enforcementMode: "warn" }, on, logger }));

    const beforeModelResolve = handlers.get("before_model_resolve") as
      | PluginHookHandlerMap["before_model_resolve"]
      | undefined;
    const beforeToolCall = handlers.get("before_tool_call") as
      | PluginHookHandlerMap["before_tool_call"]
      | undefined;

    beforeModelResolve?.(
      { prompt: "test prompt" },
      { sessionKey: "agent:main:test", agentId: "main" },
    );
    const res = beforeToolCall?.(
      { toolName: "exec", params: {} },
      { sessionKey: "agent:main:test", agentId: "main", toolName: "exec" },
    );

    expect(res).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
