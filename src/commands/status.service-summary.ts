import type { GatewayServiceRuntime } from "../daemon/service-runtime.js";
import type { GatewayService } from "../daemon/service.js";
import {
  isSystemdSystemServiceEnabled,
  readSystemdSystemServiceExecStart,
  readSystemdSystemServiceRuntime,
} from "../daemon/systemd.js";

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
    let command = await service.readCommand(process.env).catch(() => null);
    let serviceEnv = command?.environment
      ? ({
          ...process.env,
          ...command.environment,
        } satisfies NodeJS.ProcessEnv)
      : process.env;
    let [loaded, runtime] = await Promise.all([
      service.isLoaded({ env: serviceEnv }).catch(() => false),
      service.readRuntime(serviceEnv).catch(() => undefined),
    ]);
    if (process.platform === "linux" && !command && runtime?.status !== "running") {
      const [systemCommand, systemLoaded, systemRuntime] = await Promise.all([
        readSystemdSystemServiceExecStart(process.env).catch(() => null),
        isSystemdSystemServiceEnabled({ env: process.env }).catch(() => false),
        readSystemdSystemServiceRuntime(process.env).catch(() => undefined),
      ]);
      if (systemCommand || systemLoaded || systemRuntime?.status === "running") {
        command = systemCommand;
        serviceEnv = systemCommand?.environment
          ? ({
              ...process.env,
              ...systemCommand.environment,
            } satisfies NodeJS.ProcessEnv)
          : process.env;
        loaded = systemLoaded;
        runtime = systemRuntime;
      }
    }
    const managedByOpenClaw = command != null;
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
