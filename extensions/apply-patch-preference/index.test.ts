import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import register from "./index.js";

function createApi(
  opts: {
    pluginConfig?: Record<string, unknown>;
    on?: OpenClawPluginApi["on"];
    logger?: OpenClawPluginApi["logger"];
  } = {},
): OpenClawPluginApi {
  return {
    id: "apply-patch-preference",
    name: "apply-patch-preference",
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
    on: opts.on ?? (() => {}),
  } as unknown as OpenClawPluginApi;
}

describe("apply-patch-preference plugin", () => {
  it("block mode blocks edit and sed -i, but allows write and normal exec", () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const on = vi.fn((hookName: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(hookName, handler);
    });

    register(createApi({ pluginConfig: { enforcementMode: "block" }, on }));

    const beforeToolCall = handlers.get("before_tool_call");
    expect(beforeToolCall).toBeTypeOf("function");

    const blockedEdit = beforeToolCall?.(
      { toolName: "edit", params: { file_path: "/tmp/a.ts", old_string: "a", new_string: "b" } },
      { sessionKey: "agent:main:test", agentId: "main", toolName: "edit" },
    ) as { block?: boolean } | undefined;
    expect(blockedEdit?.block).toBe(true);

    const blockedExec = beforeToolCall?.(
      { toolName: "exec", params: { command: "sed -i 's/a/b/' src/a.ts" } },
      { sessionKey: "agent:main:test", agentId: "main", toolName: "exec" },
    ) as { block?: boolean } | undefined;
    expect(blockedExec?.block).toBe(true);

    const allowedWrite = beforeToolCall?.(
      { toolName: "write", params: { file_path: "/tmp/note.txt", content: "ok" } },
      { sessionKey: "agent:main:test", agentId: "main", toolName: "write" },
    );
    expect(allowedWrite).toBeUndefined();

    const allowedExec = beforeToolCall?.(
      { toolName: "exec", params: { command: "echo hi > /tmp/out.txt && pnpm -v" } },
      { sessionKey: "agent:main:test", agentId: "main", toolName: "exec" },
    );
    expect(allowedExec).toBeUndefined();
  });

  it("warn mode warns without blocking", () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const on = vi.fn((hookName: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(hookName, handler);
    });
    const logger = { debug() {}, info() {}, warn: vi.fn(), error() {} };

    register(createApi({ pluginConfig: { enforcementMode: "warn" }, on, logger }));
    const beforeToolCall = handlers.get("before_tool_call");

    const res = beforeToolCall?.(
      { toolName: "edit", params: { file_path: "/tmp/a.ts", old_string: "a", new_string: "b" } },
      { sessionKey: "agent:main:test", agentId: "main", toolName: "edit" },
    );

    expect(res).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
