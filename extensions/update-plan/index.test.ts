import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import register from "./index.js";

function createApi(registerTool: OpenClawPluginApi["registerTool"]): OpenClawPluginApi {
  return {
    id: "update-plan",
    name: "update-plan",
    source: "test",
    config: {},
    pluginConfig: {},
    runtime: {
      version: "test",
      state: {
        resolveStateDir: () => "/tmp",
      },
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
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
    resolvePath: (value) => value,
    on() {},
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
});
