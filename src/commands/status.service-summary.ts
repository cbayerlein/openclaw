import type { GatewayServiceRuntime } from "../daemon/service-runtime.js";
import { readGatewayServiceState, type GatewayService } from "../daemon/service.js";
import * as systemd from "../daemon/systemd.js";

export type ServiceStatusSummary = {
  label: string;
  installed: boolean | null;
  loaded: boolean;
  managedByOpenClaw: boolean;
  externallyManaged: boolean;
  loadedText: string;
  runtime: GatewayServiceRuntime | undefined;
};

export async function readServiceStatusSummary(
  service: GatewayService,
  fallbackLabel: string,
): Promise<ServiceStatusSummary> {
  try {
    let state = await readGatewayServiceState(service, { env: process.env });
    let managedByOpenClaw = state.installed;
    let runtime = state.runtime;
    let loaded = state.loaded;

    if (process.platform === "linux" && !managedByOpenClaw && runtime?.status !== "running") {
      const [systemCommand, systemLoaded, systemRuntime] = await Promise.all([
        systemd.readSystemdSystemServiceExecStart(process.env).catch(() => null),
        systemd.isSystemdSystemServiceEnabled({ env: process.env }).catch(() => false),
        systemd.readSystemdSystemServiceRuntime(process.env).catch(() => undefined),
      ]);
      if (systemCommand || systemLoaded || systemRuntime?.status === "running") {
        managedByOpenClaw = systemCommand != null;
        loaded = systemLoaded;
        runtime = systemRuntime;
      }
    }

    const externallyManaged = !managedByOpenClaw && runtime?.status === "running";
    const installed = managedByOpenClaw || externallyManaged;
    const loadedText = externallyManaged
      ? "running (externally managed)"
      : loaded
        ? service.loadedText
        : service.notLoadedText;
    return {
      label: service.label,
      installed,
      loaded,
      managedByOpenClaw,
      externallyManaged,
      loadedText,
      runtime,
    };
  } catch {
    return {
      label: fallbackLabel,
      installed: null,
      loaded: false,
      managedByOpenClaw: false,
      externallyManaged: false,
      loadedText: "unknown",
      runtime: undefined,
    };
  }
}
