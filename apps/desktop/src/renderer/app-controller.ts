import type { CurrentUser } from "@innorder/contracts";

import type { ServerProfile, SessionSnapshot } from "../desktop-contract";
import type { RouteLocation } from "./routes";

interface RoutedState {
  route?: RouteLocation;
  sessionGeneration: number;
  sessionOperation: SessionOperation | null;
}

export type SessionOperation = "restore" | "login";

export interface BootstrapState extends RoutedState {
  mode: "bootstrap";
  profiles: ServerProfile[];
}

export interface LoginState extends RoutedState {
  mode: "login";
  profiles: ServerProfile[];
  profile: ServerProfile;
  notice?: "expired";
}

export interface AuthenticatedState extends RoutedState {
  mode: "authenticated";
  profiles: ServerProfile[];
  profile: ServerProfile;
  identity: CurrentUser;
  expiresAt: string;
  lastFreshAt: number;
}

export interface OfflineState extends RoutedState {
  mode: "offline";
  profiles: ServerProfile[];
  profile: ServerProfile;
  cachedIdentity: CurrentUser;
  expiresAt: string;
  lastFreshAt: number;
  staleSince: number;
}

export interface ReconnectingState extends RoutedState {
  mode: "reconnecting";
  profiles: ServerProfile[];
  profile: ServerProfile;
  cachedIdentity: CurrentUser;
  expiresAt: string;
  lastFreshAt: number;
  staleSince: number;
}

export type AppState =
  | BootstrapState
  | LoginState
  | AuthenticatedState
  | OfflineState
  | ReconnectingState;

export type AppEvent =
  | {
      type: "PROFILES_LOADED";
      profiles: ServerProfile[];
      selectedProfileId: string | null;
    }
  | { type: "PROFILE_SELECTED"; profile: ServerProfile }
  | { type: "PROFILE_REMOVED"; profileId: string }
  | {
      type: "SESSION_OPERATION_STARTED";
      operation: SessionOperation;
      profileId: string;
      generation: number;
    }
  | {
      type: "SESSION_RESTORED";
      profileId: string;
      generation: number;
      session: SessionSnapshot;
      at: number;
    }
  | {
      type: "LOGIN_SUCCEEDED";
      profileId: string;
      generation: number;
      session: Extract<SessionSnapshot, { state: "authenticated" }>;
      at: number;
    }
  | { type: "LOGOUT"; profileId: string; generation: number }
  | { type: "SESSION_EXPIRED"; profileId: string; generation: number }
  | { type: "ONLINE"; at: number }
  | { type: "OFFLINE"; at: number }
  | { type: "ROUTE_CHANGED"; route: RouteLocation };

export const initialAppState: AppState = {
  mode: "bootstrap",
  profiles: [],
  sessionGeneration: 0,
  sessionOperation: null,
};

function loginFor(
  state: AppState,
  profile: ServerProfile,
  notice?: LoginState["notice"],
  invalidate = false,
): LoginState {
  return {
    mode: "login",
    profiles: state.profiles,
    profile,
    sessionGeneration: state.sessionGeneration + (invalidate ? 1 : 0),
    sessionOperation: null,
    ...(notice ? { notice } : {}),
    ...(state.route ? { route: state.route } : {}),
  };
}

function authenticate(
  state: LoginState | ReconnectingState,
  session: Extract<SessionSnapshot, { state: "authenticated" }>,
  at: number,
): AuthenticatedState {
  return {
    mode: "authenticated",
    profiles: state.profiles,
    profile: state.profile,
    identity: session.user,
    expiresAt: session.expiresAt,
    lastFreshAt: at,
    sessionGeneration: state.sessionGeneration,
    sessionOperation: null,
    ...(state.route ? { route: state.route } : {}),
  };
}

function currentProfile(state: AppState): ServerProfile | null {
  return state.mode === "bootstrap" ? null : state.profile;
}

function matchesSessionResult(
  state: AppState,
  event: { profileId: string; generation: number },
  operation: SessionOperation,
): state is LoginState | ReconnectingState {
  return (state.mode === "login" || state.mode === "reconnecting") &&
    state.profile.id === event.profileId &&
    state.sessionGeneration === event.generation &&
    state.sessionOperation === operation;
}

function matchesCurrentSession(
  state: AppState,
  event: { profileId: string; generation: number },
): state is AuthenticatedState | OfflineState | ReconnectingState {
  return (state.mode === "authenticated" ||
    state.mode === "offline" ||
    state.mode === "reconnecting") &&
    state.profile.id === event.profileId &&
    state.sessionGeneration === event.generation;
}

function assertNever(event: never): never {
  throw new Error(`Unhandled app event: ${JSON.stringify(event)}`);
}

