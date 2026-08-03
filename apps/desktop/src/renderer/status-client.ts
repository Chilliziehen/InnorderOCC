import {
  SystemStatusSchema,
  type SystemStatus,
} from "@innorder/contracts";

const FALLBACK_SERVICES = ["occ-core", "occ-ai"] as const;

function unreachableStatuses(): SystemStatus[] {
  const checkedAt = new Date().toISOString();
  return FALLBACK_SERVICES.map((service) =>
    SystemStatusSchema.parse({
      service,
      version: "unknown",
      state: "UNREACHABLE",
      checkedAt,
      components: [],
    }),
  );
}

export interface StatusPollSample {
  statuses: SystemStatus[];
  successful: boolean;
  coreReachable: boolean;
  polledAt: number;
}

export async function getSystemStatuses(): Promise<StatusPollSample> {
  const polledAt = Date.now();
  try {
    const statuses = (await window.occ.runtime.statuses())
      .map((status) => SystemStatusSchema.parse(status));
    const core = statuses.find(({ service }) => service === "occ-core");
    return {
      statuses,
      successful: true,
      coreReachable: core !== undefined && core.state !== "UNREACHABLE",
      polledAt,
    };
  } catch {
    return {
      statuses: unreachableStatuses(),
      successful: false,
      coreReachable: false,
      polledAt,
    };
  }
}

export function startStatusPolling(
  onStatuses: (sample: StatusPollSample) => void,
  intervalMs = 15_000,
): () => void {
  let disposed = false;
  let inFlight = false;

  const poll = async (): Promise<void> => {
    if (disposed || inFlight) {
      return;
    }

    inFlight = true;
    try {
      const sample = await getSystemStatuses();
      if (!disposed) {
        onStatuses(sample);
      }
    } finally {
      inFlight = false;
    }
  };

  void poll();
  const timer = window.setInterval(() => void poll(), intervalMs);

  return () => {
    disposed = true;
    window.clearInterval(timer);
  };
}
