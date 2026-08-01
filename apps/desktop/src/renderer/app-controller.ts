import type { CurrentUser } from "@innorder/contracts";

import type { ServerProfile, SessionSnapshot } from "../desktop-contract";
import type { RouteLocation } from "./routes";

interface RoutedState {
  route?: RouteLocation;
}

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

export type AppState =
  | BootstrapState
  | LoginState
  | AuthenticatedState
  | OfflineState;

export type AppEvent =
  | {
      type: "PROFILES_LOADED";
      profiles: ServerProfile[];
      selectedProfileId: string | null;
    }
  | { type: "PROFILE_SELECTED"; profile: ServerProfile }
  | { type: "PROFILE_REMOVED"; profileId: string }
  | { type: "SESSION_RESTORED"; session: SessionSnapshot; at: number }
  | {
      type: "LOGIN_SUCCEEDED";
      session: Extract<SessionSnapshot, { state: "authenticated" }>;
      at: number;
    }
  | { type: "LOGOUT" }
  | { type: "SESSION_EXPIRED" }
  | { type: "ONLINE"; at: number }
  | { type: "OFFLINE"; at: number }
  | { type: "ROUTE_CHANGED"; route: RouteLocation };

export const initialAppState: AppState = { mode: "bootstrap", profiles: [] };

function loginFor(
  state: AppState,
  profile: ServerProfile,
  notice?: LoginState["notice"],
): LoginState {
  return {
    mode: "login",
    profiles: state.profiles,
    profile,
    ...(notice ? { notice } : {}),
    ...(state.route ? { route: state.route } : {}),
  };
}

function authenticate(
  state: LoginState,
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
    ...(state.route ? { route: state.route } : {}),
  };
}

function currentProfile(state: AppState): ServerProfile | null {
  return state.mode === "bootstrap" ? null : state.profile;
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
            ...(state.route ? { route: state.route } : {}),
          }
        : {
            mode: "bootstrap",
            profiles: event.profiles,
            ...(state.route ? { route: state.route } : {}),
          };
    }
    case "PROFILE_SELECTED":
      return {
        mode: "login",
        profiles: state.profiles,
        profile: event.profile,
        ...(state.route ? { route: state.route } : {}),
      };
    case "PROFILE_REMOVED": {
      const profiles = state.profiles.filter(({ id }) => id !== event.profileId);
      if (currentProfile(state)?.id === event.profileId) {
        return {
          mode: "bootstrap",
          profiles,
          ...(state.route ? { route: state.route } : {}),
        };
      }
      return { ...state, profiles };
    }
    case "SESSION_RESTORED":
      if (state.mode !== "login") return state;
      return event.session.state === "authenticated"
        ? authenticate(state, event.session, event.at)
        : loginFor(state, state.profile);
    case "LOGIN_SUCCEEDED":
      return state.mode === "login"
        ? authenticate(state, event.session, event.at)
        : state;
    case "LOGOUT":
      return state.mode === "authenticated" || state.mode === "offline"
        ? loginFor(state, state.profile)
        : state;
    case "SESSION_EXPIRED":
      return state.mode === "authenticated" || state.mode === "offline"
        ? loginFor(state, state.profile, "expired")
        : state;
    case "OFFLINE":
      if (state.mode === "offline") return state;
      if (state.mode !== "authenticated") return state;
      return {
        mode: "offline",
        profiles: state.profiles,
        profile: state.profile,
        cachedIdentity: state.identity,
        expiresAt: state.expiresAt,
        lastFreshAt: state.lastFreshAt,
        staleSince: event.at,
        ...(state.route ? { route: state.route } : {}),
      };
    case "ONLINE":
      if (state.mode === "authenticated") {
        return { ...state, lastFreshAt: event.at };
      }
      if (state.mode !== "offline") return state;
      return {
        mode: "authenticated",
        profiles: state.profiles,
        profile: state.profile,
        identity: state.cachedIdentity,
        expiresAt: state.expiresAt,
        lastFreshAt: event.at,
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
  if (state.mode !== "authenticated" && state.mode !== "offline") return null;
  return Math.max(0, now - state.lastFreshAt);
}

const COARSE_CAPABILITIES = new Set(["occ.read", "occ.execute", "occ.admin"]);

export function canMutate(state: AppState, requiredCapability?: string): boolean {
  return state.mode === "authenticated" &&
    requiredCapability !== undefined &&
    !COARSE_CAPABILITIES.has(requiredCapability) &&
    state.identity.capabilities.includes(requiredCapability);
}