export function reduceAppState(state: AppState, event: AppEvent): AppState {
  switch (event.type) {
    case "PROFILES_LOADED": {
      const profile = event.selectedProfileId === null
        ? undefined
        : event.profiles.find(({ id }) => id === event.selectedProfileId);
      return profile
        ? {
            mode: "login",
            profiles: event.profiles,
            profile,
            sessionGeneration: state.sessionGeneration + 1,
            sessionOperation: null,
            ...(state.route ? { route: state.route } : {}),
          }
        : {
            mode: "bootstrap",
            profiles: event.profiles,
            sessionGeneration: state.sessionGeneration + 1,
            sessionOperation: null,
            ...(state.route ? { route: state.route } : {}),
          };
    }
    case "PROFILE_SELECTED":
      return {
        mode: "login",
        profiles: state.profiles,
        profile: event.profile,
        sessionGeneration: state.sessionGeneration + 1,
        sessionOperation: null,
        ...(state.route ? { route: state.route } : {}),
      };
    case "PROFILE_REMOVED": {
      const profiles = state.profiles.filter(({ id }) => id !== event.profileId);
      if (currentProfile(state)?.id === event.profileId) {
        return {
          mode: "bootstrap",
          profiles,
          sessionGeneration: state.sessionGeneration + 1,
          sessionOperation: null,
          ...(state.route ? { route: state.route } : {}),
        };
      }
      return { ...state, profiles };
    }
    case "SESSION_OPERATION_STARTED":
      if (
        (state.mode !== "login" && state.mode !== "reconnecting") ||
        state.profile.id !== event.profileId ||
        !Number.isSafeInteger(event.generation) ||
        event.generation <= state.sessionGeneration
      ) return state;
      return {
        ...state,
        sessionGeneration: event.generation,
        sessionOperation: event.operation,
      };
    case "SESSION_RESTORED":
      if (!matchesSessionResult(state, event, "restore")) return state;
      if (event.session.state === "anonymous") return loginFor(state, state.profile);
      return Date.parse(event.session.expiresAt) > event.at
        ? authenticate(state, event.session, event.at)
        : loginFor(state, state.profile, "expired", true);
    case "LOGIN_SUCCEEDED":
      if (!matchesSessionResult(state, event, "login")) return state;
      return Date.parse(event.session.expiresAt) > event.at
        ? authenticate(state, event.session, event.at)
        : loginFor(state, state.profile, "expired", true);
    case "LOGOUT":
      return matchesCurrentSession(state, event)
        ? loginFor(state, state.profile, undefined, true)
        : state;
    case "SESSION_EXPIRED":
      return matchesCurrentSession(state, event)
        ? loginFor(state, state.profile, "expired", true)
        : state;
    case "OFFLINE":
      if (state.mode === "offline") return state;
      if (state.mode === "reconnecting") {
        return { ...state, mode: "offline" };
      }
      if (state.mode !== "authenticated") return state;
      return {
        mode: "offline",
        profiles: state.profiles,
        profile: state.profile,
        cachedIdentity: state.identity,
        expiresAt: state.expiresAt,
        lastFreshAt: state.lastFreshAt,
        staleSince: event.at,
        sessionGeneration: state.sessionGeneration,
        sessionOperation: null,
        ...(state.route ? { route: state.route } : {}),
      };
    case "ONLINE":
      if (state.mode !== "offline" && state.mode !== "reconnecting") return state;
      if (Date.parse(state.expiresAt) <= event.at) {
        return loginFor(state, state.profile, "expired", true);
      }
      if (state.mode === "reconnecting") return state;
      return {
        mode: "reconnecting",
        profiles: state.profiles,
        profile: state.profile,
        cachedIdentity: state.cachedIdentity,
        expiresAt: state.expiresAt,
        lastFreshAt: state.lastFreshAt,
        staleSince: state.staleSince,
        sessionGeneration: state.sessionGeneration,
        sessionOperation: state.sessionOperation,
        ...(state.route ? { route: state.route } : {}),
      };
    case "ROUTE_CHANGED":
      return { ...state, route: event.route };
    default:
      return assertNever(event);
  }
}

export function connectivity(state: AppState): "checking" | "online" | "offline" {
  if (state.mode === "authenticated") return "online";
  if (state.mode === "offline") return "offline";
  return "checking";
}

export function freshnessAgeMs(state: AppState, now = Date.now()): number | null {
  if (
    state.mode !== "authenticated" &&
    state.mode !== "offline" &&
    state.mode !== "reconnecting"
  ) return null;
  return Math.max(0, now - state.lastFreshAt);
}

const COARSE_CAPABILITIES = new Set(["occ.read", "occ.execute", "occ.admin"]);

export function canMutate(state: AppState, requiredCapability?: string): boolean {
  return state.mode === "authenticated" &&
    requiredCapability !== undefined &&
    !COARSE_CAPABILITIES.has(requiredCapability) &&
    state.identity.capabilities.includes(requiredCapability);
}
