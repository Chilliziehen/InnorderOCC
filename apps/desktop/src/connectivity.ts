import type { SystemStatus } from "@innorder/contracts";

export type CoreRequestOutcome = "success" | "network-failure";

export interface ConnectivityTracker {
  isOnline(): boolean;
  recordRequestOutcome(outcome: CoreRequestOutcome): void;
  observeStatuses(statuses: readonly SystemStatus[]): void;
  markOffline(): void;
}

export function createConnectivityTracker(): ConnectivityTracker {
  let online = false;
  return {
    isOnline: () => online,
    recordRequestOutcome: (outcome) => void (online = outcome === "success"),
    observeStatuses: (statuses) => {
      const core = statuses.find(({ service }) => service === "occ-core");
      if (!core || core.state === "CHECKING") return;
      online = core.state !== "UNREACHABLE";
    },
    markOffline: () => void (online = false),
  };
}
