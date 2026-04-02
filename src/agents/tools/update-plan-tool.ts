import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import { normalizeStoreSessionKey, updateSessionStore } from "../../config/sessions/store.js";
import type { SessionActivePlan } from "../../config/sessions/types.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import {
  createActivePlan,
  type ActivePlanRef,
  summarizePlan,
  UPDATE_PLAN_TOOL_NAME,
  validateActivePlanInput,
} from "../guardrails.js";
import { stringEnum } from "../schema/typebox.js";
import {
  describeUpdatePlanTool,
  UPDATE_PLAN_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import {
  type AnyAgentTool,
  ToolInputError,
  readStringParam,
  textResult,
} from "./common.js";

const PLAN_STEP_STATUSES = ["pending", "in_progress", "completed"] as const;

const updatePlanSchema = Type.Object({
  explanation: Type.Optional(
    Type.String({
      description: "Optional concise explanation for this plan update.",
    }),
  ),
  plan: Type.Array(
    Type.Object(
      {
        step: Type.String({
          description: "Human-readable plan step.",
        }),
        status: stringEnum(PLAN_STEP_STATUSES, {
          description: 'One of "pending", "in_progress", or "completed".',
        }),
      },
      { additionalProperties: true },
    ),
    {
      description: "Ordered plan steps with stable statuses.",
      minItems: 1,
    },
  ),
});

type UpdatePlanStep = {
  step: string;
  status: (typeof PLAN_STEP_STATUSES)[number];
};

type UpdatePlanToolParams = {
  sessionKey?: string;
  sessionId?: string;
  storePath?: string;
  runId?: string;
  activePlanRef?: ActivePlanRef;
  persistSessionPlan?: boolean;
};

function readPlanSteps(params: Record<string, unknown>): UpdatePlanStep[] {
  const rawPlan = params.plan;
  if (!Array.isArray(rawPlan) || rawPlan.length === 0) {
    throw new ToolInputError("plan required");
  }

  const steps = rawPlan.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new ToolInputError(`plan[${index}] must be an object`);
    }
    const stepParams = entry as Record<string, unknown>;
    const step = readStringParam(stepParams, "step", {
      required: true,
      label: `plan[${index}].step`,
    });
    const status = readStringParam(stepParams, "status", {
      required: true,
      label: `plan[${index}].status`,
    });
    if (!PLAN_STEP_STATUSES.includes(status as (typeof PLAN_STEP_STATUSES)[number])) {
      throw new ToolInputError(
        `plan[${index}].status must be one of ${PLAN_STEP_STATUSES.join(", ")}`,
      );
    }
    return {
      step,
      status: status as (typeof PLAN_STEP_STATUSES)[number],
    };
  });

  const inProgressCount = steps.filter((entry) => entry.status === "in_progress").length;
  if (inProgressCount > 1) {
    throw new ToolInputError("plan can contain at most one in_progress step");
  }
  return steps;
}

function buildEphemeralResult(args: Record<string, unknown>): AgentToolResult<{
  status: "updated";
  explanation?: string;
  plan: UpdatePlanStep[];
}> {
  const explanation = readStringParam(args, "explanation");
  const plan = readPlanSteps(args);
  return {
    content: [],
    details: {
      status: "updated" as const,
      ...(explanation ? { explanation } : {}),
      plan,
    },
  };
}

function buildPersistentTool(
  params: Required<Pick<UpdatePlanToolParams, "sessionKey" | "storePath">> &
    Omit<UpdatePlanToolParams, "sessionKey" | "storePath">,
): AgentTool<typeof updatePlanSchema, { activePlan: SessionActivePlan }> {
  const normalizedSessionKey = normalizeStoreSessionKey(params.sessionKey);

  return {
    name: UPDATE_PLAN_TOOL_NAME,
    label: UPDATE_PLAN_TOOL_NAME,
    displaySummary: UPDATE_PLAN_TOOL_DISPLAY_SUMMARY,
    description: describeUpdatePlanTool(),
    parameters: updatePlanSchema,
    execute: async (_toolCallId, args) => {
      const hadExistingPlan = Boolean(params.activePlanRef?.value);
      const sessionId = params.sessionId?.trim() || undefined;
      const record = (args ?? {}) as {
        explanation?: string;
        plan?: Array<{ step?: unknown; status?: unknown }>;
      };
      const validated = validateActivePlanInput({
        explanation: record.explanation,
        plan: Array.isArray(record.plan) ? record.plan : [],
      });
      const activePlan = createActivePlan(validated);

      if (params.activePlanRef) {
        params.activePlanRef.value = activePlan;
      }
      if (params.persistSessionPlan !== false) {
        await updateSessionStore(params.storePath, (store) => {
          let targetKey = normalizedSessionKey;
          let existing = store[targetKey];
          if (!existing && sessionId) {
            const matchingEntry = Object.entries(store).find(
              ([, candidate]) => candidate?.sessionId === sessionId,
            );
            if (matchingEntry) {
              [targetKey, existing] = matchingEntry;
            }
          }
          store[targetKey] = {
            ...(existing ?? {
              sessionId: sessionId ?? normalizedSessionKey,
              updatedAt: Date.now(),
            }),
            activePlan,
            updatedAt: Date.now(),
          };
        });
      }

      const summary = summarizePlan(activePlan);
      emitAgentEvent({
        runId: params.runId ?? params.sessionKey,
        sessionKey: normalizedSessionKey,
        stream: "guardrail",
        data: {
          event: hadExistingPlan ? "plan_updated" : "plan_created",
          activePlan,
        },
      });
      enqueueSystemEvent(summary, { sessionKey: normalizedSessionKey });
      return textResult(summary, { activePlan });
    },
  };
}

export function createUpdatePlanTool(): AnyAgentTool;
export function createUpdatePlanTool(
  params: UpdatePlanToolParams,
): AgentTool<typeof updatePlanSchema, { activePlan: SessionActivePlan }> | AnyAgentTool | null;
export function createUpdatePlanTool(params?: UpdatePlanToolParams) {
  const sessionKey = params?.sessionKey?.trim();
  const storePath = params?.storePath?.trim();
  if (sessionKey && storePath) {
    return buildPersistentTool({
      ...params,
      sessionKey,
      storePath,
    });
  }

  return {
    label: "Update Plan",
    name: UPDATE_PLAN_TOOL_NAME,
    displaySummary: UPDATE_PLAN_TOOL_DISPLAY_SUMMARY,
    description: describeUpdatePlanTool(),
    parameters: updatePlanSchema,
    execute: async (_toolCallId, args) => buildEphemeralResult((args ?? {}) as Record<string, unknown>),
  } satisfies AnyAgentTool;
}
