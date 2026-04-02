import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveSessionStore } from "../config/sessions.js";

const deliverOutboundPayloads = vi.hoisted(() => vi.fn());
const resolveAgentOutboundIdentity = vi.hoisted(() => vi.fn(() => ({ kind: "identity" })));
const resolveOutboundTarget = vi.hoisted(() =>
  vi.fn(({ channel: _channel, to }: { channel: string; to?: string }) =>
    to ? { ok: true as const, to } : { ok: false as const, error: new Error("missing target") },
  ),
);
const resolveHeartbeatDeliveryTarget = vi.hoisted(() =>
  vi.fn(
    ({
      cfg,
    }: {
      cfg: {
        agents?: {
          defaults?: { heartbeat?: { target?: string; to?: string; accountId?: string } };
        };
      };
    }) => {
      const heartbeat = cfg.agents?.defaults?.heartbeat;
      if (!heartbeat?.target || !heartbeat.to) {
        return { channel: "none" as const };
      }
      return {
        channel: heartbeat.target,
        to: heartbeat.to,
        accountId: heartbeat.accountId,
      };
    },
  ),
);
const resolveSessionDeliveryTarget = vi.hoisted(() =>
  vi.fn(
    ({
      entry,
    }: {
      entry?: {
        lastChannel?: string;
        lastTo?: string;
        lastAccountId?: string;
        lastThreadId?: string | number;
      };
    }) => ({
      channel: entry?.lastChannel,
      to: entry?.lastTo,
      accountId: entry?.lastAccountId,
      threadId: entry?.lastThreadId,
    }),
  ),
);

describe("routeOperationalAlert", () => {
  let tempDir: string;
  let storePath: string;
  let routeOperationalAlert: typeof import("./operational-alerts.js").routeOperationalAlert;
  let resetOperationalAlertDeduperForTest: typeof import("./operational-alerts.js").resetOperationalAlertDeduperForTest;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("./outbound/deliver.js", () => ({
      deliverOutboundPayloads,
    }));
    vi.doMock("./outbound/identity.js", () => ({
      resolveAgentOutboundIdentity,
    }));
    vi.doMock("./outbound/targets.js", () => ({
      resolveOutboundTarget,
      resolveHeartbeatDeliveryTarget,
      resolveSessionDeliveryTarget,
    }));
    ({ routeOperationalAlert, resetOperationalAlertDeduperForTest } =
      await import("./operational-alerts.js"));
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-operational-alerts-"));
    storePath = path.join(tempDir, "sessions.json");
    resetOperationalAlertDeduperForTest();
    deliverOutboundPayloads.mockReset();
    resolveAgentOutboundIdentity.mockClear();
    resolveOutboundTarget.mockClear();
    resolveHeartbeatDeliveryTarget.mockClear();
    resolveSessionDeliveryTarget.mockClear();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("delivers to an explicit operator route", async () => {
    await routeOperationalAlert({
      cfg: {
        session: { store: storePath },
        messages: {
          operationalAlerts: {
            enabled: true,
            target: "telegram",
            to: "-100ops",
          },
        },
      },
      alert: {
        source: "tool",
        severity: "warn",
        text: "tool failed",
        fingerprint: "tool|failed",
        agentId: "main",
      },
    });

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(deliverOutboundPayloads.mock.calls[0]?.[0]).toMatchObject({
      channel: "telegram",
      to: "-100ops",
      payloads: [{ text: "tool failed" }],
    });
  });

  it("dedupes repeated alerts for the same operator route", async () => {
    const cfg = {
      session: { store: storePath },
      messages: {
        operationalAlerts: {
          enabled: true,
          target: "telegram",
          to: "-100ops",
          dedupeWindowMs: 60_000,
        },
      },
    };

    const first = await routeOperationalAlert({
      cfg,
      alert: {
        source: "tool",
        severity: "warn",
        text: "tool failed",
        fingerprint: "tool|failed",
      },
    });
    const second = await routeOperationalAlert({
      cfg,
      alert: {
        source: "tool",
        severity: "warn",
        text: "tool failed",
        fingerprint: "tool|failed",
      },
    });

    expect(first.status).toBe("delivered");
    expect(second.status).toBe("deduped");
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
  });

  it("falls back to the heartbeat route when no explicit operator route is configured", async () => {
    const result = await routeOperationalAlert({
      cfg: {
        session: { store: storePath },
        agents: {
          defaults: {
            heartbeat: {
              target: "telegram",
              to: "-100heartbeat",
            },
          },
        },
        messages: {
          operationalAlerts: {
            enabled: true,
          },
        },
      },
      alert: {
        source: "heartbeat",
        severity: "critical",
        text: "heartbeat failed",
        fingerprint: "heartbeat|failed",
      },
    });

    expect(result.status).toBe("delivered");
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "-100heartbeat",
      }),
    );
  });

  it("falls back to the user chat on operator-route failure", async () => {
    await saveSessionStore(storePath, {
      "agent:main:main": {
        sessionId: "session-1",
        updatedAt: Date.now(),
        lastChannel: "telegram",
        lastTo: "-100user",
      },
    });
    deliverOutboundPayloads
      .mockRejectedValueOnce(new Error("operator route failed"))
      .mockResolvedValueOnce([{ messageId: "msg-2", channel: "telegram" }]);

    const result = await routeOperationalAlert({
      cfg: {
        session: { store: storePath },
        messages: {
          operationalAlerts: {
            enabled: true,
            target: "telegram",
            to: "-100ops",
            fallback: "on-route-failure",
          },
        },
      },
      alert: {
        source: "tool",
        severity: "warn",
        text: "tool failed",
        fingerprint: "tool|failed",
        sessionKey: "agent:main:main",
        agentId: "main",
      },
    });

    expect(result.status).toBe("fallback-delivered");
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(2);
    expect(deliverOutboundPayloads.mock.calls[1]?.[0]).toMatchObject({
      channel: "telegram",
      to: "-100user",
      session: { key: "agent:main:main", agentId: "main" },
    });
  });
});
