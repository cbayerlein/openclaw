import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type EnforcementMode = "off" | "warn" | "block";

function readEnforcementMode(api: OpenClawPluginApi): EnforcementMode {
  const raw = api.pluginConfig?.enforcementMode;
  if (raw === "off" || raw === "warn" || raw === "block") {
    return raw;
  }
  return "off";
}

const PATCH_STYLE_EXEC_PATTERNS: RegExp[] = [/\bsed\s+-i\b/];

function readExecCommand(params: Record<string, unknown>): string {
  const direct =
    typeof params.command === "string"
      ? params.command
      : typeof params.cmd === "string"
        ? params.cmd
        : "";
  return direct.trim();
}

function isPatchStyleExecCommand(command: string): boolean {
  if (!command) {
    return false;
  }
  return PATCH_STYLE_EXEC_PATTERNS.some((pattern) => pattern.test(command));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export default function register(api: OpenClawPluginApi) {
  const enforcementMode = readEnforcementMode(api);

  api.on("before_tool_call", (event, ctx) => {
    if (enforcementMode === "off") {
      return;
    }

    const key = ctx.sessionKey ?? ctx.agentId ?? "default";
    const reason =
      "Use apply_patch for patch-style file changes. Avoid edit or patch-style in-place exec commands for patching.";
    const shouldWarn = enforcementMode === "warn";

    if (event.toolName === "edit") {
      if (shouldWarn) {
        api.logger.warn(`[apply-patch-preference] ${reason} blockedTool=edit session=${key}`);
        return;
      }
      api.logger.warn(`[apply-patch-preference] ${reason} blockedTool=edit session=${key}`);
      return { block: true, blockReason: reason };
    }

    if (event.toolName === "exec") {
      const command = isRecord(event.params) ? readExecCommand(event.params) : "";
      if (!isPatchStyleExecCommand(command)) {
        return;
      }
      if (shouldWarn) {
        api.logger.warn(
          `[apply-patch-preference] ${reason} blockedTool=exec session=${key} command=${command.slice(0, 120)}`,
        );
        return;
      }
      api.logger.warn(
        `[apply-patch-preference] ${reason} blockedTool=exec session=${key} command=${command.slice(0, 120)}`,
      );
      return { block: true, blockReason: reason };
    }
  });
}
