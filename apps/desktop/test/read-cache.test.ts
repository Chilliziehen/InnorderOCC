import { describe, expect, it, vi } from "vitest";

import {
  createReadCache,
  type ReadCachePersistence,
  type ReadCacheScope,
} from "../src/read-cache";
import type { WorkspaceQuery, WorkspaceResult } from "../src/desktop-contract";
import { CoreClientError } from "../src/core-client";

const profileA = "11111111-1111-4111-8111-111111111111";
const profileB = "22222222-2222-4222-8222-222222222222";
const customerA = "33333333-3333-4333-8333-333333333333";
const customerB = "44444444-4444-4444-8444-444444444444";
const principalA = "55555555-5555-4555-8555-555555555555";
const principalB = "66666666-6666-4666-8666-666666666666";
const fetchedAt = "2026-08-02T00:00:00.000Z";

const scope = (overrides: Partial<ReadCacheScope> = {}): ReadCacheScope => ({
  profileId: profileA,
  customerInstanceId: customerA,
  principalId: principalA,
  ...overrides,
});
const query = (overrides: Partial<WorkspaceQuery> = {}): WorkspaceQuery => ({
  workspace: "risks",
  operation: "risks.query",
  filters: { status: "open", priority: ["high", "critical"] },
  sort: { field: "createdAt", direction: "desc" },
  ...overrides,
});
const ready = (id = "risk-1"): WorkspaceResult => ({
  state: "ready",
  items: [{ id, risk: `Capacity risk ${id}`, severity: "high", owner: null, status: "open", deadline: "2026-08-03T00:00:00.000Z", sla: "due-soon", version: 1 }],
  count: 1,
  fetchedAt,
});

function memoryPersistence(initial?: unknown): ReadCachePersistence & { value: unknown; raw?: { text: string; byteLength: number } } {
  return {
    value: initial,
    async read() {
      if (this.raw) return this.raw;
      if (this.value === undefined) return undefined;
      const text = JSON.stringify(this.value);
      return { text, byteLength: Buffer.byteLength(text, "utf8") };
    },
    async write(value) { this.value = structuredClone(value); },
  };
}

