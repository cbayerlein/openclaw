import type { EmbeddedPiWarningEvent } from "../../agents/pi-embedded-runner/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { defaultRuntime } from "../../runtime.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";

// Warning events are routed separately from normal assistant reply payloads.
// This keeps tool failures out of the user DM flow while still allowing
// controlled fallback behavior.
const DEFAULT_WARNING_DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const warningFingerprintSeenAt = new Map<string, number>();

export function __resetWarningRoutingForTests() {
  warningFingerprintSeenAt.clear();
}
const WARNING_FINGERPRINT_CACHE_LIMIT = 1024;

type WarningRoute = {
  channel: OriginatingChannelType;
  to: string;
};

type WarningRoutingPolicy = {
  enabled: boolean;
  route: WarningRoute | null;
  execOnly: boolean;
  fallbackToUserChat: boolean;
  dedupeWindowMs: number;
  suppressToolErrors: boolean;
};

function pruneWarningFingerprintCache(now: number) {
  if (warningFingerprintSeenAt.size <= WARNING_FINGERPRINT_CACHE_LIMIT) {
    return;
  }
  const sorted = Array.from(warningFingerprintSeenAt.entries()).toSorted((a, b) => a[1] - b[1]);
  const excess = warningFingerprintSeenAt.size - WARNING_FINGERPRINT_CACHE_LIMIT;
  for (let i = 0; i < excess; i += 1) {
    const key = sorted[i]?.[0];
    if (key) {
      warningFingerprintSeenAt.delete(key);
    }
  }
  if (warningFingerprintSeenAt.size > WARNING_FINGERPRINT_CACHE_LIMIT) {
    for (const [key, ts] of warningFingerprintSeenAt.entries()) {
      if (now - ts > DEFAULT_WARNING_DEDUPE_WINDOW_MS * 6) {
        warningFingerprintSeenAt.delete(key);
      }
      if (warningFingerprintSeenAt.size <= WARNING_FINGERPRINT_CACHE_LIMIT) {
        break;
      }
    }
  }
}

function shouldEmitByFingerprintRateLimit(fingerprint: string, windowMs: number): boolean {
  const now = Date.now();
  const lastSeen = warningFingerprintSeenAt.get(fingerprint);
  if (typeof lastSeen === "number" && now - lastSeen < windowMs) {
    return false;
  }
  warningFingerprintSeenAt.set(fingerprint, now);
  pruneWarningFingerprintCache(now);
  return true;
}

function resolveWarningRoute(cfg: OpenClawConfig): WarningRoute | null {
  const targetRaw = cfg.messages?.toolWarnings?.target ?? cfg.agents?.defaults?.heartbeat?.target;
  const toRaw = cfg.messages?.toolWarnings?.to ?? cfg.agents?.defaults?.heartbeat?.to;
  if (typeof targetRaw !== "string" || typeof toRaw !== "string") {
    return null;
  }
  const channel = targetRaw.trim().toLowerCase() as OriginatingChannelType;
  const to = toRaw.trim();
  if (!isRoutableChannel(channel) || !to) {
    return null;
  }
  return { channel, to };
}

/**
 * Parse a boolean-ish env var used for operational feature flags.
 *
 * Accepted truthy values: 1,true,yes,on
 * Accepted falsy values: 0,false,no,off
 * Any other value is treated as "unset" to avoid accidental enable/disable.
 */
function parseOptionalBoolEnv(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return undefined;
  }
  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }
  return undefined;
}

