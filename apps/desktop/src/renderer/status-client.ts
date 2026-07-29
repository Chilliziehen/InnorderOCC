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

export async function getSystemStatuses(): Promise<SystemStatus[]> {
  try {
    const statuses = await window.occ.getSystemStatuses();
    return statuses.map((status) => SystemStatusSchema.parse(status));
  } catch {
    return unreachableStatuses();
  }
}

export function startStatusPolling(
  onStatuses: (statuses: SystemStatus[]) => void,
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
      const statuses = await getSystemStatuses();
      if (!disposed) {
        onStatuses(statuses);
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
