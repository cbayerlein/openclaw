import { describe, expect, it } from "vitest";
import { applyOperationalAlertsEnvOverrides } from "./operational-alerts-runtime.js";

describe("applyOperationalAlertsEnvOverrides", () => {
  it("merges env-backed operational alert overrides onto config", () => {
    const next = applyOperationalAlertsEnvOverrides(
      {
        messages: {
          operationalAlerts: {
            enabled: true,
            target: "telegram",
            to: "-1001",
            fallback: "none",
          },
        },
      },
      {
        OPENCLAW_OPERATIONAL_ALERTS_TO: "-1002",
        OPENCLAW_OPERATIONAL_ALERTS_SOURCES: "tool,cron",
        OPENCLAW_OPERATIONAL_ALERTS_FALLBACK: "on-route-failure",
      },
    );

    expect(next.messages?.operationalAlerts).toEqual({
      enabled: true,
      target: "telegram",
      to: "-1002",
      sources: ["tool", "cron"],
      fallback: "on-route-failure",
    });
  });

  it("ignores invalid env values", () => {
    const next = applyOperationalAlertsEnvOverrides(
      {},
      {
        OPENCLAW_OPERATIONAL_ALERTS_ENABLED: "maybe",
        OPENCLAW_OPERATIONAL_ALERTS_SOURCES: "tool,nope",
        OPENCLAW_OPERATIONAL_ALERTS_DEDUPE_WINDOW_MS: "-1",
      },
    );

    expect(next).toEqual({
      messages: {
        operationalAlerts: {
          sources: ["tool"],
        },
      },
    });
  });

  it("parses per-kind env overrides", () => {
    const next = applyOperationalAlertsEnvOverrides(
      {},
      {
        OPENCLAW_OPERATIONAL_ALERTS_KINDS: "tool_failure,guardrail_warning",
        OPENCLAW_OPERATIONAL_ALERTS_DISABLED_KINDS: "guardrail_warning",
        OPENCLAW_OPERATIONAL_ALERTS_USER_CHAT_NEVER_KINDS: "tool_failure",
      },
    );

    expect(next.messages?.operationalAlerts).toEqual({
      kinds: ["tool_failure", "guardrail_warning"],
      kindPolicies: {
        guardrail_warning: { enabled: false },
        tool_failure: { userChat: "never" },
      },
    });
  });
});
