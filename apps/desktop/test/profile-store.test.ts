import { describe, expect, it, vi } from "vitest";

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

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

  it.each([
    ["https://OCC.TEST/", "https://occ.test"],
    ["HTTPS://occ.test", "https://occ.test"],
    ["https://occ.test:443/", "https://occ.test"],
  ])("accepts URL-normalizable root origin %s", (origin, expected) => {
    expect(parseServerProfile({ name: "Pilot", origin }, true).origin).toBe(
      expected,
    );
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
    ["backslash path", "https://occ.test\\api"],
    ["backslash authority", "https:\\\\occ.test"],
    ["extra authority slash", "https:////occ.test"],
    ["unsupported scheme", "ftp://occ.test"],
  ])("rejects an origin containing %s", (_case, origin) => {
    expect(() =>
      parseServerProfile({ name: "Pilot", origin }, false, true),
    ).toThrow();
  });

  it.each([
    "https://occ.test/a/..",
    "https://occ.test?",
    "https://OCC.TEST/",
    "HTTPS://occ.test",
    "https://occ.test:443",
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

  it("serializes concurrent saves against the latest committed state", async () => {
    const writes: unknown[] = [];
    const firstWrite = deferred();
    const secondWrite = deferred();
    const gates = [firstWrite, secondWrite];
    const store = await createProfileStore({
      read: async () => undefined,
      write: async (value) => {
        writes.push(structuredClone(value));
        return gates[writes.length - 1]!.promise;
      },
      packaged: true,
    });

    const firstSave = store.save({ name: "First", origin: "https://first.test" });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    const secondSave = store.save({
      name: "Second",
      origin: "https://second.test",
    });
    await Promise.resolve();
    expect(writes).toHaveLength(1);

    firstWrite.resolve();
    await firstSave;
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toEqual({
      profiles: [
        expect.objectContaining({ name: "First" }),
        expect.objectContaining({ name: "Second" }),
      ],
      selectedId: null,
    });
    secondWrite.resolve();
    await secondSave;
  });

  it("serializes select and remove without losing the selected profile", async () => {
    const first = parseServerProfile(
      { name: "First", origin: "https://first.test" },
      true,
    );
    const second = parseServerProfile(
      { name: "Second", origin: "https://second.test" },
      true,
    );
    const firstWrite = deferred();
    const secondWrite = deferred();
    const writes: unknown[] = [];
    const gates = [firstWrite, secondWrite];
    const store = await createProfileStore({
      read: async () => ({ profiles: [first, second], selectedId: first.id }),
      write: async (value) => {
        writes.push(structuredClone(value));
        return gates[writes.length - 1]!.promise;
      },
      packaged: true,
    });

    const selecting = store.select(second.id);
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    const removing = store.remove(first.id);
    await Promise.resolve();
    expect(writes).toHaveLength(1);

    firstWrite.resolve();
    await selecting;
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toEqual({ profiles: [second], selectedId: second.id });
    secondWrite.resolve();
    await removing;
    expect(store.selected()).toEqual(second);
  });

  it("continues queued mutations after a persistence failure", async () => {
    const failedWrite = deferred();
    const successfulWrite = deferred();
    const writes: unknown[] = [];
    const gates = [failedWrite, successfulWrite];
    const store = await createProfileStore({
      read: async () => undefined,
      write: async (value) => {
        writes.push(structuredClone(value));
        return gates[writes.length - 1]!.promise;
      },
      packaged: true,
    });

    const failedSave = store.save({ name: "Failed", origin: "https://failed.test" });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    const successfulSave = store.save({
      name: "Successful",
      origin: "https://successful.test",
    });
    await Promise.resolve();
    expect(writes).toHaveLength(1);

    failedWrite.reject(new Error("disk full"));
    await expect(failedSave).rejects.toThrow("disk full");
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toEqual({
      profiles: [expect.objectContaining({ name: "Successful" })],
      selectedId: null,
    });
    successfulWrite.resolve();
    await successfulSave;
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({ name: "Successful" }),
    ]);
  });

  it("fails safe when persisted profiles contain duplicate ids", async () => {
    const profile = parseServerProfile(
      { name: "Pilot", origin: "https://occ.test" },
      true,
    );
    const persistence = memoryPersistence({
      profiles: [profile, { ...profile, name: "Duplicate" }],
      selectedId: null,
    });
    const store = await createProfileStore({ ...persistence, packaged: true });

    await expect(store.list()).resolves.toEqual([]);
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
