import type { CurrentUser } from "@innorder/contracts";
import { describe, expect, it } from "vitest";

import type { ServerProfile } from "../src/desktop-contract";
import {
  type AppEvent,
  type AppState,
  canMutate,
  connectivity,
  freshnessAgeMs,
  initialAppState,
  reduceAppState,
} from "../src/renderer/app-controller";

const profileA: ServerProfile = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Pilot A",
  origin: "https://a.example.test",
  environment: "pilot",
};
const profileB: ServerProfile = {
  id: "00000000-0000-4000-8000-000000000002",
  name: "Pilot B",
  origin: "https://b.example.test",
  environment: "pilot",
};
const identity: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000003",
  username: "operator",
  displayName: "Operator",
  status: "ACTIVE",
  capabilities: ["occ.read", "occ.execute", "processes.start"],
};
const expiresAt = "2026-08-01T13:00:00.000Z";
const changedIdentity: CurrentUser = {
  ...identity,
  capabilities: ["occ.read", "processes.cancel"],
};

function loginState() {
  return reduceAppState(initialAppState, {
    type: "PROFILES_LOADED",
    profiles: [profileA, profileB],
    selectedProfileId: profileA.id,
  });
}

function onlineState() {
  return reduceAppState(loginState(), {
    type: "SESSION_RESTORED",
    session: { state: "authenticated", user: identity, expiresAt },
    at: 1_000,
  });
}

function bootstrapState() {
  return reduceAppState(initialAppState, {
    type: "PROFILES_LOADED",
    profiles: [profileA, profileB],
    selectedProfileId: null,
  });
}

function offlineState() {
  return reduceAppState(onlineState(), { type: "OFFLINE", at: 4_000 });
}

function reconnectingState() {
  return reduceAppState(offlineState(), { type: "ONLINE", at: 9_000 });
}

