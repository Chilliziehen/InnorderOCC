import type { OccApi } from "./desktop-contract";
import { createDesktopApi, type DesktopApiDependencies } from "./desktop-ipc";
import { mainUnavailableNotificationList, mainUnavailableOperation } from "./main-operation-registry";
import type { NotificationSession } from "./notification-stream";

interface MainReliabilityCompositionOptions extends Pick<
  DesktopApiDependencies,
  "profiles" | "session" | "statuses" | "clearProfile"
> {
  readonly readCache: NonNullable<DesktopApiDependencies["readCache"]>;
  readonly notificationStream: { setSession(session: NotificationSession | null): Promise<void> };
  readonly uploads: Pick<OccApi["uploads"], "preflight" | "start" | "cancel">;
  readonly getCustomerInstanceId: () => string | null;
  readonly isOnline: () => boolean;
}

export function createMainReliabilityApi(options: MainReliabilityCompositionOptions) {
  let activeGeneration = 0;
  return createDesktopApi({
    profiles: options.profiles,
    session: options.session,
    statuses: options.statuses,
    clearProfile: options.clearProfile,
    readCache: options.readCache,
    getCacheScope: (principalId) => {
      const profile = options.profiles.selected();
      const customerInstanceId = options.getCustomerInstanceId();
      return profile && customerInstanceId
        ? { profileId: profile.id, customerInstanceId, principalId }
        : null;
    },
    workspaceQuery: async (input) => mainUnavailableOperation(input.workspace, input.operation, "/workspaces"),
    executeCommand: async (input) => mainUnavailableOperation(input.workspace, input.operation, "/commands"),
    isOnline: options.isOnline,
    uploads: options.uploads,
    notifications: { list: async () => mainUnavailableNotificationList() },
    onSessionScopeChanged: (scope, generation) => {
      activeGeneration = generation;
      if (!scope) {
        void options.notificationStream.setSession(null);
        return;
      }
      const profile = options.profiles.selected();
      if (!profile || generation !== activeGeneration) return;
      void options.notificationStream.setSession({ scope, origin: profile.origin, endpointAvailable: false });
    },
  });
}
