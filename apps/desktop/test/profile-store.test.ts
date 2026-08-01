import { describe, expect, it } from "vitest";

import {
  parseServerProfile,
  serverProfileSchema,
} from "../src/desktop-contract";
import { createProfileStore } from "../src/profile-store";

function memoryPersistence(initial?: unknown) {
  let value = initial;

  return {
    read: async () => value,
    write: async (next: unknown) => {
      value = structuredClone(next);
    },
    current: () => value,
  };
}

describe("server profile validation", () => {
  it("accepts and normalizes an HTTPS root origin", () => {
    const profile = parseServerProfile(
      { name: "  Pilot  ", origin: "https://occ.test/" },
      true,
    );

    expect(profile).toMatchObject({
      id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      name: "Pilot",
      origin: "https://occ.test",
      environment: "pilot",
    });
  });

  it("normalizes a SHA-256 CA fingerprint to uppercase hex", () => {
    const profile = parseServerProfile(
      {
        name: "Production",
        origin: "https://occ.example",
        environment: "production",
        caFingerprint: "ab:".repeat(31) + "ab",
      },
      true,
    );

    expect(profile.caFingerprint).toBe("AB".repeat(32));
  });

  it("accepts an unseparated SHA-256 CA fingerprint", () => {
    const profile = parseServerProfile(
      {
        name: "Production",
        origin: "https://occ.example",
        caFingerprint: "ab".repeat(32),
      },
      true,
    );

    expect(profile.caFingerprint).toBe("AB".repeat(32));
  });

  it.each([
    "A:" + "AA".repeat(31) + "A",
    "AA".repeat(16) + ":" + "AA".repeat(16),
    "AA::" + "AA:".repeat(30) + "AA",
  ])("rejects malformed fingerprint separators", (caFingerprint) => {
    expect(() =>
      parseServerProfile(
        { name: "Pilot", origin: "https://occ.test", caFingerprint },
        true,
      ),
    ).toThrow("Invalid SHA-256 CA fingerprint");
  });

  it.each([
    ["credentials", "https://user:password@occ.test"],
    ["path", "https://occ.test/api"],
    ["normalized path", "https://occ.test/a/.."],
    ["encoded normalized path", "https://occ.test/%2e"],
    ["query", "https://occ.test/?token=secret"],
    ["empty query", "https://occ.test?"],
    ["fragment", "https://occ.test/#secret"],
    ["empty fragment", "https://occ.test#"],
    ["unsupported scheme", "ftp://occ.test"],
  ])("rejects an origin containing %s", (_case, origin) => {
    expect(() =>
      parseServerProfile({ name: "Pilot", origin }, false, true),
    ).toThrow();
  });

  it.each([
    "https://occ.test/a/..",
    "https://occ.test?",
    "ftp://occ.test",
  ])("applies strict origin validation to persisted profile %s", (origin) => {
    expect(
      serverProfileSchema.safeParse({
        id: crypto.randomUUID(),
        name: "Pilot",
        origin,
        environment: "pilot",
      }).success,
    ).toBe(false);
  });

  it("rejects HTTP when packaged", () => {
    expect(() =>
      parseServerProfile(
        { name: "Dev", origin: "http://127.0.0.1:8080" },
        true,
        true,
      ),
    ).toThrow("HTTPS is required");
  });

  it("rejects HTTP unless the development gate is enabled", () => {
    expect(() =>
      parseServerProfile(
        { name: "Dev", origin: "http://localhost:8080" },
        false,
        false,
      ),
    ).toThrow("HTTPS is required");
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "accepts development HTTP for loopback host %s when both gates allow it",
    (hostname) => {
      const profile = parseServerProfile(
        { name: "Dev", origin: `http://${hostname}:8080/` },
        false,
        true,
      );

      expect(profile.environment).toBe("development");
      expect(profile.origin).toBe(`http://${hostname}:8080`);
    },
  );

  it("rejects development HTTP for a non-loopback hostname", () => {
    expect(() =>
      parseServerProfile(
        { name: "Dev", origin: "http://dev.occ.test" },
        false,
        true,
      ),
    ).toThrow("HTTPS is required");
  });
});

describe("profile store", () => {
  it("persists only validated non-secret profile fields", async () => {
    const persistence = memoryPersistence();
    const store = await createProfileStore({
      ...persistence,
      packaged: true,
    });

    const profile = await store.save({
      name: "Pilot",
      origin: "https://occ.test",
      environment: "pilot",
      password: "must-not-persist",
      tlsBypass: true,
    } as never);

    expect(persistence.current()).toEqual({
      profiles: [profile],
      selectedId: null,
    });
    expect(JSON.stringify(persistence.current())).not.toContain("password");
    expect(JSON.stringify(persistence.current())).not.toContain("tlsBypass");
  });

  it("updates a profile while preserving its stable id", async () => {
    const persistence = memoryPersistence();
    const store = await createProfileStore({ ...persistence, packaged: true });
    const saved = await store.save({
      name: "Pilot",
      origin: "https://occ.test",
    });

    const updated = await store.save({
      id: saved.id,
      name: "Production",
      origin: "https://occ.example",
      environment: "production",
    });

    expect(updated.id).toBe(saved.id);
    await expect(store.list()).resolves.toEqual([updated]);
  });

  it("selects known profiles, rejects unknown ids, and clears removed selection", async () => {
    const persistence = memoryPersistence();
    const store = await createProfileStore({ ...persistence, packaged: true });
    const saved = await store.save({
      name: "Pilot",
      origin: "https://occ.test",
    });

    await store.select(saved.id);
    expect(store.selected()).toEqual(saved);
    await expect(store.select(crypto.randomUUID())).rejects.toThrow(
      "Unknown profile",
    );

    await store.remove(saved.id);
    expect(store.selected()).toBeUndefined();
    await expect(store.list()).resolves.toEqual([]);
    expect(persistence.current()).toEqual({ profiles: [], selectedId: null });
  });

  it("does not expose mutable internal profile references", async () => {
    const persistence = memoryPersistence();
    const store = await createProfileStore({ ...persistence, packaged: true });
    const saved = await store.save({
      name: "Pilot",
      origin: "https://occ.test",
    });

    saved.name = "Mutated";
    const listed = await store.list();
    listed[0]!.name = "Also mutated";

    expect(store.selected()).toBeUndefined();
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({ name: "Pilot" }),
    ]);
  });

  it("does not add a profile when persistence rejects save", async () => {
    const store = await createProfileStore({
      read: async () => undefined,
      write: async () => Promise.reject(new Error("disk full")),
      packaged: true,
    });

    await expect(
      store.save({ name: "Pilot", origin: "https://occ.test" }),
    ).rejects.toThrow("disk full");
    await expect(store.list()).resolves.toEqual([]);
  });

  it("does not change selection when persistence rejects select", async () => {
    const first = parseServerProfile(
      { name: "First", origin: "https://first.test" },
      true,
    );
    const second = parseServerProfile(
      { name: "Second", origin: "https://second.test" },
      true,
    );
    const store = await createProfileStore({
      read: async () => ({ profiles: [first, second], selectedId: first.id }),
      write: async () => Promise.reject(new Error("disk full")),
      packaged: true,
    });

    await expect(store.select(second.id)).rejects.toThrow("disk full");
    expect(store.selected()).toEqual(first);
  });

  it("does not remove a profile when persistence rejects remove", async () => {
    const profile = parseServerProfile(
      { name: "Pilot", origin: "https://occ.test" },
      true,
    );
    const store = await createProfileStore({
      read: async () => ({ profiles: [profile], selectedId: profile.id }),
      write: async () => Promise.reject(new Error("disk full")),
      packaged: true,
    });

    await expect(store.remove(profile.id)).rejects.toThrow("disk full");
    await expect(store.list()).resolves.toEqual([profile]);
    expect(store.selected()).toEqual(profile);
  });

  it.each([
    "not-json-data",
    { profiles: [{ id: "bad", name: "Bad", origin: "http://remote" }] },
    { profiles: [], selectedId: crypto.randomUUID() },
  ])("fails safe when persisted data is corrupt", async (initial) => {
    const persistence = memoryPersistence(initial);
    const store = await createProfileStore({ ...persistence, packaged: true });

    await expect(store.list()).resolves.toEqual([]);
    expect(store.selected()).toBeUndefined();
  });
});
