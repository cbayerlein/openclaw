import { resolveSessionAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import type {
  MessagesConfig,
  OperationalAlertSeverity,
  OperationalAlertSource,
} from "../config/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import type { OutboundSendDeps } from "./outbound/deliver.js";
import { deliverOutboundPayloads } from "./outbound/deliver.js";
import { resolveAgentOutboundIdentity } from "./outbound/identity.js";
import { buildOutboundSessionContext } from "./outbound/session-context.js";
import {
  resolveHeartbeatDeliveryTarget,
  resolveOutboundTarget,
  resolveSessionDeliveryTarget,
} from "./outbound/targets.js";

type AlertRoute = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
};

export type OperationalAlert = {
  source: OperationalAlertSource;
  severity: OperationalAlertSeverity;
  text: string;
  fingerprint: string;
  ts?: number;
  toolName?: string;
  jobId?: string;
  agentId?: string;
  sessionKey?: string;
};

export type OperationalAlertResult =
  | { status: "disabled" | "filtered" | "no-route" }
  | { status: "deduped"; route: AlertRoute }
  | { status: "delivered"; route: AlertRoute }
  | { status: "fallback-delivered"; route: AlertRoute; fallbackRoute: AlertRoute }
  | { status: "route-failed"; route: AlertRoute; error: Error };

type OperationalAlertsRuntimeConfig = {
  enabled: boolean;
  sources: Set<OperationalAlertSource>;
  severities: Set<OperationalAlertSeverity>;
  fallback: "none" | "on-route-failure" | "always-user-chat";
  dedupeWindowMs: number;
};

type RouteOperationalAlertParams = {
  cfg: OpenClawConfig;
  alert: OperationalAlert;
  deps?: OutboundSendDeps;
};

const log = createSubsystemLogger("operational-alerts");
const DEDUPE_CACHE_KEY = Symbol.for("openclaw.operationalAlerts.dedupe");
const dedupeCache = resolveGlobalMap<string, number>(DEDUPE_CACHE_KEY);
const DEFAULT_DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const MAX_DEDUPE_ENTRIES = 500;

function resolveRuntimeConfig(messages?: MessagesConfig): OperationalAlertsRuntimeConfig {
  const configured = messages?.operationalAlerts;
  const enabled = configured?.enabled ?? Boolean(configured);
  return {
    enabled,
    sources: new Set(
      configured?.sources ?? [
        "tool",
        "agent",
        "provider",
        "heartbeat",
        "cron",
        "delivery",
        "channel",
        "guardrail",
      ],
    ),
    severities: new Set(configured?.severities ?? ["warn", "critical"]),
    fallback: configured?.fallback ?? "on-route-failure",
    dedupeWindowMs: Math.max(0, configured?.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS),
  };
}

function resolveOperatorRoute(cfg: OpenClawConfig): AlertRoute | undefined {
  const configured = cfg.messages?.operationalAlerts;
  const explicitTarget = configured?.target?.trim();
  const explicitTo = configured?.to?.trim();
  const explicitAccountId = configured?.accountId?.trim();

  if (explicitTarget && explicitTo) {
    const resolved = resolveOutboundTarget({
      channel: explicitTarget,
      to: explicitTo,
      cfg,
      accountId: explicitAccountId,
      mode: "explicit",
    });
    if (!resolved.ok) {
      return undefined;
    }
    return {
      channel: explicitTarget,
      to: resolved.to,
      ...(explicitAccountId ? { accountId: explicitAccountId } : {}),
    };
  }

  const heartbeatFallback = resolveHeartbeatDeliveryTarget({ cfg });
  if (heartbeatFallback.channel === "none" || !heartbeatFallback.to) {
    return undefined;
  }
  return {
    channel: heartbeatFallback.channel,
    to: heartbeatFallback.to,
    ...(heartbeatFallback.accountId ? { accountId: heartbeatFallback.accountId } : {}),
  };
}

function resolveUserFallbackRoute(
  cfg: OpenClawConfig,
  sessionKey?: string,
): AlertRoute | undefined {
  const normalizedSessionKey = sessionKey?.trim();
  if (!normalizedSessionKey) {
    return undefined;
  }
  const agentId = resolveSessionAgentId({ sessionKey: normalizedSessionKey, config: cfg });
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  const entry = store[normalizedSessionKey];
  const target = resolveSessionDeliveryTarget({ entry });
  if (!target.channel || !target.to) {
    return undefined;
  }
  const resolved = resolveOutboundTarget({
    channel: target.channel,
    to: target.to,
    cfg,
    accountId: target.accountId,
    mode: "explicit",
  });
  if (!resolved.ok) {
    return undefined;
  }
  return {
    channel: target.channel,
    to: resolved.to,
    ...(target.accountId ? { accountId: target.accountId } : {}),
    ...(target.threadId != null ? { threadId: target.threadId } : {}),
  };
}

function pruneDedupeCache(now: number, windowMs: number): void {
  for (const [key, ts] of dedupeCache.entries()) {
    if (now - ts > windowMs) {
      dedupeCache.delete(key);
    }
  }
  while (dedupeCache.size > MAX_DEDUPE_ENTRIES) {
    const first = dedupeCache.keys().next().value;
    if (!first) {
      break;
    }
    dedupeCache.delete(first);
  }
}

