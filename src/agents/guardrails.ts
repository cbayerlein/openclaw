import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionActivePlan, SessionActivePlanStatus } from "../config/sessions.js";
import { resolveAgentConfig } from "./agent-scope.js";

export const UPDATE_PLAN_TOOL_NAME = "update_plan";
const PLAN_STATUS_VALUES: SessionActivePlanStatus[] = ["pending", "in_progress", "completed"];
const FORMATTER_COMMAND_PATTERNS = [
  /\bprettier\b/i,
  /\beslint\b.*\s--fix(?:\s|$)/i,
  /\boxfmt\b.*\s--write(?:\s|$)/i,
  /\brustfmt\b/i,
  /\bgofmt\b.*\s-w(?:\s|$)/i,
  /\bclang-format\b.*\s-i(?:\s|$)/i,
];
const EXEC_WRITE_PATTERNS = [
  /(^|[;&|]\s*)cat\s+<<[-'"]?\w+/i,
  /(^|[;&|]\s*)tee(?:\s+-a)?\s+\S+/i,
  /(^|[;&|]\s*)sed\s+-i(?:\s|$)/i,
  /(^|[;&|]\s*)perl\s+-0?pi/i,
  />\s*[^>|]/,
  /\bpython(?:3)?\b[\s\S]*?\s-c\s+[\s\S]*(write_text|write_bytes|open\s*\([^)]*,\s*['"]w)/i,
  /\bnode\b[\s\S]*?\s-e\s+[\s\S]*(writeFileSync|writeFile\()/i,
];
const NO_PLAN_BLOCK_MESSAGE =
  "Planning required before substantial work. Call update_plan first. Provide 2-5 concrete steps, use exactly one in_progress step, keep the rest pending or completed, then continue with the task.";
const GENERIC_PLAN_STEP_PATTERNS = [
  /^do work$/i,
  /^continue$/i,
  /^continue working$/i,
  /^make progress$/i,
  /^investigate$/i,
  /^analyze$/i,
  /^fix issue$/i,
  /^work on task$/i,
  /^implement$/i,
  /^complete task$/i,
];

export type ActivePlanRef = {
  value?: SessionActivePlan;
};

export type ResolvedGuardrailConfig = {
  planningMode: "off" | "advisory" | "enforced";
  persistSessionPlan: boolean;
  planningRequirement: "almost_always";
  editPreferenceMode: "off" | "advisory" | "enforced";
  preferredEditTool: "apply_patch";
};

export type GuardrailHookContext = {
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  workspaceDir?: string;
  activePlanRef?: ActivePlanRef;
  guardrails?: ResolvedGuardrailConfig;
};

export type ValidatedActivePlanInput = {
  explanation?: string;
  steps: SessionActivePlan["steps"];
};

export function resolveGuardrailConfig(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): ResolvedGuardrailConfig {
  const globalTools = params.cfg?.tools;
  const agentTools =
    params.cfg && params.agentId
      ? resolveAgentConfig(params.cfg, params.agentId)?.tools
      : undefined;
  return {
    planningMode: agentTools?.planning?.mode ?? globalTools?.planning?.mode ?? "enforced",
    persistSessionPlan:
      agentTools?.planning?.persistSessionPlan ?? globalTools?.planning?.persistSessionPlan ?? true,
    planningRequirement:
      agentTools?.planning?.requirement ?? globalTools?.planning?.requirement ?? "almost_always",
    editPreferenceMode:
      agentTools?.editPreference?.mode ?? globalTools?.editPreference?.mode ?? "enforced",
    preferredEditTool:
      agentTools?.editPreference?.preferredTool ??
      globalTools?.editPreference?.preferredTool ??
      "apply_patch",
  };
}

export function buildPlanPromptSection(plan?: SessionActivePlan): string[] {
  const lines = [
    "## Planning",
    `For non-trivial work, call \`${UPDATE_PLAN_TOOL_NAME}\` before using other substantive tools.`,
    `If no active plan exists, relevant tool calls may be blocked until you call \`${UPDATE_PLAN_TOOL_NAME}\`.`,
    `When a plan already exists, update it instead of silently diverging from it.`,
    "For file edits, prefer `apply_patch`; obvious shell-write or full-file rewrite bypasses may be blocked.",
    `Valid statuses: ${PLAN_STATUS_VALUES.join(", ")}.`,
  ];
  if (!plan || plan.steps.length === 0) {
    lines.push("Active plan: none.", "");
    return lines;
  }
  lines.push("Active plan:");
  if (plan.explanation) {
    lines.push(`Explanation: ${plan.explanation}`);
  }
  for (const step of plan.steps) {
    lines.push(`- [${step.status}] ${step.step}`);
  }
  lines.push("");
  return lines;
}

function isClearlyTrivialToolCall(params: { toolName: string; toolParams: unknown }): boolean {
  if (params.toolName === "ls") {
    return true;
  }
  if (params.toolName === "find") {
    return true;
  }
  if (params.toolName === "session_status") {
    return true;
  }
  return false;
}

export function shouldBlockForMissingPlan(params: {
  toolName: string;
  toolParams?: unknown;
  ctx?: GuardrailHookContext;
}): boolean {
  if (params.toolName === UPDATE_PLAN_TOOL_NAME) {
    return false;
  }
  const mode = params.ctx?.guardrails?.planningMode ?? "enforced";
  if (mode !== "enforced") {
    return false;
  }
  if (
    params.ctx?.guardrails?.planningRequirement === "almost_always" &&
    isClearlyTrivialToolCall({
      toolName: params.toolName,
      toolParams: params.toolParams,
    })
  ) {
    return false;
  }
  return !params.ctx?.activePlanRef?.value;
}

export function shouldEmitMissingPlanAdvisory(params: {
  toolName: string;
  toolParams?: unknown;
  ctx?: GuardrailHookContext;
}): boolean {
  if (params.toolName === UPDATE_PLAN_TOOL_NAME) {
    return false;
  }
  if ((params.ctx?.guardrails?.planningMode ?? "enforced") !== "advisory") {
    return false;
  }
  if (params.ctx?.activePlanRef?.value) {
    return false;
  }
  if (
    params.ctx?.guardrails?.planningRequirement === "almost_always" &&
    isClearlyTrivialToolCall({
      toolName: params.toolName,
      toolParams: params.toolParams,
    })
  ) {
    return false;
  }
  return true;
}

export function getNoPlanBlockMessage(): string {
  return NO_PLAN_BLOCK_MESSAGE;
}

function isGenericPlanStep(step: string): boolean {
  const normalized = step.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  if (normalized.length < 8) {
    return true;
  }
  return GENERIC_PLAN_STEP_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function validateActivePlanInput(params: {
  explanation?: string;
  plan: Array<{ step?: unknown; status?: unknown }>;
}): ValidatedActivePlanInput {
  const explanation = params.explanation?.trim() || undefined;
  const steps = params.plan
    .map((entry) => ({
      step: typeof entry.step === "string" ? entry.step.trim() : "",
      status: typeof entry.status === "string" ? entry.status.trim().toLowerCase() : "",
    }))
    .filter((entry) => entry.step);
  if (steps.length === 0) {
    throw new Error("update_plan requires at least one non-empty step.");
  }
  if (steps.length < 2) {
    throw new Error("update_plan requires at least two concrete steps.");
  }
  if (steps.length > 5) {
    throw new Error("update_plan should keep plans concise: use 2-5 steps.");
  }
  let inProgressCount = 0;
  const normalizedSteps = steps.map((entry) => {
    if (isGenericPlanStep(entry.step)) {
      throw new Error(
        `Plan step "${entry.step}" is too generic. Use a concrete action tied to the task.`,
      );
    }
    if (!PLAN_STATUS_VALUES.includes(entry.status as SessionActivePlanStatus)) {
      throw new Error(
        `Invalid plan status "${entry.status}". Use one of: ${PLAN_STATUS_VALUES.join(", ")}.`,
      );
    }
    if (entry.status === "in_progress") {
      inProgressCount += 1;
    }
    return {
      step: entry.step,
      status: entry.status as SessionActivePlanStatus,
    };
  });
  if (inProgressCount > 1) {
    throw new Error("Only one plan step may be in_progress at a time.");
  }
  return {
    explanation,
    steps: normalizedSteps,
  };
}

export function createActivePlan(params: ValidatedActivePlanInput): SessionActivePlan {
  return {
    ...(params.explanation ? { explanation: params.explanation } : {}),
    updatedAt: Date.now(),
    steps: params.steps,
  };
}

export function summarizePlan(plan: SessionActivePlan): string {
  const counts = {
    pending: 0,
    in_progress: 0,
    completed: 0,
  };
  for (const step of plan.steps) {
    counts[step.status] += 1;
  }
  const bits = [
    `${String(counts.in_progress)} in progress`,
    `${String(counts.pending)} pending`,
    `${String(counts.completed)} completed`,
  ];
  return `Plan updated: ${bits.join(", ")}.`;
}

export function shouldWarnAboutPlanCompletion(plan?: SessionActivePlan): boolean {
  if (!plan || plan.steps.length === 0) {
    return false;
  }
  const completedCount = plan.steps.filter((step) => step.status === "completed").length;
  return completedCount === 0;
}

export function getPlanCompletionAdvisoryMessage(): string {
  return "Plan advisory: this run ended with no completed plan steps. If the work moved forward, call update_plan and mark the current step accurately before finishing.";
}

function resolveParamPath(params: unknown): string | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const record = params as Record<string, unknown>;
  for (const key of ["path", "filePath", "file_path"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function resolveAbsolutePath(rawPath: string, workspaceDir?: string): string {
  return path.isAbsolute(rawPath)
    ? path.normalize(rawPath)
    : path.resolve(workspaceDir ?? process.cwd(), rawPath);
}

function isKnownEditException(params: {
  toolName: string;
  command?: string;
  filePath?: string;
}): boolean {
  if (params.command) {
    const command = params.command;
    return FORMATTER_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
  }
  if (params.filePath) {
    return /\.(png|jpe?g|gif|webp|pdf|zip|gz|mp3|mp4|mov|avi|ico|woff2?)$/i.test(params.filePath);
  }
  return false;
}

function isObviousExecWrite(command: string): boolean {
  return EXEC_WRITE_PATTERNS.some((pattern) => pattern.test(command));
}

export function evaluateEditGuardrail(params: {
  toolName: string;
  toolParams: unknown;
  ctx?: GuardrailHookContext;
}):
  | { action: "allow" }
  | { action: "advisory"; message: string }
  | { action: "block"; message: string }
  | { action: "exception"; message: string } {
  const mode = params.ctx?.guardrails?.editPreferenceMode ?? "enforced";
  if (mode === "off" || params.toolName === UPDATE_PLAN_TOOL_NAME) {
    return { action: "allow" };
  }
  const preferredTool = params.ctx?.guardrails?.preferredEditTool ?? "apply_patch";
  if (params.toolName === preferredTool) {
    return { action: "allow" };
  }

  if (params.toolName === "exec") {
    const commandValue =
      params.toolParams && typeof params.toolParams === "object"
        ? (params.toolParams as Record<string, unknown>).command
        : undefined;
    const command = typeof commandValue === "string" ? commandValue.trim() : "";
    if (!command || !isObviousExecWrite(command)) {
      return { action: "allow" };
    }
    if (isKnownEditException({ toolName: params.toolName, command })) {
      return {
        action: "exception",
        message: "Edit guardrail exception: formatter or generated-output command allowed.",
      };
    }
    return {
      action: mode === "advisory" ? "advisory" : "block",
      message: `Structured edits must use ${preferredTool}. This exec command looks like a file write; switch to ${preferredTool} unless this is a formatter or generated-output case.`,
    };
  }

  if (params.toolName === "write") {
    const filePathRaw = resolveParamPath(params.toolParams);
    if (!filePathRaw) {
      return { action: "allow" };
    }
    const absolutePath = resolveAbsolutePath(filePathRaw, params.ctx?.workspaceDir);
    if (isKnownEditException({ toolName: params.toolName, filePath: absolutePath })) {
      return {
        action: "exception",
        message: "Edit guardrail exception: asset or generated-output write allowed.",
      };
    }
    if (fs.existsSync(absolutePath)) {
      return {
        action: mode === "advisory" ? "advisory" : "block",
        message: `Overwriting an existing file should use ${preferredTool} instead of write unless a clear exception applies.`,
      };
    }
    return {
      action: "advisory",
      message: `New-file creation via write is allowed, but prefer ${preferredTool} add-file hunks when practical.`,
    };
  }

  if (params.toolName === "edit") {
    return {
      action: "advisory",
      message: `Prefer ${preferredTool} for multi-step file changes. The edit tool remains available for narrowly scoped edits.`,
    };
  }

  return { action: "allow" };
}
