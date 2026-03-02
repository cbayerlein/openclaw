import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createUpdatePlanTool } from "./src/update-plan-tool.js";

export default function register(api: OpenClawPluginApi) {
  api.registerTool((ctx) => createUpdatePlanTool(api, ctx), { optional: true });
}
