import { ConfigProvider } from "antd";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { SystemStatus } from "@innorder/contracts";

import type { LoginInput, ProfileInput, ServerProfile, SessionSnapshot } from "../desktop-contract";
import {
  initialAppState,
  reduceAppState,
  type AppEvent,
  type AppState,
} from "./app-controller";
import { AppShell } from "./components/AppShell";
import { Login } from "./components/Login";
import { ProfileBootstrap } from "./components/ProfileBootstrap";
import { createHashRouter } from "./routes";
import { startStatusPolling } from "./status-client";

function nextGeneration(state: AppState): number {
  return state.sessionGeneration + 1;
}

export function App() {
  const [state, dispatch] = useReducer(reduceAppState, initialAppState);
  const stateRef = useRef(state);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [statuses, setStatuses] = useState<{
    profileId: string;
    generation: number;
    values: SystemStatus[];
  } | null>(null);
  const routerRef = useRef<ReturnType<typeof createHashRouter> | null>(null);
  stateRef.current = state;

  const dispatchEvent = useCallback((event: AppEvent) => {
    stateRef.current = reduceAppState(stateRef.current, event);
    dispatch(event);
  }, []);

  const restore = useCallback(async (profile: ServerProfile, generation: number) => {
    dispatchEvent({
      type: "SESSION_OPERATION_STARTED",
      operation: "restore",
      profileId: profile.id,
      generation,
    });
    try {
      const session = await window.occ.session.restore();
      dispatchEvent({
        type: "SESSION_RESTORED",
        profileId: profile.id,
        generation,
        session,
        at: Date.now(),
      });
    } catch {
      dispatchEvent({
        type: "SESSION_OPERATION_FAILED",
        operation: "restore",
        profileId: profile.id,
        generation,
      });
    }
  }, [dispatchEvent]);

  const initialize = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const [profiles, profile] = await Promise.all([
        window.occ.profiles.list(),
        window.occ.profiles.current(),
      ]);
      dispatchEvent({
        type: "PROFILES_LOADED",
        profiles,
        selectedProfileId: profile?.id ?? null,
      });
      if (profile) {
        await restore(profile, nextGeneration(stateRef.current));
      }
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [dispatchEvent, restore]);

  useEffect(() => {
    const router = createHashRouter();
    routerRef.current = router;
    dispatchEvent({ type: "ROUTE_CHANGED", route: router.get() });
    const dispose = router.subscribe((route) => dispatchEvent({ type: "ROUTE_CHANGED", route }));
    void initialize();
    return () => {
      dispose();
      routerRef.current = null;
    };
  }, [dispatchEvent, initialize]);

  useEffect(() => {
    const offline = () => dispatchEvent({ type: "OFFLINE", at: Date.now() });
    const online = () => dispatchEvent({ type: "ONLINE", at: Date.now() });
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [dispatchEvent]);

  useEffect(() => {
    if (state.mode !== "reconnecting" || state.sessionOperation !== null || state.retryAvailable) return;
    void restore(state.profile, nextGeneration(state));
  }, [restore, state]);

  useEffect(() => {
    if (state.mode !== "authenticated" && state.mode !== "offline" && state.mode !== "reconnecting") return;
    const expiresAt = Date.parse(state.expiresAt);
    let timer: number | undefined;
    const schedule = () => {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        dispatchEvent({
          type: "SESSION_EXPIRED",
          profileId: state.profile.id,
          generation: state.sessionGeneration,
        });
        return;
      }
      timer = window.setTimeout(schedule, Math.min(remaining, 2_147_483_647));
    };
    schedule();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [dispatchEvent, state]);

  const statusProfileId = state.mode === "bootstrap" || state.mode === "login"
    ? null
    : state.profile.id;
  const statusGeneration = state.mode === "bootstrap" || state.mode === "login"
    ? null
    : state.sessionGeneration;

  useEffect(() => {
    if (statusProfileId === null || statusGeneration === null) {
      setStatuses(null);
      return;
    }
    const profileId = statusProfileId;
    const generation = statusGeneration;
    setStatuses({ profileId, generation, values: [] });
    return startStatusPolling((sample) => {
      const current = stateRef.current;
      if (
        (current.mode !== "authenticated" && current.mode !== "offline" && current.mode !== "reconnecting") ||
        current.profile.id !== profileId ||
        current.sessionGeneration !== generation
      ) return;
      setStatuses({ profileId, generation, values: sample.statuses });
      dispatchEvent({
        type: sample.successful && sample.coreReachable
          ? "STATUS_REACHABLE"
          : "STATUS_UNREACHABLE",
        profileId,
        generation,
        at: sample.polledAt,
      });
    });
  }, [dispatchEvent, statusGeneration, statusProfileId]);

  const selectProfile = async (profile: ServerProfile) => {
    await window.occ.profiles.select(profile.id);
    dispatchEvent({ type: "PROFILE_SELECTED", profile });
    await restore(profile, nextGeneration(stateRef.current));
  };

  const saveProfile = async (input: ProfileInput) => {
    const current = stateRef.current;
    if (current.mode === "offline" || current.mode === "reconnecting") {
      throw new Error("Profile changes unavailable");
    }
    const profile = await window.occ.profiles.save(input);
    await window.occ.profiles.select(profile.id);
    const profiles = stateRef.current.profiles.some(({ id }) => id === profile.id)
      ? stateRef.current.profiles.map((item) => item.id === profile.id ? profile : item)
      : [...stateRef.current.profiles, profile];
    dispatchEvent({ type: "PROFILES_LOADED", profiles, selectedProfileId: profile.id });
    await restore(profile, nextGeneration(stateRef.current));
    return profile;
  };

  const login = async (input: LoginInput): Promise<SessionSnapshot> => {
    const current = stateRef.current;
    if (current.mode !== "login") throw new Error("Login unavailable");
    const generation = nextGeneration(current);
    const profileId = current.profile.id;
    dispatchEvent({ type: "SESSION_OPERATION_STARTED", operation: "login", profileId, generation });
    const session = await window.occ.session.login(input);
    if (session.state !== "authenticated") throw new Error("Login failed");
    dispatchEvent({ type: "LOGIN_SUCCEEDED", profileId, generation, session, at: Date.now() });
    return session;
  };

  const logout = async () => {
    const current = stateRef.current;
    if (current.mode !== "authenticated" && current.mode !== "offline" && current.mode !== "reconnecting") return;
    const profileId = current.profile.id;
    const generation = current.sessionGeneration;
    try {
      await window.occ.session.logout();
    } catch {
      // Main clears local credentials even if server revocation is unavailable.
    } finally {
      dispatchEvent({ type: "LOGOUT", profileId, generation });
    }
  };

  const retryRestore = () => {
    const current = stateRef.current;
    if (current.mode !== "reconnecting" || current.sessionOperation !== null) return;
    void restore(current.profile, nextGeneration(current));
  };

  let content;
  if (loading) {
    content = <main className="entry-screen" aria-busy="true"><p role="status">正在加载服务器配置…</p></main>;
  } else if (loadFailed) {
    content = (
      <main className="entry-screen">
        <section className="entry-panel"><p className="form-error" role="alert">无法加载服务器配置。</p><button className="primary-action" type="button" onClick={() => void initialize()}>重试</button></section>
      </main>
    );
  } else if (state.mode === "bootstrap") {
    content = <main className="entry-screen"><ProfileBootstrap profiles={state.profiles} onSave={saveProfile} onSelect={selectProfile} /></main>;
  } else if (state.mode === "login") {
    content = (
      <main className="entry-screen">
        <Login
          profile={state.profile}
          profiles={state.profiles}
          {...(state.notice ? { notice: state.notice } : {})}
          onProfileSelect={selectProfile}
          onSubmit={login}
        />
      </main>
    );
  } else {
    const visibleStatuses = statuses?.profileId === state.profile.id &&
      statuses.generation === state.sessionGeneration
      ? statuses.values
      : [];
    content = (
      <AppShell
        state={state}
        statuses={visibleStatuses}
        onLogout={logout}
        onProfileSelect={selectProfile}
        onProfileSave={saveProfile}
        onRetry={retryRestore}
      />
    );
  }

  return (
    <ConfigProvider theme={{ token: {
      colorPrimary: "#146c68",
      borderRadius: 6,
      fontFamily: 'Inter, "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif',
    } }}>
      {content}
    </ConfigProvider>
  );
}
