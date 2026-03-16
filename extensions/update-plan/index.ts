import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createUpdatePlanTool } from "./src/update-plan-tool.js";

type EnforcementMode = "off" | "warn" | "block";

function readEnforcementMode(api: OpenClawPluginApi): EnforcementMode {
  const raw = api.pluginConfig?.enforcementMode;
  if (raw === "off" || raw === "warn" || raw === "block") {
    return raw;
  }
  return "off";
}

export default function register(api: OpenClawPluginApi) {
  const enforcementMode = readEnforcementMode(api);
  const planningRequiredBySession = new Map<string, boolean>();

  api.on("before_model_resolve", (_event, ctx) => {
    const key = ctx.sessionKey ?? ctx.agentId ?? "default";
    planningRequiredBySession.set(key, true);
  });

  api.on("agent_end", (_event, ctx) => {
    const key = ctx.sessionKey ?? ctx.agentId ?? "default";
    planningRequiredBySession.delete(key);
  });

  api.on("before_tool_call", (event, ctx) => {
    const key = ctx.sessionKey ?? ctx.agentId ?? "default";
    if (event.toolName === "update_plan") {
      planningRequiredBySession.set(key, false);
      return;
    }

    if (enforcementMode !== "off" && planningRequiredBySession.get(key)) {
      const reason = "Call update_plan first for multi-step work, then continue with other tools.";
      if (enforcementMode === "warn") {
        api.logger.warn(`[update-plan] ${reason} blockedTool=${event.toolName} session=${key}`);
      } else {
        return { block: true, blockReason: reason };
      }
    }
  });

  api.registerTool((ctx) => createUpdatePlanTool(api, ctx), { optional: true });
}
