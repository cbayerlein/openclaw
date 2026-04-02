import type { OpenClawConfig } from "../config/config.js";
import type {
  OperationalAlertKindPolicy,
  OperationalAlertSeverity,
  OperationalAlertSource,
  RuntimeWarningKind,
} from "../config/types.js";
import { routeOperationalAlert, type OperationalAlertResult } from "./operational-alerts.js";
import type { OutboundSendDeps } from "./outbound/deliver.js";

export type RuntimeWarning = {
  kind: RuntimeWarningKind;
  source: OperationalAlertSource;
  severity: OperationalAlertSeverity;
  text: string;
  fingerprint: string;
  ts?: number;
  sessionKey?: string;
  agentId?: string;
  toolName?: string;
  channel?: string;
  jobId?: string;
};

type ResolvedRuntimeWarningPolicy = {
  enabled: boolean;
  warningsRoute: boolean;
  userChat: "default" | "always" | "never";
  severities?: Set<OperationalAlertSeverity>;
};

export type RouteRuntimeWarningResult = {
  policy: ResolvedRuntimeWarningPolicy;
  routeResult?: OperationalAlertResult;
  suppressUserChat: boolean;
};

const DEFAULT_KIND_POLICIES: Record<RuntimeWarningKind, ResolvedRuntimeWarningPolicy> = {
  tool_failure: { enabled: true, warningsRoute: true, userChat: "never" },
  tool_exec_failure: { enabled: true, warningsRoute: true, userChat: "never" },
  tool_recoverable_warning: { enabled: true, warningsRoute: true, userChat: "never" },
  session_delivery_failure: { enabled: true, warningsRoute: true, userChat: "never" },
  provider_failure: { enabled: true, warningsRoute: true, userChat: "never" },
  agent_run_failure: { enabled: true, warningsRoute: true, userChat: "never" },
  heartbeat_failure: { enabled: true, warningsRoute: true, userChat: "never" },
  cron_failure: { enabled: true, warningsRoute: true, userChat: "never" },
  cron_runtime_failure: { enabled: true, warningsRoute: true, userChat: "never" },
  reply_delivery_failure: { enabled: true, warningsRoute: true, userChat: "never" },
  channel_warning: { enabled: true, warningsRoute: true, userChat: "never" },
  guardrail_warning: { enabled: true, warningsRoute: true, userChat: "never" },
};

function applyKindOverride(
  base: ResolvedRuntimeWarningPolicy,
  override?: OperationalAlertKindPolicy,
): ResolvedRuntimeWarningPolicy {
  if (!override) {
    return base;
  }
  return {
    enabled: override.enabled ?? base.enabled,
    warningsRoute: override.warningsRoute ?? base.warningsRoute,
    userChat: override.userChat ?? base.userChat,
    severities: override.severities?.length ? new Set(override.severities) : base.severities,
  };
}

function applyLegacyCompatibility(
  cfg: OpenClawConfig,
  warning: RuntimeWarning,
  policy: ResolvedRuntimeWarningPolicy,
): ResolvedRuntimeWarningPolicy {
  const suppressToolErrors = cfg.messages?.suppressToolErrors === true;
  if (
    suppressToolErrors &&
    (warning.kind === "tool_failure" ||
      warning.kind === "tool_exec_failure" ||
      warning.kind === "tool_recoverable_warning" ||
      warning.kind === "session_delivery_failure")
  ) {
    return { ...policy, userChat: "never" };
  }
  return policy;
}

export function resolveRuntimeWarningPolicy(
  cfg: OpenClawConfig,
  warning: RuntimeWarning,
): ResolvedRuntimeWarningPolicy {
  const configured = cfg.messages?.operationalAlerts;
  const base = DEFAULT_KIND_POLICIES[warning.kind];
  const kindFiltered =
    Array.isArray(configured?.kinds) && configured.kinds.length > 0
      ? configured.kinds.includes(warning.kind)
      : true;
  const withKinds = kindFiltered ? base : { ...base, enabled: false, warningsRoute: false };
  const overridden = applyKindOverride(withKinds, configured?.kindPolicies?.[warning.kind]);
  return applyLegacyCompatibility(cfg, warning, overridden);
}

function isSuccessfulWarningRoute(result?: OperationalAlertResult): boolean {
  return result?.status === "delivered" || result?.status === "fallback-delivered";
}

export async function routeRuntimeWarning(params: {
  cfg: OpenClawConfig;
  warning: RuntimeWarning;
  deps?: OutboundSendDeps;
}): Promise<RouteRuntimeWarningResult> {
  const policy = resolveRuntimeWarningPolicy(params.cfg, params.warning);
  if (!policy.enabled) {
    return { policy, suppressUserChat: false };
  }

  if (policy.severities && !policy.severities.has(params.warning.severity)) {
    return { policy, suppressUserChat: false };
  }

  let routeResult: OperationalAlertResult | undefined;
  if (policy.warningsRoute) {
    routeResult = await routeOperationalAlert({
      cfg: params.cfg,
      deps: params.deps,
      alert: {
        source: params.warning.source,
        severity: params.warning.severity,
        text: params.warning.text,
        fingerprint: params.warning.fingerprint,
        ts: params.warning.ts,
        toolName: params.warning.toolName,
        jobId: params.warning.jobId,
        agentId: params.warning.agentId,
        sessionKey: params.warning.sessionKey,
      },
    });
  }

  const suppressUserChat = policy.userChat === "never" && isSuccessfulWarningRoute(routeResult);

  return { policy, routeResult, suppressUserChat };
}
