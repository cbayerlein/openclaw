import { describe, expect, it, vi } from "vitest";

const routeOperationalAlert = vi.hoisted(() => vi.fn());

describe("routeRuntimeWarning", () => {
  it("suppresses user chat only after a successful warnings-route delivery", async () => {
    vi.resetModules();
    routeOperationalAlert.mockReset().mockResolvedValue({ status: "delivered" });
    vi.doMock("./operational-alerts.js", () => ({
      routeOperationalAlert,
    }));
    const { routeRuntimeWarning } = await import("./runtime-warnings.js");

    const result = await routeRuntimeWarning({
      cfg: {
        messages: {
          operationalAlerts: {
            enabled: true,
            target: "telegram",
            to: "-100ops",
          },
        },
      },
      warning: {
        kind: "tool_exec_failure",
        source: "tool",
        severity: "critical",
        text: "exec failed",
        fingerprint: "tool_exec_failure|exec failed",
      },
    });

    expect(result.suppressUserChat).toBe(true);
    expect(routeOperationalAlert).toHaveBeenCalledOnce();
  });

  it("routes recoverable warnings by default and suppresses user chat after delivery", async () => {
    vi.resetModules();
    routeOperationalAlert.mockReset().mockResolvedValue({ status: "delivered" });
    vi.doMock("./operational-alerts.js", () => ({
      routeOperationalAlert,
    }));
    const { routeRuntimeWarning } = await import("./runtime-warnings.js");

    const result = await routeRuntimeWarning({
      cfg: {
        messages: {
          operationalAlerts: {
            enabled: true,
            target: "telegram",
            to: "-100ops",
          },
        },
      },
      warning: {
        kind: "tool_recoverable_warning",
        source: "tool",
        severity: "warn",
        text: "missing path",
        fingerprint: "tool_recoverable_warning|missing path",
      },
    });

    expect(result.suppressUserChat).toBe(true);
    expect(routeOperationalAlert).toHaveBeenCalledOnce();
  });

  it("keeps user chat when the operator alert is only deduped", async () => {
    vi.resetModules();
    routeOperationalAlert.mockReset().mockResolvedValue({
      status: "deduped",
      route: { channel: "telegram", to: "-100ops" },
    });
    vi.doMock("./operational-alerts.js", () => ({
      routeOperationalAlert,
    }));
    const { routeRuntimeWarning } = await import("./runtime-warnings.js");

    const result = await routeRuntimeWarning({
      cfg: {
        messages: {
          operationalAlerts: {
            enabled: true,
            target: "telegram",
            to: "-100ops",
          },
        },
      },
      warning: {
        kind: "provider_failure",
        source: "provider",
        severity: "critical",
        text: "quota exhausted",
        fingerprint: "provider_failure|quota exhausted",
      },
    });

    expect(result.suppressUserChat).toBe(false);
    expect(routeOperationalAlert).toHaveBeenCalledOnce();
  });

  it("honors kind policy overrides", async () => {
    vi.resetModules();
    routeOperationalAlert.mockReset().mockResolvedValue({ status: "delivered" });
    vi.doMock("./operational-alerts.js", () => ({
      routeOperationalAlert,
    }));
    const { routeRuntimeWarning } = await import("./runtime-warnings.js");

    const result = await routeRuntimeWarning({
      cfg: {
        messages: {
          operationalAlerts: {
            enabled: true,
            target: "telegram",
            to: "-100ops",
            kindPolicies: {
              provider_failure: {
                warningsRoute: false,
                userChat: "always",
              },
            },
          },
        },
      },
      warning: {
        kind: "provider_failure",
        source: "provider",
        severity: "critical",
        text: "quota exhausted",
        fingerprint: "provider_failure|quota exhausted",
      },
    });

    expect(result.policy.userChat).toBe("always");
    expect(result.suppressUserChat).toBe(false);
    expect(routeOperationalAlert).not.toHaveBeenCalled();
  });
});
