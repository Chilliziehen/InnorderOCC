import {
  SystemStatusSchema,
  type SystemStatus,
} from "@innorder/contracts";
import { ipcMain } from "electron";

import { SYSTEM_STATUSES_CHANNEL } from "./ipc-contract";

export { SYSTEM_STATUSES_CHANNEL } from "./ipc-contract";

interface StatusEndpoints {
  coreBaseUrl: string;
  aiBaseUrl: string;
  timeoutMs: number;
}

interface ServiceEndpoint {
  service: "occ-core" | "occ-ai";
  baseUrl: string;
}

function unreachable(service: ServiceEndpoint["service"]): SystemStatus {
  return SystemStatusSchema.parse({
    service,
    version: "unknown",
    state: "UNREACHABLE",
    checkedAt: new Date().toISOString(),
    components: [],
  });
}

async function fetchStatus(
  endpoint: ServiceEndpoint,
  timeoutMs: number,
): Promise<SystemStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = new URL("/api/v1/system/status", endpoint.baseUrl);
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      return unreachable(endpoint.service);
    }

    const status = SystemStatusSchema.parse(await response.json());
    if (status.service !== endpoint.service) {
      return unreachable(endpoint.service);
    }

    return status;
  } catch {
    return unreachable(endpoint.service);
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchSystemStatuses(
  endpoints: StatusEndpoints,
): Promise<SystemStatus[]> {
  return Promise.all([
    fetchStatus(
      { service: "occ-core", baseUrl: endpoints.coreBaseUrl },
      endpoints.timeoutMs,
    ),
    fetchStatus(
      { service: "occ-ai", baseUrl: endpoints.aiBaseUrl },
      endpoints.timeoutMs,
    ),
  ]);
}

export function registerSystemStatusIpc(endpoints: StatusEndpoints): () => void {
  ipcMain.removeHandler(SYSTEM_STATUSES_CHANNEL);
  ipcMain.handle(SYSTEM_STATUSES_CHANNEL, () => fetchSystemStatuses(endpoints));

  return () => ipcMain.removeHandler(SYSTEM_STATUSES_CHANNEL);
}
