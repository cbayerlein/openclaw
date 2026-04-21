import { beforeEach, describe, expect, it, vi } from "vitest";

const { listSecretTargetRegistryEntriesMock } = vi.hoisted(() => ({
  listSecretTargetRegistryEntriesMock: vi.fn(() => {
    throw new Error("full secret target registry should stay off the status fast path");
  }),
}));

const { loadBundledChannelSecretContractApiMock } = vi.hoisted(() => ({
  loadBundledChannelSecretContractApiMock: vi.fn((channelId: string) => {
    if (channelId === "telegram") {
      return {
        secretTargetRegistryEntries: [
          { id: "channels.telegram.botToken" },
          { id: "channels.telegram.webhookSecret" },
        ],
      };
    }
    return undefined;
  }),
}));

vi.mock("../secrets/target-registry.js", () => ({
  discoverConfigSecretTargetsByIds: vi.fn(() => []),
  listSecretTargetRegistryEntries: listSecretTargetRegistryEntriesMock,
}));

vi.mock("../secrets/channel-contract-api.js", () => ({
  loadBundledChannelSecretContractApi: loadBundledChannelSecretContractApiMock,
}));

import { getConfiguredStatusCommandSecretTargetIds } from "./command-secret-targets.js";

describe("getConfiguredStatusCommandSecretTargetIds", () => {
  beforeEach(() => {
    listSecretTargetRegistryEntriesMock.mockClear();
    loadBundledChannelSecretContractApiMock.mockClear();
  });

  it("uses configured bundled channel contracts without touching the full registry", () => {
    const targetIds = getConfiguredStatusCommandSecretTargetIds({
      channels: { telegram: { enabled: true } },
    });

    expect(targetIds.has("agents.defaults.memorySearch.remote.apiKey")).toBe(true);
    expect(targetIds.has("agents.list[].memorySearch.remote.apiKey")).toBe(true);
    expect(targetIds.has("channels.telegram.botToken")).toBe(true);
    expect(targetIds.has("channels.telegram.webhookSecret")).toBe(true);
    expect(loadBundledChannelSecretContractApiMock).toHaveBeenCalledWith("telegram");
    expect(listSecretTargetRegistryEntriesMock).not.toHaveBeenCalled();
  });
});