describe("application state", () => {
  it("moves from bootstrap to login when profiles load", () => {
    expect(initialAppState).toEqual({ mode: "bootstrap", profiles: [] });
    expect(loginState()).toMatchObject({
      mode: "login",
      profile: profileA,
      profiles: [profileA, profileB],
    });
  });

  it("handles restored and newly logged-in sessions as authenticated online state", () => {
    expect(onlineState()).toMatchObject({
      mode: "authenticated",
      profile: profileA,
      identity,
      lastFreshAt: 1_000,
    });
    expect(
      reduceAppState(loginState(), {
        type: "LOGIN_SUCCEEDED",
        session: { state: "authenticated", user: identity, expiresAt },
        at: 2_000,
      }),
    ).toMatchObject({ mode: "authenticated", lastFreshAt: 2_000 });
  });

  it("uses cached identity offline, reports age, and locks all mutations", () => {
    const offline = reduceAppState(onlineState(), { type: "OFFLINE", at: 4_000 });
    expect(offline).toMatchObject({
      mode: "offline",
      cachedIdentity: identity,
      staleSince: 4_000,
      lastFreshAt: 1_000,
    });
    expect(connectivity(offline)).toBe("offline");
    expect(freshnessAgeMs(offline, 8_000)).toBe(7_000);
    expect(canMutate(offline, "processes.start")).toBe(false);
    expect(canMutate(offline)).toBe(false);
  });

  it("keeps transport reconnection read-only until a fresh session replaces cached capabilities", () => {
    const offline = reduceAppState(onlineState(), { type: "OFFLINE", at: 4_000 });
    const reconnecting = reduceAppState(offline, { type: "ONLINE", at: 9_000 });

    expect(reconnecting).toMatchObject({
      mode: "reconnecting",
      cachedIdentity: identity,
      lastFreshAt: 1_000,
      staleSince: 4_000,
    });
    expect(connectivity(reconnecting)).toBe("checking");
    expect(freshnessAgeMs(reconnecting, 10_000)).toBe(9_000);
    expect(canMutate(reconnecting, "processes.start")).toBe(false);

    const validated = reduceAppState(reconnecting, {
      type: "SESSION_RESTORED",
      session: {
        state: "authenticated",
        user: changedIdentity,
        expiresAt: "2026-08-01T14:00:00.000Z",
      },
      at: 10_000,
    });
    expect(validated).toMatchObject({
      mode: "authenticated",
      identity: changedIdentity,
      lastFreshAt: 10_000,
    });
    expect(canMutate(validated, "processes.start")).toBe(false);
    expect(canMutate(validated, "processes.cancel")).toBe(true);
  });

  it("returns an expired cached session to login when transport reconnects", () => {
    const offline = reduceAppState(onlineState(), { type: "OFFLINE", at: 4_000 });
    expect(
      reduceAppState(offline, {
        type: "ONLINE",
        at: Date.parse(expiresAt) + 1,
      }),
    ).toEqual({
      mode: "login",
      profiles: [profileA, profileB],
      profile: profileA,
      notice: "expired",
    });
  });

  it("accepts a fresh login while reconnecting", () => {
    const offline = reduceAppState(onlineState(), { type: "OFFLINE", at: 4_000 });
    const reconnecting = reduceAppState(offline, { type: "ONLINE", at: 9_000 });
    const authenticated = reduceAppState(reconnecting, {
      type: "LOGIN_SUCCEEDED",
      session: {
        state: "authenticated",
        user: changedIdentity,
        expiresAt: "2026-08-01T14:00:00.000Z",
      },
      at: 10_000,
    });

    expect(authenticated).toMatchObject({
      mode: "authenticated",
      identity: changedIdentity,
      lastFreshAt: 10_000,
    });
  });

  it("allows mutation online only for an exact operation-specific capability", () => {
    const online = onlineState();
    expect(canMutate(online, "processes.start")).toBe(true);
    expect(canMutate(online, "processes.cancel")).toBe(false);
    expect(canMutate(online, "occ.execute")).toBe(false);
    expect(canMutate(online)).toBe(false);
  });

  it("does not refresh authenticated freshness from transport status alone", () => {
    const online = onlineState();
    expect(reduceAppState(online, { type: "ONLINE", at: 20_000 })).toBe(online);
    expect(freshnessAgeMs(online, 20_000)).toBe(19_000);
  });

  it("clears session and cached identity when the profile changes or is removed", () => {
    const selected = reduceAppState(onlineState(), {
      type: "PROFILE_SELECTED",
      profile: profileB,
    });
    expect(selected).toEqual({
      mode: "login",
      profiles: [profileA, profileB],
      profile: profileB,
    });

    const removed = reduceAppState(onlineState(), {
      type: "PROFILE_REMOVED",
      profileId: profileA.id,
    });
    expect(removed).toEqual({ mode: "bootstrap", profiles: [profileB] });
  });

  it("returns to login on logout and shows an expiry notice on expiry", () => {
    expect(reduceAppState(onlineState(), { type: "LOGOUT" })).toEqual({
      mode: "login",
      profiles: [profileA, profileB],
      profile: profileA,
    });
    expect(reduceAppState(onlineState(), { type: "SESSION_EXPIRED" })).toEqual({
      mode: "login",
      profiles: [profileA, profileB],
      profile: profileA,
      notice: "expired",
    });
  });

  it("tracks route state without turning denial or not-found into app modes", () => {
    const routed = reduceAppState(onlineState(), {
      type: "ROUTE_CHANGED",
      route: { path: "/risks", focusToken: 3 },
    });
    expect(routed).toMatchObject({
      mode: "authenticated",
      route: { path: "/risks", focusToken: 3 },
    });
  });

  it("keeps bootstrap stable when no profile is selected and ignores connectivity there", () => {
    const bootstrap = reduceAppState(initialAppState, {
      type: "PROFILES_LOADED",
      profiles: [profileA],
      selectedProfileId: null,
    });
    expect(bootstrap).toEqual({ mode: "bootstrap", profiles: [profileA] });
    expect(reduceAppState(bootstrap, { type: "OFFLINE", at: 1_000 })).toBe(bootstrap);
    expect(connectivity(bootstrap)).toBe("checking");
    expect(freshnessAgeMs(bootstrap, 2_000)).toBeNull();
  });

  describe("state and event matrix", () => {
    const states: Record<AppState["mode"], () => AppState> = {
      bootstrap: bootstrapState,
      login: loginState,
      authenticated: onlineState,
      offline: offlineState,
      reconnecting: reconnectingState,
    };
    type Expected = AppState["mode"] | "same";
    type MatrixCase = {
      name: string;
      event: AppEvent;
      expected: Record<AppState["mode"], Expected>;
      verify?: (result: AppState, sourceMode: AppState["mode"], expected: Expected) => void;
    };
    const unchanged = {
      bootstrap: "same",
      login: "same",
      authenticated: "same",
      offline: "same",
      reconnecting: "same",
    } as const;
    const matrix: MatrixCase[] = [
      {
        name: "profiles loaded",
        event: {
          type: "PROFILES_LOADED",
          profiles: [profileA, profileB],
          selectedProfileId: profileB.id,
        },
        expected: {
          bootstrap: "login",
          login: "login",
          authenticated: "login",
          offline: "login",
          reconnecting: "login",
        },
        verify(result) {
          expect(result).toMatchObject({ mode: "login", profile: profileB });
          expect(result).not.toHaveProperty("identity");
          expect(result).not.toHaveProperty("cachedIdentity");
        },
      },
      {
        name: "profile selected",
        event: { type: "PROFILE_SELECTED", profile: profileB },
        expected: {
          bootstrap: "login",
          login: "login",
          authenticated: "login",
          offline: "login",
          reconnecting: "login",
        },
        verify(result) {
          expect(result).toMatchObject({ mode: "login", profile: profileB });
          expect(result).not.toHaveProperty("identity");
          expect(result).not.toHaveProperty("cachedIdentity");
        },
      },
      {
        name: "active profile removed",
        event: { type: "PROFILE_REMOVED", profileId: profileA.id },
        expected: {
          bootstrap: "bootstrap",
          login: "bootstrap",
          authenticated: "bootstrap",
          offline: "bootstrap",
          reconnecting: "bootstrap",
        },
        verify(result) {
          expect(result.profiles).toEqual([profileB]);
          expect(result).not.toHaveProperty("identity");
          expect(result).not.toHaveProperty("cachedIdentity");
        },
      },
      {
        name: "anonymous session restored",
        event: { type: "SESSION_RESTORED", session: { state: "anonymous" }, at: 10_000 },
        expected: {
          ...unchanged,
          login: "login",
          reconnecting: "login",
        },
        verify(result) {
          if (result.mode === "login") {
            expect(result.notice).toBeUndefined();
            expect(result).not.toHaveProperty("cachedIdentity");
          }
        },
      },
      {
        name: "authenticated session restored",
        event: {
          type: "SESSION_RESTORED",
          session: { state: "authenticated", user: changedIdentity, expiresAt },
          at: 10_000,
        },
        expected: {
          ...unchanged,
          login: "authenticated",
          reconnecting: "authenticated",
        },
        verify(result) {
          if (result.mode === "authenticated" && result.lastFreshAt === 10_000) {
            expect(result.identity).toBe(changedIdentity);
          }
        },
      },
      {
        name: "login succeeded",
        event: {
          type: "LOGIN_SUCCEEDED",
          session: { state: "authenticated", user: changedIdentity, expiresAt },
          at: 10_000,
        },
        expected: {
          ...unchanged,
          login: "authenticated",
          reconnecting: "authenticated",
        },
        verify(result) {
          if (result.mode === "authenticated" && result.lastFreshAt === 10_000) {
            expect(result.identity).toBe(changedIdentity);
          }
        },
      },
      {
        name: "logout",
        event: { type: "LOGOUT" },
        expected: {
          ...unchanged,
          authenticated: "login",
          offline: "login",
          reconnecting: "login",
        },
        verify(result) {
          if (result.mode === "login") expect(result.notice).toBeUndefined();
        },
      },
      {
        name: "session expired",
        event: { type: "SESSION_EXPIRED" },
        expected: {
          ...unchanged,
          authenticated: "login",
          offline: "login",
          reconnecting: "login",
        },
        verify(result, _sourceMode, expected) {
          if (result.mode === "login" && expected !== "same") {
            expect(result.notice).toBe("expired");
          }
        },
      },
      {
        name: "transport online",
        event: { type: "ONLINE", at: 10_000 },
        expected: {
          ...unchanged,
          offline: "reconnecting",
        },
      },
      {
        name: "transport offline",
        event: { type: "OFFLINE", at: 10_000 },
        expected: {
          ...unchanged,
          authenticated: "offline",
          reconnecting: "offline",
        },
      },
      {
        name: "route changed",
        event: { type: "ROUTE_CHANGED", route: { path: "/system", focusToken: 8 } },
        expected: {
          bootstrap: "bootstrap",
          login: "login",
          authenticated: "authenticated",
          offline: "offline",
          reconnecting: "reconnecting",
        },
        verify(result) {
          expect(result.route).toEqual({ path: "/system", focusToken: 8 });
        },
      },
    ];

    for (const testCase of matrix) {
      for (const [mode, createState] of Object.entries(states) as Array<
        [AppState["mode"], () => AppState]
      >) {
        it(`${testCase.name} from ${mode}`, () => {
          const state = createState();
          const result = reduceAppState(state, testCase.event);
          const expected = testCase.expected[mode];
          if (expected === "same") expect(result).toBe(state);
          else expect(result.mode).toBe(expected);
          testCase.verify?.(result, mode, expected);
        });
      }
    }
  });
});
