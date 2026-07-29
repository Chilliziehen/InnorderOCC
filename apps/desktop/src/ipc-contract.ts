import type { SystemStatus } from "@innorder/contracts";

export const SYSTEM_STATUSES_CHANNEL = "system-statuses:get";

export interface OccApi {
  getSystemStatuses(): Promise<SystemStatus[]>;
}
