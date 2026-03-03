import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import { writeJsonFileAtomically } from "openclaw/plugin-sdk";
import { ToolInputError } from "../../../src/agents/tools/common.js";

type PlanStatus = "pending" | "in_progress" | "completed";

type PlanStep = {
  step: string;
  status: PlanStatus;
};

type UpdatePlanPayload = {
  explanation?: string;
  plan: PlanStep[];
};

type NormalizePlanStatusResult = { ok: true; status: PlanStatus } | { ok: false; raw: string };

type PersistedPlan = {
  updatedAt: string;
  explanation?: string;
  plan: PlanStep[];
  agentId?: string;
  sessionKey?: string;
  messageChannel?: string;
};

const STATUS_VALUES: readonly PlanStatus[] = ["pending", "in_progress", "completed"];

const UPDATE_PLAN_PARAMETERS = Type.Object(
  {
    explanation: Type.Optional(Type.String()),
    plan: Type.Array(
      Type.Object(
        {
          step: Type.String({ minLength: 1 }),
          status: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const PLAN_STATUS_ALIASES: Readonly<Record<string, PlanStatus>> = {
  // pending
  pending: "pending",
  "not started": "pending",
  not_started: "pending",
  "not-started": "pending",
  todo: "pending",
  "to do": "pending",
  to_do: "pending",
  planned: "pending",
  plan: "pending",
  queued: "pending",
  next: "pending",

  // in_progress
  in_progress: "in_progress",
  "in progress": "in_progress",
  "in-progress": "in_progress",
  inprogress: "in_progress",
  doing: "in_progress",
  active: "in_progress",
  working: "in_progress",
  running: "in_progress",
  wip: "in_progress",
  ongoing: "in_progress",

  // completed
  completed: "completed",
  done: "completed",
  finished: "completed",
  complete: "completed",
  success: "completed",
  resolved: "completed",
  closed: "completed",
};

function sanitizePathSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_");
  const compact = normalized.replace(/^_+|_+$/g, "");
  return compact || "default";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPlanStatus(value: unknown): value is PlanStatus {
  return typeof value === "string" && STATUS_VALUES.includes(value as PlanStatus);
}

function canonicalizeStatusKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function normalizePlanStatus(value: unknown): NormalizePlanStatusResult {
  if (isPlanStatus(value)) {
    return { ok: true, status: value };
  }

  if (typeof value !== "string") {
    return { ok: false, raw: String(value) };
  }

  const raw = value.trim();
  const direct = PLAN_STATUS_ALIASES[raw.toLowerCase()];
  if (direct) {
    return { ok: true, status: direct };
  }

  const canonical = PLAN_STATUS_ALIASES[canonicalizeStatusKey(raw)];
  if (canonical) {
    return { ok: true, status: canonical };
  }

  return { ok: false, raw };
}

function normalizePayload(raw: Record<string, unknown>): UpdatePlanPayload {
  const explanation =
    typeof raw.explanation === "string" && raw.explanation.trim().length > 0
      ? raw.explanation.trim()
      : undefined;

  if (!Array.isArray(raw.plan)) {
    throw new ToolInputError("plan must be an array");
  }

  const invalidStatuses: Array<{ index: number; raw: string }> = [];

  const plan = raw.plan.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new ToolInputError(`plan[${index}] must be an object`);
    }
    const step = typeof entry.step === "string" ? entry.step.trim() : "";
    if (!step) {
      throw new ToolInputError(`plan[${index}].step must be a non-empty string`);
    }
    const normalizedStatus = normalizePlanStatus(entry.status);
    if (!normalizedStatus.ok) {
      invalidStatuses.push({ index, raw: normalizedStatus.raw });
      return { step, status: "pending" as PlanStatus };
    }
    return { step, status: normalizedStatus.status };
  });

  if (invalidStatuses.length > 0) {
    const seen = invalidStatuses.map((entry) => `plan[${entry.index}]='${entry.raw}'`).join(", ");
    throw new ToolInputError(
      `Invalid update_plan status value(s): ${seen}. Expected one of: ${STATUS_VALUES.join(", ")}. Auto-normalization was attempted once for common variants (e.g. IN_PROGRESS, not_started, done).`,
    );
  }

  const inProgressCount = plan.filter((step) => step.status === "in_progress").length;
  if (inProgressCount > 1) {
    throw new ToolInputError("at most one plan step may have status in_progress");
  }

  return { explanation, plan };
}

function summarizePlan(payload: UpdatePlanPayload): {
  text: string;
  counts: Record<PlanStatus, number>;
} {
  const counts: Record<PlanStatus, number> = {
    pending: 0,
    in_progress: 0,
    completed: 0,
  };
  for (const step of payload.plan) {
    counts[step.status] += 1;
  }

  const lines = [
    `Plan updated: ${payload.plan.length} step(s) (pending ${counts.pending}, in_progress ${counts.in_progress}, completed ${counts.completed}).`,
  ];
  if (payload.explanation) {
    lines.push(`Explanation: ${payload.explanation}`);
  }
  for (const step of payload.plan) {
    lines.push(`- [${step.status}] ${step.step}`);
  }

  return { text: lines.join("\n"), counts };
}

function resolveStorageDir(api: OpenClawPluginApi, ctx: OpenClawPluginToolContext): string {
  const stateDir = api.runtime.state.resolveStateDir();
  const fallbackBase = ctx.agentDir ?? ctx.workspaceDir ?? process.cwd();
  const baseDir = typeof stateDir === "string" && stateDir.trim() ? stateDir : fallbackBase;
  return path.join(baseDir, "plugins", "update-plan");
}

async function persistPlan(
  api: OpenClawPluginApi,
  ctx: OpenClawPluginToolContext,
  payload: UpdatePlanPayload,
): Promise<{ lastPlanPath: string; sessionPath?: string }> {
  const storageDir = resolveStorageDir(api, ctx);
  const lastPlanPath = path.join(storageDir, "last-plan.json");
  const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey.trim() : "";
  const sessionPath =
    sessionKey.length > 0
      ? path.join(storageDir, "sessions", `${sanitizePathSegment(sessionKey)}.json`)
      : undefined;

  const persisted: PersistedPlan = {
    updatedAt: new Date().toISOString(),
    ...(payload.explanation ? { explanation: payload.explanation } : {}),
    plan: payload.plan,
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(ctx.messageChannel ? { messageChannel: ctx.messageChannel } : {}),
  };

  await writeJsonFileAtomically(lastPlanPath, persisted);
  if (sessionPath) {
    await writeJsonFileAtomically(sessionPath, persisted);
  }

  return { lastPlanPath, sessionPath };
}

export function createUpdatePlanTool(api: OpenClawPluginApi, ctx: OpenClawPluginToolContext) {
  return {
    name: "update_plan",
    description: "Update a concise multi-step execution plan and persist the latest plan locally.",
    parameters: UPDATE_PLAN_PARAMETERS,
    async execute(_id: string, params: Record<string, unknown>) {
      const payload = normalizePayload(params);
      const persisted = await persistPlan(api, ctx, payload);
      const summary = summarizePlan(payload);

      return {
        content: [{ type: "text", text: summary.text }],
        details: {
          explanation: payload.explanation,
          plan: payload.plan,
          counts: summary.counts,
          persisted,
        },
      };
    },
  };
}