function resolveWarningPolicy(cfg: OpenClawConfig): WarningRoutingPolicy {
  const dedupeWindowMs = Math.max(
    1_000,
    cfg.messages?.toolWarnings?.dedupeWindowMs ?? DEFAULT_WARNING_DEDUPE_WINDOW_MS,
  );
  // Env override allows safe rollout/rollback without editing openclaw.json.
  // Precedence: OPENCLAW_TOOL_WARNINGS_ENABLED -> messages.toolWarnings.enabled -> false.
  const envEnabled = parseOptionalBoolEnv("OPENCLAW_TOOL_WARNINGS_ENABLED");
  return {
    enabled: envEnabled ?? cfg.messages?.toolWarnings?.enabled ?? false,
    route: resolveWarningRoute(cfg),
    execOnly: cfg.messages?.toolWarnings?.execOnly ?? true,
    fallbackToUserChat: cfg.messages?.toolWarnings?.fallbackToUserChat ?? true,
    dedupeWindowMs,
    suppressToolErrors: Boolean(cfg.messages?.suppressToolErrors),
  };
}

function isExecLikeWarning(warning: EmbeddedPiWarningEvent): boolean {
  const normalized = warning.toolName.trim().toLowerCase();
  return normalized === "exec" || normalized === "bash";
}

function shouldRouteWarningToWarningsChannel(
  warning: EmbeddedPiWarningEvent,
  policy: WarningRoutingPolicy,
): boolean {
  if (!policy.route) {
    return false;
  }
  if (!policy.execOnly) {
    return true;
  }
  return isExecLikeWarning(warning);
}

function shouldRouteWarningToUserChat(params: {
  policy: WarningRoutingPolicy;
  warning: EmbeddedPiWarningEvent;
  warningRouteAttempted: boolean;
  warningRouteSucceeded: boolean;
}): boolean {
  const { policy, warning, warningRouteAttempted, warningRouteSucceeded } = params;
  if (policy.suppressToolErrors) {
    return false;
  }
  const routeToWarnings = shouldRouteWarningToWarningsChannel(warning, policy);
  if (!routeToWarnings) {
    return true;
  }
  if (!warningRouteAttempted) {
    return policy.fallbackToUserChat;
  }
  if (warningRouteSucceeded) {
    return false;
  }
  return policy.fallbackToUserChat;
}

export async function processWarningEvents(params: {
  warnings: EmbeddedPiWarningEvent[];
  cfg: OpenClawConfig;
  sessionKey?: string;
}): Promise<ReplyPayload[]> {
  const policy = resolveWarningPolicy(params.cfg);
  const userPayloads: ReplyPayload[] = [];
  const seenWarnings = new Set<string>();

  if (!policy.enabled) {
    // Legacy behavior path: do not route externally, optionally emit to user chat
    // unless suppressToolErrors blocks it.
    if (policy.suppressToolErrors) {
      return [];
    }
    for (const warning of params.warnings) {
      const text = warning.text?.trim();
      if (!text || seenWarnings.has(text)) {
        continue;
      }
      seenWarnings.add(text);
      userPayloads.push({ text, isError: true });
    }
    return userPayloads;
  }

  for (const warning of params.warnings) {
    const text = warning.text?.trim();
    if (!text) {
      continue;
    }
    const warningKey = `${warning.fingerprint}:${text}`;
    if (seenWarnings.has(warningKey)) {
      continue;
    }
    seenWarnings.add(warningKey);

    if (!shouldEmitByFingerprintRateLimit(warning.fingerprint, policy.dedupeWindowMs)) {
      continue;
    }

    const shouldRoute = shouldRouteWarningToWarningsChannel(warning, policy);
    let routed = false;
    let routeAttempted = false;
    if (shouldRoute && policy.route) {
      routeAttempted = true;
      const routedResult = await routeReply({
        payload: { text, isError: true },
        channel: policy.route.channel,
        to: policy.route.to,
        sessionKey: params.sessionKey,
        cfg: params.cfg,
        mirror: false,
      });
      routed = routedResult.ok;
      if (!routedResult.ok) {
        defaultRuntime.error(
          `tool warning route failed (${policy.route.channel}:${policy.route.to}): ${routedResult.error ?? "unknown error"}`,
        );
      }
    }

    if (
      shouldRouteWarningToUserChat({
        policy,
        warning,
        warningRouteAttempted: routeAttempted,
        warningRouteSucceeded: routed,
      })
    ) {
      userPayloads.push({ text, isError: true });
    }
  }

  return userPayloads;
}
