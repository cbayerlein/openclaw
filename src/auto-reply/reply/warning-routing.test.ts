import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const routeReplyMock = vi.fn();

vi.mock("./route-reply.js", () => ({
  isRoutableChannel: (channel?: string) => Boolean(channel && channel !== "webchat"),
  routeReply: (params: unknown) => routeReplyMock(params),
}));

import { __resetWarningRoutingForTests, processWarningEvents } from "./warning-routing.js";

const prevToolWarningsEnabledEnv = process.env.OPENCLAW_TOOL_WARNINGS_ENABLED;

describe("processWarningEvents", () => {
  beforeEach(() => {
    routeReplyMock.mockReset();
    __resetWarningRoutingForTests();
    delete process.env.OPENCLAW_TOOL_WARNINGS_ENABLED;
  });

  afterEach(() => {
    if (prevToolWarningsEnabledEnv === undefined) {
      delete process.env.OPENCLAW_TOOL_WARNINGS_ENABLED;
    } else {
      process.env.OPENCLAW_TOOL_WARNINGS_ENABLED = prevToolWarningsEnabledEnv;
    }
  });

  const baseWarning = {
    kind: "tool_error" as const,
    text: "⚠️ 🛠️ Exec failed: exit code 1",
    toolName: "exec",
    toolSummary: "🛠️ Exec",
    errorText: "exit code 1",
    isMutating: false,
    fingerprint: "abc123",
    ts: Date.now(),
  };

  it("routes exec warnings to dedicated target and keeps user chat clean when fallback disabled", async () => {
    routeReplyMock.mockResolvedValueOnce({ ok: true });

    const payloads = await processWarningEvents({
      warnings: [baseWarning],
      cfg: {
        messages: {
          toolWarnings: {
            enabled: true,
            target: "telegram",
            to: "-1003842428779",
            fallbackToUserChat: false,
          },
        },
      } as OpenClawConfig,
      sessionKey: "agent:main:main",
    });

    expect(routeReplyMock).toHaveBeenCalledTimes(1);
    expect(payloads).toEqual([]);
  });

  it("falls back to user chat when no warnings target is configured", async () => {
    const payloads = await processWarningEvents({
      warnings: [baseWarning],
      cfg: {
        messages: {
          suppressToolErrors: false,
          toolWarnings: { enabled: true, fallbackToUserChat: true },
        },
      } as OpenClawConfig,
    });

    expect(routeReplyMock).not.toHaveBeenCalled();
    expect(payloads).toEqual([{ text: baseWarning.text, isError: true }]);
  });

  it("rate-limits duplicate warning fingerprints inside dedupe window", async () => {
    routeReplyMock.mockResolvedValue({ ok: true });
    const cfg = {
      messages: {
        toolWarnings: {
          enabled: true,
          target: "telegram",
          to: "-1003842428779",
          dedupeWindowMs: 60_000,
        },
      },
    } as OpenClawConfig;

    const first = await processWarningEvents({ warnings: [baseWarning], cfg });
    const second = await processWarningEvents({ warnings: [baseWarning], cfg });

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(routeReplyMock).toHaveBeenCalledTimes(1);
  });

  it("uses legacy user-chat behavior when feature flag is disabled", async () => {
    const payloads = await processWarningEvents({
      warnings: [baseWarning],
      cfg: {
        messages: {
          suppressToolErrors: false,
          toolWarnings: {
            target: "telegram",
            to: "-1003842428779",
            fallbackToUserChat: false,
          },
        },
      } as OpenClawConfig,
    });

    expect(routeReplyMock).not.toHaveBeenCalled();
    expect(payloads).toEqual([{ text: baseWarning.text, isError: true }]);
  });

  it("env flag overrides config enable state", async () => {
    process.env.OPENCLAW_TOOL_WARNINGS_ENABLED = "1";
    routeReplyMock.mockResolvedValueOnce({ ok: true });

    const payloads = await processWarningEvents({
      warnings: [baseWarning],
      cfg: {
        messages: {
          suppressToolErrors: false,
          toolWarnings: {
            enabled: false,
            target: "telegram",
            to: "-1003842428779",
            fallbackToUserChat: false,
          },
        },
      } as OpenClawConfig,
    });

    expect(routeReplyMock).toHaveBeenCalledTimes(1);
    expect(payloads).toEqual([]);
  });
});
