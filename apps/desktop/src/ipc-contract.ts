import type { SystemStatus } from "@innorder/contracts";

export const SYSTEM_STATUSES_CHANNEL = "system-statuses:get";

export * from "./desktop-contract";

export type CanonicalOccApi = import("./desktop-contract").OccApi;

// Transitional type for the existing preload until grouped IPC lands.
export interface OccApi {
  getSystemStatuses(): Promise<SystemStatus[]>;
}
