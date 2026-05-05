import { type Static, Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

const RunStatusSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("done"),
  Type.Literal("failed"),
  Type.Literal("aborted"),
  Type.Literal("unknown"),
]);

const RunEventKindSchema = Type.Union([
  Type.Literal("run_started"),
  Type.Literal("run_finished"),
  Type.Literal("run_failed"),
  Type.Literal("run_state"),
  Type.Literal("tool_started"),
  Type.Literal("tool_updated"),
  Type.Literal("tool_finished"),
  Type.Literal("tool_failed"),
  Type.Literal("guardrail"),
  Type.Literal("error"),
  Type.Literal("warning"),
]);

export const RunsListParamsSchema = Type.Object(
  {
    sessionKey: Type.Optional(NonEmptyString),
    agentId: Type.Optional(NonEmptyString),
    status: Type.Optional(RunStatusSchema),
    sinceTs: Type.Optional(Type.Integer({ minimum: 0 })),
    untilTs: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    cursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const RunsGetParamsSchema = Type.Object(
  {
    runId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const RunsEventsParamsSchema = Type.Object(
  {
    runId: NonEmptyString,
    stream: Type.Optional(NonEmptyString),
    kind: Type.Optional(RunEventKindSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    cursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const RunSummarySchema = Type.Object(
  {
    runId: NonEmptyString,
    sessionKey: Type.Optional(NonEmptyString),
    agentId: Type.Optional(NonEmptyString),
    status: RunStatusSchema,
    startedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    endedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    updatedAt: Type.Integer({ minimum: 0 }),
    provider: Type.Optional(NonEmptyString),
    model: Type.Optional(NonEmptyString),
    eventCount: Type.Integer({ minimum: 0 }),
    toolCount: Type.Integer({ minimum: 0 }),
    lastEventKind: Type.Optional(RunEventKindSchema),
  },
  { additionalProperties: false },
);

export const RunEventSchema = Type.Object(
  {
    idx: Type.Integer({ minimum: 1 }),
    runId: NonEmptyString,
    ts: Type.Integer({ minimum: 0 }),
    stream: NonEmptyString,
    kind: RunEventKindSchema,
    sessionKey: Type.Optional(NonEmptyString),
    agentId: Type.Optional(NonEmptyString),
    data: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);

export const RunsListResultSchema = Type.Object(
  {
    items: Type.Array(RunSummarySchema),
    hasMore: Type.Boolean(),
    nextCursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const RunsEventsResultSchema = Type.Object(
  {
    items: Type.Array(RunEventSchema),
    hasMore: Type.Boolean(),
    nextCursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type RunsListParams = Static<typeof RunsListParamsSchema>;
export type RunsGetParams = Static<typeof RunsGetParamsSchema>;
export type RunsEventsParams = Static<typeof RunsEventsParamsSchema>;
export type RunSummary = Static<typeof RunSummarySchema>;
export type RunEvent = Static<typeof RunEventSchema>;
export type RunsListResult = Static<typeof RunsListResultSchema>;
export type RunsEventsResult = Static<typeof RunsEventsResultSchema>;
