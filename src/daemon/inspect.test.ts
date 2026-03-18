import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findExtraGatewayServices, renderGatewayServiceCleanupHints } from "./inspect.js";

const { execSchtasksMock } = vi.hoisted(() => ({
  execSchtasksMock: vi.fn(),
}));

vi.mock("./schtasks-exec.js", () => ({
  execSchtasks: (...args: unknown[]) => execSchtasksMock(...args),
}));

describe("findExtraGatewayServices (win32)", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    execSchtasksMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  it("skips schtasks queries unless deep mode is enabled", async () => {
    const result = await findExtraGatewayServices({});
    expect(result).toEqual([]);
    expect(execSchtasksMock).not.toHaveBeenCalled();
  });

  it("returns empty results when schtasks query fails", async () => {
    execSchtasksMock.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "error",
    });

    const result = await findExtraGatewayServices({}, { deep: true });
    expect(result).toEqual([]);
  });

  it("collects only non-openclaw marker tasks from schtasks output", async () => {
    execSchtasksMock.mockResolvedValueOnce({
      code: 0,
      stdout: [
        "TaskName: OpenClaw Gateway",
        "Task To Run: C:\\Program Files\\OpenClaw\\openclaw.exe gateway run",
        "",
        "TaskName: Clawdbot Legacy",
        "Task To Run: C:\\clawdbot\\clawdbot.exe run",
        "",
        "TaskName: Other Task",
        "Task To Run: C:\\tools\\helper.exe",
        "",
        "TaskName: MoltBot Legacy",
        "Task To Run: C:\\moltbot\\moltbot.exe run",
        "",
      ].join("\n"),
      stderr: "",
    });

    const result = await findExtraGatewayServices({}, { deep: true });
    expect(result).toEqual([
      {
        platform: "win32",
        label: "Clawdbot Legacy",
        detail: "task: Clawdbot Legacy, run: C:\\clawdbot\\clawdbot.exe run",
        scope: "system",
        marker: "clawdbot",
        legacy: true,
      },
      {
        platform: "win32",
        label: "MoltBot Legacy",
        detail: "task: MoltBot Legacy, run: C:\\moltbot\\moltbot.exe run",
        scope: "system",
        marker: "moltbot",
        legacy: true,
      },
    ]);
  });
});

describe("renderGatewayServiceCleanupHints", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  it("renders linux user cleanup hints by default", () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "linux",
    });

    expect(renderGatewayServiceCleanupHints({ OPENCLAW_PROFILE: "" })).toEqual([
      "systemctl --user disable --now openclaw-gateway.service",
      "rm ~/.config/systemd/user/openclaw-gateway.service",
    ]);
  });

  it("renders linux system cleanup hints when system scope is requested", () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "linux",
    });

    expect(
      renderGatewayServiceCleanupHints({ OPENCLAW_PROFILE: "" }, { linuxScopes: ["system"] }),
    ).toEqual([
      "sudo systemctl disable --now openclaw-gateway.service",
      "sudo rm /etc/systemd/system/openclaw-gateway.service",
    ]);
  });

  it("renders both linux user and system cleanup hints for mixed scopes", () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "linux",
    });

    expect(
      renderGatewayServiceCleanupHints(
        { OPENCLAW_PROFILE: "" },
        { linuxScopes: ["user", "system"] },
      ),
    ).toEqual([
      "systemctl --user disable --now openclaw-gateway.service",
      "rm ~/.config/systemd/user/openclaw-gateway.service",
      "sudo systemctl disable --now openclaw-gateway.service",
      "sudo rm /etc/systemd/system/openclaw-gateway.service",
    ]);
  });
});