describe("validated workspace read cache", () => {
  it("isolates canonical query entries by profile, customer, principal, and workspace", async () => {
    const persistence = memoryPersistence();
    const cache = createReadCache({ persistence, now: () => Date.parse(fetchedAt) });
    await cache.put(scope(), query(), ready());

    await expect(cache.get(scope(), query({ filters: { priority: ["high", "critical"], status: "open" } }), scope())).resolves.toEqual(ready());
    await expect(cache.get(scope({ profileId: profileB }), query(), scope({ profileId: profileB }))).resolves.toBeUndefined();
    await expect(cache.get(scope({ customerInstanceId: customerB }), query(), scope({ customerInstanceId: customerB }))).resolves.toBeUndefined();
    await expect(cache.get(scope({ principalId: principalB }), query(), scope({ principalId: principalB }))).resolves.toBeUndefined();
    await expect(cache.get(scope(), query({ workspace: "resources" }), scope())).resolves.toBeUndefined();
  });

  it("reveals no cached data without the exact authenticated local session scope", async () => {
    const cache = createReadCache({ persistence: memoryPersistence(), now: () => Date.parse(fetchedAt) });
    await cache.put(scope(), query(), ready());

    await expect(cache.get(scope(), query(), null)).resolves.toBeUndefined();
    await expect(cache.get(scope(), query(), scope({ principalId: principalB }))).resolves.toBeUndefined();
    await expect(cache.get(scope(), query(), scope())).resolves.toEqual(ready());
  });

  it("rejects non-allowlisted projections and sensitive nested payloads before persistence", async () => {
    const persistence = memoryPersistence();
    const cache = createReadCache({ persistence, now: () => Date.parse(fetchedAt) });
    const sensitive = [
      [query({ workspace: "interventions", operation: "interventions.query" }), ready()],
      [query(), { ...ready(), items: [{ id: "risk-1", evidenceContent: "raw" }] }],
      [query(), { ...ready(), items: [{ id: "risk-1", auditPayload: { actor: "secret" } }] }],
      [query(), { ...ready(), items: [{ id: "risk-1", providerConfig: { apiKey: "secret" } }] }],
      [query(), { ...ready(), items: [{ id: "risk-1", evidence: { content: "raw bytes" } }] }],
      [query(), { ...ready(), items: [{ id: "risk-1", providerConfiguration: { clientSecret: "secret" } }] }],
    ] as const;

    for (const [candidateQuery, result] of sensitive) {
      await expect(cache.put(scope(), candidateQuery, result as WorkspaceResult)).rejects.toThrow("not cacheable");
    }
    expect(persistence.value).toBeUndefined();
  });

  it("validates results before persist and fails closed on corrupt persisted files", async () => {
    const persistence = memoryPersistence({ version: 1, entries: [{ leaked: "secret" }] });
    const cache = createReadCache({ persistence, now: () => Date.parse(fetchedAt) });

    await expect(cache.get(scope(), query(), scope())).resolves.toBeUndefined();
    await expect(cache.put(scope(), query(), { ...ready(), count: -1 } as never)).rejects.toThrow();
    expect(JSON.stringify(persistence.value)).not.toContain("Capacity risk");
  });

  it("rejects oversized persisted bytes before reading or parsing their text", async () => {
    const persistence: ReadCachePersistence = {
      read: async () => ({
        byteLength: 1_001,
        get text(): string { throw new Error("text must not be read"); },
      }),
      write: vi.fn(),
    };
    const cache = createReadCache({ persistence, now: () => Date.parse(fetchedAt), maxBytes: 1_000 });
    await expect(cache.get(scope(), query(), scope())).resolves.toBeUndefined();
  });

  it("rejects unknown cache row fields and bounded scalar or array violations", async () => {
    const cache = createReadCache({ persistence: memoryPersistence(), now: () => Date.parse(fetchedAt) });
    const base = ready() as Extract<WorkspaceResult, { state: "ready" }>;
    const invalid: WorkspaceResult[] = [
      { ...base, items: [{ ...base.items[0]!, authorization: "Bearer secret" }] },
      { ...base, items: [{ ...base.items[0]!, cookie: "session=secret" }] },
      { ...base, items: [{ ...base.items[0]!, privateKey: "secret" }] },
      { ...base, items: [{ ...base.items[0]!, accessKey: "secret" }] },
      { ...base, items: [{ ...base.items[0]!, risk: "x".repeat(2_049) }] },
      { ...base, items: Array.from({ length: 201 }, (_, index) => ({ ...base.items[0]!, id: `risk-${index}` })) },
    ];
    for (const result of invalid) await expect(cache.put(scope(), query(), result)).rejects.toThrow("not cacheable");
  });

  it("accepts only the explicit current UI row projection for every allowlisted workspace", async () => {
    const cache = createReadCache({ persistence: memoryPersistence(), now: () => Date.parse(fetchedAt) });
    const riskReady = ready() as Extract<WorkspaceResult, { state: "ready" }>;
    const rows = {
      overview: { item: "", type: "attention", status: "" },
      "my-work": { id: "task-1", task: "Task", process: "Process", state: "CLAIMED", dueAt: fetchedAt, evidenceRequirements: [], acceptedMediaTypes: ["application/pdf"], reviewHistory: [] },
      processes: { id: "process-1", process: "Process", cohort: "Cohort", owner: "Owner", status: "ACTIVE", expectedVersion: 1, progress: 50, participants: [], tasks: [], evidence: [], risks: [], timeline: [] },
      risks: riskReady.items[0],
      resources: { id: "resource-1", name: "Room", type: "room", state: "available", capacity: 2, availableCapacity: 1, reservations: [], conflicts: [] },
      "domain-design": { id: "package-1", name: "domain-package", version: "1.0.0", status: "draft", assets: [] },
    } as const;
    for (const [workspace, row] of Object.entries(rows)) {
      const candidateQuery: WorkspaceQuery = { workspace, operation: `${workspace}.query` };
      const result: WorkspaceResult = { state: "ready", items: [row!], count: 1, fetchedAt };
      await cache.put(scope(), candidateQuery, result);
      await expect(cache.get(scope(), candidateQuery, scope())).resolves.toEqual(result);
    }
  });

  it("fails closed when a persisted entry is structurally valid but contains sensitive data", async () => {
    const persistence = memoryPersistence();
    const cache = createReadCache({ persistence, now: () => Date.parse(fetchedAt) });
    await cache.put(scope(), query(), ready());
    const file = persistence.value as { entries: Array<{ result: WorkspaceResult }> };
    file.entries[0]!.result = { state: "ready", count: 1, fetchedAt, items: [{ id: "risk-1", providerConfig: { apiKey: "secret" } }] };

    await expect(cache.get(scope(), query(), scope())).resolves.toBeUndefined();
  });

  it("returns stale data with its original fetchedAt only for network failures", async () => {
    let now = Date.parse(fetchedAt);
    const cache = createReadCache({
      persistence: memoryPersistence(),
      now: () => now,
      freshTtlMs: 60_000,
      maxStaleMs: 10 * 60_000,
      isNetworkFailure: (error) => error instanceof TypeError,
    });
    await cache.put(scope(), query(), ready());
    now += 2 * 60_000;

    await expect(cache.query(scope(), query(), scope(), async () => { throw new TypeError("offline"); })).resolves.toEqual({
      ...ready(),
      state: "stale",
    });
    await expect(cache.query(scope(), query(), scope(), async () => { throw new Error("forbidden"); })).rejects.toThrow("forbidden");
    now += 10 * 60_000;
    await expect(cache.query(scope(), query(), scope(), async () => { throw new TypeError("offline"); })).rejects.toThrow("offline");
  });

  it("defaults to Core network and timeout failures without hiding authorization errors", async () => {
    const cache = createReadCache({ persistence: memoryPersistence(), now: () => Date.parse(fetchedAt) });
    await cache.put(scope(), query(), ready());
    const network = new CoreClientError({ code: "NETWORK_ERROR", status: 503, retryable: true });
    const timeout = new CoreClientError({ code: "TIMEOUT", status: 408, retryable: true });
    const forbidden = new CoreClientError({ code: "FORBIDDEN", status: 403, retryable: false });

    await expect(cache.query(scope(), query(), scope(), async () => { throw network; })).resolves.toMatchObject({ state: "stale" });
    await expect(cache.query(scope(), query(), scope(), async () => { throw timeout; })).resolves.toMatchObject({ state: "stale" });
    await expect(cache.query(scope(), query(), scope(), async () => { throw forbidden; })).rejects.toBe(forbidden);
  });

  it("updates validated online reads but never caches or fakes unavailable contracts", async () => {
    const persistence = memoryPersistence();
    const cache = createReadCache({ persistence, now: () => Date.parse(fetchedAt), isNetworkFailure: () => true });
    const unavailable: WorkspaceResult = {
      state: "unavailable",
      reason: "UNAVAILABLE_CONTRACT",
      resourceGroups: ["/risks"],
      message: "Risk API contract is unavailable",
    };

    await expect(cache.query(scope(), query(), scope(), async () => ready("online"))).resolves.toEqual(ready("online"));
    await expect(cache.query(scope(), query({ cursor: "missing" }), scope(), async () => unavailable)).resolves.toEqual(unavailable);
    await expect(cache.get(scope(), query({ cursor: "missing" }), scope())).resolves.toBeUndefined();
  });

  it("returns validated live data when cache policy or persistence rejects storage", async () => {
    const persistence = memoryPersistence();
    persistence.write = vi.fn().mockRejectedValue(new Error("disk unavailable"));
    const cache = createReadCache({ persistence, now: () => Date.parse(fetchedAt) });
    const sensitive: WorkspaceResult = { state: "ready", count: 1, fetchedAt, items: [{ id: "risk-1", auditPayload: { actor: "restricted" } }] };

    await expect(cache.query(scope(), query(), scope(), async () => sensitive)).resolves.toEqual(sensitive);
    await expect(cache.query(scope(), query(), scope(), async () => ready("live"))).resolves.toEqual(ready("live"));
  });

  it("does not persist or return a read after its captured session generation is invalidated", async () => {
    const persistence = memoryPersistence();
    const cache = createReadCache({ persistence, now: () => Date.parse(fetchedAt) });
    let current = true;
    let resolveRemote!: (result: WorkspaceResult) => void;
    const remote = new Promise<WorkspaceResult>((resolve) => void (resolveRemote = resolve));
    const pending = cache.query(scope(), query(), scope(), () => remote, () => current);
    current = false;
    resolveRemote(ready("late"));

    await expect(pending).rejects.toThrow("Session scope changed");
    expect(persistence.value).toBeUndefined();
  });

  it("does not disclose stale fallback after its captured session generation is invalidated", async () => {
    const persistence = memoryPersistence();
    const cache = createReadCache({ persistence, now: () => Date.parse(fetchedAt), isNetworkFailure: () => true });
    await cache.put(scope(), query(), ready());
    let current = true;
    const pending = cache.query(scope(), query(), scope(), async () => {
      current = false;
      throw new TypeError("offline");
    }, () => current);
    await expect(pending).rejects.toThrow("Session scope changed");
  });

  it("purges profile and account scopes without affecting unrelated entries", async () => {
    const cache = createReadCache({ persistence: memoryPersistence(), now: () => Date.parse(fetchedAt) });
    await cache.put(scope(), query(), ready("a"));
    await cache.put(scope({ principalId: principalB }), query(), ready("b"));
    await cache.put(scope({ profileId: profileB }), query(), ready("other-profile"));

    await cache.purgeAccount(scope());
    await expect(cache.get(scope(), query(), scope())).resolves.toBeUndefined();
    await expect(cache.get(scope({ principalId: principalB }), query(), scope({ principalId: principalB }))).resolves.toEqual(ready("b"));
    await cache.purgeProfile(profileB);
    await expect(cache.get(scope({ profileId: profileB }), query(), scope({ profileId: profileB }))).resolves.toBeUndefined();
  });

  it("serializes concurrent mutations and enforces entry and byte bounds", async () => {
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => void (releaseFirst = resolve));
    let writes = 0;
    const persistence = memoryPersistence();
    const write = persistence.write.bind(persistence);
    persistence.write = vi.fn(async (value) => {
      writes += 1;
      if (writes === 1) await firstWrite;
      await write(value);
    });
    const cache = createReadCache({
      persistence,
      now: () => Date.parse(fetchedAt),
      maxEntries: 2,
      maxBytes: 1_600,
    });

    const a = cache.put(scope(), query({ cursor: "a" }), ready("a"));
    const b = cache.put(scope(), query({ cursor: "b" }), ready("b"));
    await vi.waitFor(() => expect(persistence.write).toHaveBeenCalledTimes(1));
    releaseFirst();
    await Promise.all([a, b]);
    await cache.put(scope(), query({ cursor: "c" }), ready("c"));

    await expect(cache.get(scope(), query({ cursor: "a" }), scope())).resolves.toBeUndefined();
    await expect(cache.get(scope(), query({ cursor: "b" }), scope())).resolves.toEqual(ready("b"));
  });

  it("touches reads and evicts the least recently used entry", async () => {
    const persistence = memoryPersistence();
    const cache = createReadCache({ persistence, now: () => Date.parse(fetchedAt), maxEntries: 2 });
    await cache.put(scope(), query({ cursor: "a" }), ready("a"));
    await cache.put(scope(), query({ cursor: "b" }), ready("b"));
    await cache.get(scope(), query({ cursor: "a" }), scope());
    await cache.put(scope(), query({ cursor: "c" }), ready("c"));

    await expect(cache.get(scope(), query({ cursor: "a" }), scope())).resolves.toEqual(ready("a"));
    await expect(cache.get(scope(), query({ cursor: "b" }), scope())).resolves.toBeUndefined();
    await expect(cache.get(scope(), query({ cursor: "c" }), scope())).resolves.toEqual(ready("c"));
  });

  it("evicts by serialized UTF-8 bytes and recovers after rejecting one oversized entry", async () => {
    const persistence = memoryPersistence();
    const cache = createReadCache({ persistence, now: () => Date.parse(fetchedAt), maxEntries: 10, maxBytes: 1_700 });
    await cache.put(scope(), query({ cursor: "a" }), ready("a"));
    await cache.put(scope(), query({ cursor: "b" }), ready("b"));
    const large = { ...ready("c"), items: [{ ...(ready("c") as Extract<WorkspaceResult, { state: "ready" }>).items[0]!, risk: "x".repeat(900) }] } as WorkspaceResult;
    await cache.put(scope(), query({ cursor: "c" }), large);
    expect(Buffer.byteLength(JSON.stringify(persistence.value), "utf8")).toBeLessThanOrEqual(1_700);
    await expect(cache.get(scope(), query({ cursor: "a" }), scope())).resolves.toBeUndefined();
    await expect(cache.get(scope(), query({ cursor: "c" }), scope())).resolves.toEqual(large);

    const tinyPersistence = memoryPersistence();
    const tiny = createReadCache({ persistence: tinyPersistence, now: () => Date.parse(fetchedAt), maxBytes: 800 });
    await expect(tiny.put(scope(), query({ cursor: "large" }), large)).rejects.toThrow("entry exceeds");
    await expect(tiny.put(scope(), query({ cursor: "small" }), ready("small"))).resolves.toBeUndefined();
    await expect(tiny.get(scope(), query({ cursor: "small" }), scope())).resolves.toEqual(ready("small"));
  });
});
