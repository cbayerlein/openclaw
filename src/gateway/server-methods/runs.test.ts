import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../infra/run-observability.js", () => ({
  getRunObservabilitySummary: vi.fn(),
  listRunObservabilityEvents: vi.fn(),
  listRunObservabilitySummaries: vi.fn(),
}));

import {
  getRunObservabilitySummary,
  listRunObservabilityEvents,
  listRunObservabilitySummaries,
} from "../../infra/run-observability.js";
import { runsHandlers } from "./runs.js";

describe("runsHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns run list payloads for valid params", async () => {
    const respond = vi.fn();
    vi.mocked(listRunObservabilitySummaries).mockResolvedValue({
      items: [{ runId: "run-1", status: "done", updatedAt: 1, eventCount: 1, toolCount: 0 }],
      hasMore: false,
    });

    await runsHandlers["runs.list"]({
      req: { type: "req", method: "runs.list", id: "1" },
      params: { limit: 25 },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    expect(listRunObservabilitySummaries).toHaveBeenCalledWith({ limit: 25 });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        items: [{ runId: "run-1", status: "done", updatedAt: 1, eventCount: 1, toolCount: 0 }],
        hasMore: false,
      },
      undefined,
    );
  });

  it("returns not_found for missing runs.get target", async () => {
    const respond = vi.fn();
    vi.mocked(getRunObservabilitySummary).mockResolvedValue(null);

    await runsHandlers["runs.get"]({
      req: { type: "req", method: "runs.get", id: "1" },
      params: { runId: "missing" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "run not found: missing",
      }),
    );
  });

  it("returns events payloads for valid runs.events params", async () => {
    const respond = vi.fn();
    vi.mocked(getRunObservabilitySummary).mockResolvedValue({
      runId: "run-1",
      status: "running",
      updatedAt: 100,
      eventCount: 2,
      toolCount: 1,
    });
    vi.mocked(listRunObservabilityEvents).mockResolvedValue({
      items: [{ idx: 1, runId: "run-1", ts: 100, stream: "tool", kind: "tool_started", data: {} }],
      hasMore: false,
    });

    await runsHandlers["runs.events"]({
      req: { type: "req", method: "runs.events", id: "1" },
      params: { runId: "run-1", limit: 10 },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    expect(listRunObservabilityEvents).toHaveBeenCalledWith({ runId: "run-1", limit: 10 });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        items: [
          { idx: 1, runId: "run-1", ts: 100, stream: "tool", kind: "tool_started", data: {} },
        ],
        hasMore: false,
      },
      undefined,
    );
  });
});
