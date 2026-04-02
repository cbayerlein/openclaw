import type {
  OpenClawConfig,
  OperationalAlertFallback,
  OperationalAlertKindPolicy,
  OperationalAlertSeverity,
  OperationalAlertSource,
  OperationalAlertsConfig,
  RuntimeWarningKind,
} from "./types.js";

const ENV_PREFIX = "OPENCLAW_OPERATIONAL_ALERTS_";
const VALID_SOURCES = new Set<OperationalAlertSource>([
  "tool",
  "agent",
  "provider",
  "heartbeat",
  "cron",
  "delivery",
  "channel",
  "guardrail",
]);
const VALID_SEVERITIES = new Set<OperationalAlertSeverity>(["warn", "critical"]);
const VALID_KINDS = new Set<RuntimeWarningKind>([
  "tool_failure",
  "tool_exec_failure",
  "tool_recoverable_warning",
  "session_delivery_failure",
  "provider_failure",
  "agent_run_failure",
  "heartbeat_failure",
  "cron_failure",
  "cron_runtime_failure",
  "reply_delivery_failure",
  "channel_warning",
  "guardrail_warning",
]);
const VALID_FALLBACKS = new Set<OperationalAlertFallback>([
  "none",
  "on-route-failure",
  "always-user-chat",
]);

function normalizeOptionalString(value?: string | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseBooleanEnv(value?: string | null): boolean | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function parseIntegerEnv(value?: string | null): number | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

function parseCsvEnumList<T extends string>(
  value: string | undefined,
  valid: ReadonlySet<T>,
): T[] | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  const entries = normalized
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean) as T[];
  if (entries.length === 0) {
    return undefined;
  }
  const filtered = entries.filter((entry) => valid.has(entry));
  return filtered.length > 0 ? [...new Set(filtered)] : undefined;
}

function resolveOperationalAlertsEnvOverride(
  env: NodeJS.ProcessEnv,
): OperationalAlertsConfig | undefined {
  const enabled = parseBooleanEnv(env[`${ENV_PREFIX}ENABLED`]);
  const target = normalizeOptionalString(env[`${ENV_PREFIX}TARGET`]);
  const to = normalizeOptionalString(env[`${ENV_PREFIX}TO`]);
  const accountId = normalizeOptionalString(env[`${ENV_PREFIX}ACCOUNT_ID`]);
  const sources = parseCsvEnumList(env[`${ENV_PREFIX}SOURCES`], VALID_SOURCES);
  const severities = parseCsvEnumList(env[`${ENV_PREFIX}SEVERITIES`], VALID_SEVERITIES);
  const kinds = parseCsvEnumList(env[`${ENV_PREFIX}KINDS`], VALID_KINDS);
  const disabledKinds = parseCsvEnumList(env[`${ENV_PREFIX}DISABLED_KINDS`], VALID_KINDS);
  const userChatNeverKinds = parseCsvEnumList(
    env[`${ENV_PREFIX}USER_CHAT_NEVER_KINDS`],
    VALID_KINDS,
  );
  const userChatAlwaysKinds = parseCsvEnumList(
    env[`${ENV_PREFIX}USER_CHAT_ALWAYS_KINDS`],
    VALID_KINDS,
  );
  const fallbackRaw = normalizeOptionalString(env[`${ENV_PREFIX}FALLBACK`])?.toLowerCase();
  const fallback =
    fallbackRaw && VALID_FALLBACKS.has(fallbackRaw as OperationalAlertFallback)
      ? (fallbackRaw as OperationalAlertFallback)
      : undefined;
  const dedupeWindowMs = parseIntegerEnv(env[`${ENV_PREFIX}DEDUPE_WINDOW_MS`]);

  const kindPolicies: Partial<Record<RuntimeWarningKind, OperationalAlertKindPolicy>> = {};
  for (const kind of disabledKinds ?? []) {
    kindPolicies[kind] = { ...kindPolicies[kind], enabled: false };
  }
  for (const kind of userChatNeverKinds ?? []) {
    kindPolicies[kind] = { ...kindPolicies[kind], userChat: "never" };
  }
  for (const kind of userChatAlwaysKinds ?? []) {
    kindPolicies[kind] = { ...kindPolicies[kind], userChat: "always" };
  }

  const override: OperationalAlertsConfig = {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(target ? { target } : {}),
    ...(to ? { to } : {}),
    ...(accountId ? { accountId } : {}),
    ...(sources ? { sources } : {}),
    ...(severities ? { severities } : {}),
    ...(kinds ? { kinds } : {}),
    ...(Object.keys(kindPolicies).length > 0 ? { kindPolicies } : {}),
    ...(fallback ? { fallback } : {}),
    ...(dedupeWindowMs !== undefined ? { dedupeWindowMs } : {}),
  };

  return Object.keys(override).length > 0 ? override : undefined;
}

export function applyOperationalAlertsEnvOverrides(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): OpenClawConfig {
  const override = resolveOperationalAlertsEnvOverride(env);
  if (!override) {
    return cfg;
  }
  return {
    ...cfg,
    messages: {
      ...cfg.messages,
      operationalAlerts: {
        ...cfg.messages?.operationalAlerts,
        ...override,
      },
    },
  };
}