function isDeduped(params: {
  fingerprint: string;
  route: AlertRoute;
  now: number;
  windowMs: number;
}): boolean {
  pruneDedupeCache(params.now, params.windowMs);
  const key = [
    params.route.channel,
    params.route.to,
    params.route.accountId ?? "",
    params.fingerprint,
  ].join("|");
  const lastSentAt = dedupeCache.get(key);
  if (typeof lastSentAt === "number" && params.now - lastSentAt <= params.windowMs) {
    return true;
  }
  dedupeCache.set(key, params.now);
  return false;
}

async function deliverAlertText(params: {
  cfg: OpenClawConfig;
  route: AlertRoute;
  text: string;
  agentId?: string;
  sessionKey?: string;
  deps?: OutboundSendDeps;
}) {
  await deliverOutboundPayloads({
    cfg: params.cfg,
    channel: params.route.channel,
    to: params.route.to,
    accountId: params.route.accountId,
    threadId: params.route.threadId,
    payloads: [{ text: params.text }],
    session: buildOutboundSessionContext({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
    }),
    identity: params.agentId ? resolveAgentOutboundIdentity(params.cfg, params.agentId) : undefined,
    deps: params.deps,
  });
}

export async function routeOperationalAlert(
  params: RouteOperationalAlertParams,
): Promise<OperationalAlertResult> {
  const runtime = resolveRuntimeConfig(params.cfg.messages);
  if (!runtime.enabled) {
    return { status: "disabled" };
  }
  if (!runtime.sources.has(params.alert.source) || !runtime.severities.has(params.alert.severity)) {
    return { status: "filtered" };
  }

  const route = resolveOperatorRoute(params.cfg);
  if (!route) {
    return { status: "no-route" };
  }

  const now = params.alert.ts ?? Date.now();
  if (
    isDeduped({
      fingerprint: params.alert.fingerprint,
      route,
      now,
      windowMs: runtime.dedupeWindowMs,
    })
  ) {
    log.info("operational alert deduped", {
      source: params.alert.source,
      severity: params.alert.severity,
      routeChannel: route.channel,
      fingerprint: params.alert.fingerprint,
      sessionKey: params.alert.sessionKey,
      agentId: params.alert.agentId,
    });
    return { status: "deduped", route };
  }

  try {
    await deliverAlertText({
      cfg: params.cfg,
      route,
      text: params.alert.text,
      agentId: params.alert.agentId,
      sessionKey: undefined,
      deps: params.deps,
    });
    log.info("operational alert delivered", {
      source: params.alert.source,
      severity: params.alert.severity,
      routeChannel: route.channel,
      fingerprint: params.alert.fingerprint,
      sessionKey: params.alert.sessionKey,
      agentId: params.alert.agentId,
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const fallbackRoute =
      runtime.fallback === "none"
        ? undefined
        : resolveUserFallbackRoute(params.cfg, params.alert.sessionKey);
    if (fallbackRoute && runtime.fallback !== "none") {
      try {
        await deliverAlertText({
          cfg: params.cfg,
          route: fallbackRoute,
          text: params.alert.text,
          agentId: params.alert.agentId,
          sessionKey: params.alert.sessionKey,
          deps: params.deps,
        });
        log.warn("operational alert route failed; delivered via user-chat fallback", {
          source: params.alert.source,
          routeChannel: route.channel,
          fallbackChannel: fallbackRoute.channel,
          error: error.message,
        });
        return { status: "fallback-delivered", route, fallbackRoute };
      } catch (fallbackErr) {
        log.warn("operational alert route and fallback delivery failed", {
          source: params.alert.source,
          routeChannel: route.channel,
          fallbackChannel: fallbackRoute.channel,
          error: error.message,
          fallbackError: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
        });
      }
    } else {
      log.warn("operational alert route failed", {
        source: params.alert.source,
        routeChannel: route.channel,
        error: error.message,
      });
    }
    return { status: "route-failed", route, error };
  }

  if (runtime.fallback === "always-user-chat") {
    const fallbackRoute = resolveUserFallbackRoute(params.cfg, params.alert.sessionKey);
    if (fallbackRoute) {
      try {
        await deliverAlertText({
          cfg: params.cfg,
          route: fallbackRoute,
          text: params.alert.text,
          agentId: params.alert.agentId,
          sessionKey: params.alert.sessionKey,
          deps: params.deps,
        });
        log.info("operational alert mirrored to user chat", {
          source: params.alert.source,
          routeChannel: route.channel,
          fallbackChannel: fallbackRoute.channel,
          fingerprint: params.alert.fingerprint,
          sessionKey: params.alert.sessionKey,
          agentId: params.alert.agentId,
        });
        return { status: "fallback-delivered", route, fallbackRoute };
      } catch (fallbackErr) {
        log.warn("operational alert mirror to user chat failed", {
          source: params.alert.source,
          routeChannel: route.channel,
          fallbackChannel: fallbackRoute.channel,
          error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
        });
      }
    }
  }

  return { status: "delivered", route };
}

export function resetOperationalAlertDeduperForTest(): void {
  dedupeCache.clear();
}
