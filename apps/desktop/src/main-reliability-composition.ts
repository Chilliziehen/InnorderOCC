import type { OccApi } from "./desktop-contract";
import { createDesktopApi, type DesktopApiDependencies } from "./desktop-ipc";
import { mainUnavailableNotificationList, mainUnavailableOperation } from "./main-operation-registry";
import type { NotificationSession } from "./notification-stream";
import type { ConnectivityTracker } from "./connectivity";

interface MainReliabilityCompositionOptions extends Pick<
  DesktopApiDependencies,
  "profiles" | "session" | "statuses" | "clearProfile" | "operationPolicy" | "workspaceQuery" | "executeCommand" | "notifications"
> {
  readonly readCache: NonNullable<DesktopApiDependencies["readCache"]>;
  readonly notificationStream: { setSession(session: NotificationSession | null): Promise<void> };
  readonly uploads: Pick<OccApi["uploads"], "preflight" | "begin" | "append" | "finish" | "cancel"> & {
    setScope?(scope: NotificationSession["scope"] | null): void;
    abortScope?(scope: NotificationSession["scope"]): Promise<void>;
    abortAll?(): Promise<void>;
  };
  readonly getCustomerInstanceId: () => string | null;
  readonly connectivity: ConnectivityTracker;
  readonly getNotificationSession?: (scope: NotificationSession["scope"]) => NotificationSession | null;
  readonly onBackgroundError?: (error: Error) => void;
}

export function createMainReliabilityApi(options: MainReliabilityCompositionOptions) {
  let activeGeneration = 0;
  const reportBackgroundError = () => {
    try { options.onBackgroundError?.(new Error("Notification session update failed")); } catch { /* Background reporting is contained. */ }
  };
  const setNotificationSession = (session: NotificationSession | null) => {
    let candidate = session;
    if (session) {
      if (!session.endpointAvailable) {
        candidate = null;
      } else {
        try {
          const origin = new URL(session.origin);
          if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
            reportBackgroundError();
            candidate = null;
          }
        } catch {
          reportBackgroundError();
          candidate = null;
        }
      }
    }
    const expectedGeneration = activeGeneration;
    try {
      void options.notificationStream.setSession(null).then(async () => {
        if (candidate && expectedGeneration === activeGeneration) await options.notificationStream.setSession(candidate);
      }).catch(reportBackgroundError);
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
    workspaceQuery: options.workspaceQuery ?? (async (input) => mainUnavailableOperation(input.workspace, input.operation, "/workspaces")),
    executeCommand: options.executeCommand ?? (async (input) => mainUnavailableOperation(input.workspace, input.operation, "/commands")),
    ...(options.operationPolicy ? { operationPolicy: options.operationPolicy } : {}),
    isOnline: options.connectivity.isOnline,
    uploads: options.uploads,
    ...(options.uploads.setScope && options.uploads.abortScope && options.uploads.abortAll ? {
      uploadLifecycle: { setScope: options.uploads.setScope, abortScope: options.uploads.abortScope, abortAll: options.uploads.abortAll },
    } : {}),
    notifications: options.notifications ?? { list: async () => mainUnavailableNotificationList() },
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
