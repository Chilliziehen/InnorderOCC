import { createMainOperationPolicy } from "./main-operation-policy";
import type { RuntimeBuildAdapter } from "./runtime-adapter-contract";

export const runtimeBuild: RuntimeBuildAdapter = {
  operationPolicy: createMainOperationPolicy(false),
  createServices() {
    return {
      notificationConnector: () => { throw new Error("Notification contract unavailable"); },
      notificationEndpointAvailable: false,
      evidenceTransport: async () => { throw new Error("Evidence contract unavailable"); },
      evidenceEndpointAvailable: false,
    };
  },
};
