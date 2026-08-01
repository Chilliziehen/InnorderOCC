import type { CurrentUser } from "@innorder/contracts";
import { describe, expect, it } from "vitest";

import type { ServerProfile } from "../src/desktop-contract";
import {
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

    const reconnected = reduceAppState(offline, { type: "ONLINE", at: 9_000 });
    expect(reconnected).toMatchObject({
      mode: "authenticated",
      identity,
      lastFreshAt: 9_000,
    });
  });

  it("allows mutation online only for an exact operation-specific capability", () => {
    const online = onlineState();
    expect(canMutate(online, "processes.start")).toBe(true);
    expect(canMutate(online, "processes.cancel")).toBe(false);
    expect(canMutate(online, "occ.execute")).toBe(false);
    expect(canMutate(online)).toBe(false);
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
});
