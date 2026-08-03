import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { atomicWrite, removeStaleAtomicTemps, type AtomicFileSystem, type AtomicHandle } from "../src/ingestion/atomic-file.js";

const roots = new Set<string>();
async function temporaryRoot(): Promise<string> { const root = join(tmpdir(), `innorder-atomic-${randomUUID()}`); await mkdir(root); roots.add(root); return root; }
afterEach(async () => { await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true }))); roots.clear(); });

describe("parser atomic files", () => {
  it("uses nonreused random names for concurrent same-process writers and leaves one complete target", async () => {
    const root = await temporaryRoot(); const target = join(root, ".parser-heartbeat.json");
    const values = Array.from({ length: 32 }, (_, index) => Buffer.from(`heartbeat-${index}`));
    await Promise.all(values.map((value) => atomicWrite(target, value, { owner: "worker" })));
    expect(values.map(String)).toContain((await readFile(target)).toString());
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it.each(["write", "file-sync", "rename"] as const)("closes handles and removes only its random temp after %s failure", async (failure) => {
    const removed: string[] = []; const opened: string[] = []; let closed = 0; let directorySynced = 0;
    const handle: AtomicHandle = {
      writeFile: vi.fn(async () => { if (failure === "write") throw new Error("write failed"); }),
      sync: vi.fn(async () => { if (failure === "file-sync") throw new Error("sync failed"); }),
      close: vi.fn(async () => { closed += 1; }),
    };
    const directory: AtomicHandle = { writeFile: vi.fn(), sync: vi.fn(async () => { directorySynced += 1; }), close: vi.fn(async () => { closed += 1; }) };
    const fileSystem: AtomicFileSystem = {
      open: vi.fn(async (path, _flags, mode) => { opened.push(path); return mode === undefined ? directory : handle; }),
      rename: vi.fn(async () => { if (failure === "rename") throw new Error("rename failed"); }),
      rm: vi.fn(async (path) => { removed.push(path); }),
      readdir: vi.fn(), lstat: vi.fn(),
    };
    const target = join("/queue", "request.json");
    await expect(atomicWrite(target, Buffer.from("request"), { owner: "client", randomBytes: () => Buffer.alloc(16, 0xab), fileSystem })).rejects.toThrow(failure === "file-sync" ? "sync failed" : `${failure} failed`);
    expect(opened[0]).toBe(join("/queue", "request.json.atomic-client-abababababababababababababababab.tmp"));
    expect(removed).toEqual([opened[0]]);
    expect(removed).not.toContain(target);
    expect(closed).toBe(1);
    expect(directorySynced).toBe(0);
  });

  it("never removes another writer's temp when exclusive creation reports a collision", async () => {
    const remove = vi.fn(async () => undefined);
    const collision = Object.assign(new Error("already exists"), { code: "EEXIST" });
    const fileSystem: AtomicFileSystem = { open: vi.fn(async () => { throw collision; }), rename: vi.fn(), rm: remove, readdir: vi.fn(), lstat: vi.fn() };
    await expect(atomicWrite(join("/queue", "request.json"), Buffer.from("request"), { owner: "client", randomBytes: () => Buffer.alloc(16, 7), fileSystem })).rejects.toBe(collision);
    expect(remove).not.toHaveBeenCalled();
  });

  it("fsyncs and closes the containing directory after a successful rename", async () => {
    const events: string[] = [];
    const file: AtomicHandle = { writeFile: async () => { events.push("write"); }, sync: async () => { events.push("file-sync"); }, close: async () => { events.push("file-close"); } };
    const directory: AtomicHandle = { writeFile: vi.fn(), sync: async () => { events.push("directory-sync"); }, close: async () => { events.push("directory-close"); } };
    const fileSystem: AtomicFileSystem = { open: async (_path, _flags, mode) => mode === undefined ? directory : file, rename: async () => { events.push("rename"); }, rm: vi.fn(), readdir: vi.fn(), lstat: vi.fn() };
    await atomicWrite("/queue/request.json", Buffer.from("request"), { owner: "client", randomBytes: () => Buffer.alloc(16, 1), fileSystem });
    expect(events).toEqual(["write", "file-sync", "file-close", "rename", "directory-sync", "directory-close"]);
  });

  it("closes both handles and cleans only its temp when directory fsync fails after rename", async () => {
    const removed: string[] = []; const target = join("/queue", "request.json"); let fileClosed = 0; let directoryClosed = 0;
    const file: AtomicHandle = { writeFile: async () => undefined, sync: async () => undefined, close: async () => { fileClosed += 1; } };
    const directory: AtomicHandle = { writeFile: vi.fn(), sync: async () => { throw new Error("directory sync failed"); }, close: async () => { directoryClosed += 1; } };
    const fileSystem: AtomicFileSystem = { open: async (_path, _flags, mode) => mode === undefined ? directory : file, rename: async () => undefined, rm: async (path) => { removed.push(path); }, readdir: vi.fn(), lstat: vi.fn() };
    await expect(atomicWrite(target, Buffer.from("request"), { owner: "client", randomBytes: () => Buffer.alloc(16, 9), fileSystem })).rejects.toThrow("directory sync failed");
    expect(fileClosed).toBe(1); expect(directoryClosed).toBe(1);
    expect(removed).toEqual([join("/queue", `request.json.atomic-client-${"09".repeat(16)}.tmp`)]);
    expect(removed).not.toContain(target);
  });

  it("removes only old regular owned temps and recovers a PID-stable crash on restart", async () => {
    const root = await temporaryRoot(); const now = Date.now();
    const stale = ".parser-heartbeat.json.atomic-worker-11111111111111111111111111111111.tmp";
    const fresh = ".parser-heartbeat.json.atomic-worker-22222222222222222222222222222222.tmp";
    const unrelated = `.parser-heartbeat.json.${process.pid}.tmp`;
    await Promise.all([writeFile(join(root, stale), "crash"), writeFile(join(root, fresh), "active"), writeFile(join(root, unrelated), "foreign")]);
    await utimes(join(root, stale), new Date(now - 120_000), new Date(now - 120_000));
    await removeStaleAtomicTemps(root, "worker-output", { now: () => now, maxAgeMs: 60_000 });
    expect((await readdir(root)).sort()).toEqual([fresh, unrelated].sort());
    await atomicWrite(join(root, ".parser-heartbeat.json"), Buffer.from("restart"), { owner: "worker", randomBytes: () => Buffer.alloc(16, 0x11) });
    expect(await readFile(join(root, ".parser-heartbeat.json"), "utf8")).toBe("restart");
  });

  it("never removes symlinks, fresh files, or names outside strict request ownership", async () => {
    const removed: string[] = [];
    const entries = [
      { name: `${randomUUID()}.request.json.atomic-client-${"a".repeat(32)}.tmp`, isFile: () => true, isSymbolicLink: () => false },
      { name: `${randomUUID()}.request.json.atomic-client-${"b".repeat(32)}.tmp`, isFile: () => false, isSymbolicLink: () => true },
      { name: `not-owned.atomic-client-${"c".repeat(32)}.tmp`, isFile: () => true, isSymbolicLink: () => false },
    ];
    const fileSystem: AtomicFileSystem = {
      open: vi.fn(), rename: vi.fn(),
      rm: vi.fn(async (path) => { removed.push(path); }),
      readdir: vi.fn(async () => entries),
      lstat: vi.fn(async (path) => ({ isFile: () => !path.includes("b".repeat(32)), isSymbolicLink: () => path.includes("b".repeat(32)), mtimeMs: 1 })),
    };
    await removeStaleAtomicTemps("/requests", "client-request", { now: () => 120_000, maxAgeMs: 60_000, fileSystem });
    expect(removed).toEqual([join("/requests", entries[0]!.name)]);
  });
});
