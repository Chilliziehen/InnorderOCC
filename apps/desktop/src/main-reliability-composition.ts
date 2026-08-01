import type { OccApi } from "./desktop-contract";
import { createDesktopApi, type DesktopApiDependencies } from "./desktop-ipc";
import { mainUnavailableNotificationList, mainUnavailableOperation } from "./main-operation-registry";
import type { NotificationSession } from "./notification-stream";
import type { ConnectivityTracker } from "./connectivity";

interface MainReliabilityCompositionOptions extends Pick<
  DesktopApiDependencies,
  "profiles" | "session" | "statuses" | "clearProfile"
> {
  readonly readCache: NonNullable<DesktopApiDependencies["readCache"]>;
  readonly notificationStream: { setSession(session: NotificationSession | null): Promise<void> };
  readonly uploads: Pick<OccApi["uploads"], "preflight" | "start" | "cancel">;
  readonly getCustomerInstanceId: () => string | null;
  readonly connectivity: ConnectivityTracker;
  readonly getNotificationSession?: (scope: NotificationSession["scope"]) => NotificationSession | null;
  readonly onBackgroundError?: (error: Error) => void;
}

export function createMainReliabilityApi(options: MainReliabilityCompositionOptions) {
  let activeGeneration = 0;
  let notificationActive = false;
  const reportBackgroundError = () => {
    try { options.onBackgroundError?.(new Error("Notification session update failed")); } catch { /* Background reporting is contained. */ }
  };
  const setNotificationSession = (session: NotificationSession | null) => {
    if (session === null && !notificationActive) return;
    if (session) {
      if (!session.endpointAvailable) return;
      try {
        const origin = new URL(session.origin);
        if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
          reportBackgroundError();
          return;
        }
      } catch {
        reportBackgroundError();
        return;
      }
    }
    notificationActive = session !== null;
    try {
      void options.notificationStream.setSession(session).catch(reportBackgroundError);
    } catch {
      reportBackgroundError();
    }
  };
  return createDesktopApi({
    profiles: options.profiles,
    session: {
      restore: () => options.session.restore(),
      login: (input) => options.session.login(input),
      logout: async () => {
        try { await options.session.logout(); } finally { options.connectivity.markOffline(); }
      },
      profileSwitched: async (profileId) => {
        try { await options.session.profileSwitched(profileId); } finally { options.connectivity.markOffline(); }
      },
    },
    statuses: async () => {
      const statuses = await options.statuses();
      options.connectivity.observeStatuses(statuses);
      return statuses;
    },
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
    isOnline: options.connectivity.isOnline,
    uploads: options.uploads,
    notifications: { list: async () => mainUnavailableNotificationList() },
    onSessionScopeChanged: (scope, generation) => {
      activeGeneration = generation;
      if (!scope) {
        options.connectivity.markOffline();
        setNotificationSession(null);
        return;
      }
      if (generation !== activeGeneration) return;
      setNotificationSession(options.getNotificationSession?.(scope) ?? null);
    },
  });
}
