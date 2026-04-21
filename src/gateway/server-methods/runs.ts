import {
  getRunObservabilitySummary,
  listRunObservabilityEvents,
  listRunObservabilitySummaries,
} from "../../infra/run-observability.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateRunsEventsParams,
  validateRunsGetParams,
  validateRunsListParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const runsHandlers: GatewayRequestHandlers = {
  "runs.list": async ({ params, respond }) => {
    if (!validateRunsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid runs.list params: ${formatValidationErrors(validateRunsListParams.errors)}`,
        ),
      );
      return;
    }
    const payload = await listRunObservabilitySummaries(
      params as Parameters<typeof listRunObservabilitySummaries>[0],
    );
    respond(true, payload, undefined);
  },
  "runs.get": async ({ params, respond }) => {
    if (!validateRunsGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid runs.get params: ${formatValidationErrors(validateRunsGetParams.errors)}`,
        ),
      );
      return;
    }
    const { runId } = params as { runId: string };
    const payload = await getRunObservabilitySummary(runId);
    if (!payload) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `run not found: ${runId}`));
      return;
    }
    respond(true, payload, undefined);
  },
  "runs.events": async ({ params, respond }) => {
    if (!validateRunsEventsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid runs.events params: ${formatValidationErrors(validateRunsEventsParams.errors)}`,
        ),
      );
      return;
    }
    const typed = params as Parameters<typeof listRunObservabilityEvents>[0];
    const summary = await getRunObservabilitySummary(typed.runId);
    if (!summary) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `run not found: ${typed.runId}`),
      );
      return;
    }
    const payload = await listRunObservabilityEvents(typed);
    respond(true, payload, undefined);
  },
};
