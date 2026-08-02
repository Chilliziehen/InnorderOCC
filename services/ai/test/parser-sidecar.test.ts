import { randomUUID, createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { ParserSidecarClient } from "../src/ingestion/parser-sidecar.js";

const digest = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const children = new Set<ChildProcess>();

function worker(inputRoot: string, requestRoot: string, outputRoot: string, environment: Record<string, string> = {}): ChildProcess {
  const child = spawn(process.execPath, [resolve("../../node_modules/vite-node/vite-node.mjs"), "src/ingestion/parser-worker.ts"], {
    cwd: process.cwd(), stdio: "ignore",
    env: { ...process.env, PARSER_WORKER_RUN: "true", PARSER_INPUT_ROOT: inputRoot, PARSER_REQUEST_ROOT: requestRoot, PARSER_OUTPUT_ROOT: outputRoot, PARSER_POLL_MS: "10", PARSER_TASK_URL: new URL("./fixtures/ingestion/parser-task-fixture.mjs", import.meta.url).href, ...environment },
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

async function roots() {
  const root = join(tmpdir(), `innorder-sidecar-${randomUUID()}`);
  const input = join(root, "input"); const requests = join(root, "requests"); const output = join(root, "output");
  await Promise.all([mkdir(input, { recursive: true }), mkdir(requests, { recursive: true }), mkdir(output, { recursive: true })]);
  return { root, input, requests, output };
}

afterEach(() => { for (const child of children) child.kill("SIGKILL"); children.clear(); });

describe("filesystem parser sidecar", () => {
  it("parses through a separate continuously polling worker and removes protocol files", async () => {
    const paths = await roots();
    const child = worker(paths.input, paths.requests, paths.output);
    const client = new ParserSidecarClient({ inputRoot: paths.input, requestRoot: paths.requests, outputRoot: paths.output, timeoutMs: 60_000, pollMs: 10 });
    try {
      const parsed = await client.parse({ bytes: Buffer.from("sidecar text"), fileName: "source.txt", mimeType: "text/plain" }, new AbortController().signal);
      expect(parsed).toMatchObject({ text: "sidecar text", parserVersion: "governed-parser-v1" });
      expect(await readdir(paths.requests)).toEqual([]);
      expect(await readdir(paths.output)).toEqual([]);
      expect(await readdir(paths.input)).toEqual([]);
      expect(child.exitCode).toBeNull();
    } finally { child.kill("SIGTERM"); await rm(paths.root, { recursive: true, force: true }); }
  }, 70_000);

  it("survives worker absence and restart without replay or duplicate results", async () => {
    const paths = await roots();
    const client = new ParserSidecarClient({ inputRoot: paths.input, requestRoot: paths.requests, outputRoot: paths.output, timeoutMs: 60_000, pollMs: 10 });
    const parsing = client.parse({ bytes: Buffer.from("restart text"), fileName: "source.txt", mimeType: "text/plain" }, new AbortController().signal);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    const child = worker(paths.input, paths.requests, paths.output);
    try {
      await expect(parsing).resolves.toMatchObject({ text: "restart text" });
      expect(await readdir(paths.output)).toEqual([]);
    } finally { child.kill("SIGTERM"); await rm(paths.root, { recursive: true, force: true }); }
  }, 70_000);

  it("cancels within the polling interval and removes an unclaimed request", async () => {
    const paths = await roots();
    const client = new ParserSidecarClient({ inputRoot: paths.input, requestRoot: paths.requests, outputRoot: paths.output, timeoutMs: 60_000, pollMs: 10 });
    const controller = new AbortController();
    const parsing = client.parse({ bytes: Buffer.from("cancel text"), fileName: "source.txt", mimeType: "text/plain" }, controller.signal);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    controller.abort();
    try {
      await expect(parsing).rejects.toThrow("OCC-AI-PARSER-CANCELLED");
      expect(await readdir(paths.requests)).toEqual([]);
      expect(await readdir(paths.output)).toEqual([]);
      expect(await readdir(paths.input)).toEqual([]);
    } finally { await rm(paths.root, { recursive: true, force: true }); }
  });

  it("terminates a timed-out parse and continues polling without restarting", async () => {
    const paths = await roots();
    const hanging = Buffer.from("deterministic hanging parser fixture");
    const child = worker(paths.input, paths.requests, paths.output, {
      PARSER_EXECUTION_TIMEOUT_MS: "2000",
      PARSER_TEST_HANG_SHA256: digest(hanging),
    });
    const client = new ParserSidecarClient({ inputRoot: paths.input, requestRoot: paths.requests, outputRoot: paths.output, timeoutMs: 5_000, pollMs: 10 });
    try {
      await expect(client.parse({ bytes: hanging, fileName: "hang.txt", mimeType: "text/plain" }, new AbortController().signal)).rejects.toThrow("OCC-AI-PARSER-TIMEOUT");
      await expect(client.parse({ bytes: Buffer.from("after timeout"), fileName: "next.txt", mimeType: "text/plain" }, new AbortController().signal)).resolves.toMatchObject({ text: "after timeout" });
      expect(child.exitCode).toBeNull();
    } finally { child.kill("SIGTERM"); await rm(paths.root, { recursive: true, force: true }); }
  }, 15_000);

  it("terminates a cancelled active parse and accepts the next request", async () => {
    const paths = await roots();
    const hanging = Buffer.from("deterministic cancelled parser fixture");
    const child = worker(paths.input, paths.requests, paths.output, {
      PARSER_EXECUTION_TIMEOUT_MS: "5000",
      PARSER_TEST_HANG_SHA256: digest(hanging),
    });
    const client = new ParserSidecarClient({ inputRoot: paths.input, requestRoot: paths.requests, outputRoot: paths.output, timeoutMs: 5_000, pollMs: 10 });
    const controller = new AbortController();
    try {
      const parsing = client.parse({ bytes: hanging, fileName: "cancel.txt", mimeType: "text/plain" }, controller.signal);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      controller.abort();
      await expect(parsing).rejects.toThrow("OCC-AI-PARSER-CANCELLED");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      await expect(client.parse({ bytes: Buffer.from("after cancel"), fileName: "next.txt", mimeType: "text/plain" }, new AbortController().signal)).resolves.toMatchObject({ text: "after cancel" });
      expect(child.exitCode).toBeNull();
    } finally { child.kill("SIGTERM"); await rm(paths.root, { recursive: true, force: true }); }
  }, 15_000);

  it.each([
    ["output", "PARSER_TEST_OUTPUT_SHA256", "OCC-AI-PARSER-RESULT-BOUNDS"],
    ["memory", "PARSER_TEST_MEMORY_SHA256", "OCC-AI-PARSER-RESOURCE"],
  ])("contains %s exhaustion inside one Worker and continues polling", async (kind, hook, expected) => {
    const paths = await roots();
    const hostile = Buffer.from(`deterministic ${kind} parser fixture`);
    const child = worker(paths.input, paths.requests, paths.output, {
      [hook]: digest(hostile),
      PARSER_MAX_RESULT_BYTES: "1024",
      PARSER_MAX_OLD_GENERATION_MB: "32",
    });
    const client = new ParserSidecarClient({ inputRoot: paths.input, requestRoot: paths.requests, outputRoot: paths.output, timeoutMs: 10_000, pollMs: 10 });
    try {
      await expect(client.parse({ bytes: hostile, fileName: `${kind}.txt`, mimeType: "text/plain" }, new AbortController().signal)).rejects.toThrow(expected);
      await expect(client.parse({ bytes: Buffer.from(`after ${kind}`), fileName: "next.txt", mimeType: "text/plain" }, new AbortController().signal)).resolves.toMatchObject({ text: `after ${kind}` });
      expect(child.exitCode).toBeNull();
    } finally { child.kill("SIGTERM"); await rm(paths.root, { recursive: true, force: true }); }
  }, 20_000);

  it("returns only strict hash-bound output and rejects caller-controlled roots", async () => {
    const paths = await roots();
    expect(() => new ParserSidecarClient({ inputRoot: paths.input, requestRoot: paths.input, outputRoot: paths.output })).toThrow("OCC-AI-PARSER-CONFIG");
    expect(digest("stable")).toHaveLength(64);
    await rm(paths.root, { recursive: true, force: true });
  });

  it("rejects a replay without deleting the existing caller result", async () => {
    const paths = await roots(); const requestId = randomUUID(); const existing = join(paths.output, `${requestId}.result.json`);
    await writeFile(existing, "existing-result");
    const client = new ParserSidecarClient({ inputRoot: paths.input, requestRoot: paths.requests, outputRoot: paths.output, requestId: () => requestId });
    try {
      await expect(client.parse({ bytes: Buffer.from("replay"), fileName: "source.txt", mimeType: "text/plain" }, new AbortController().signal)).rejects.toThrow("OCC-AI-PARSER-DUPLICATE");
      expect(await readFile(existing, "utf8")).toBe("existing-result");
    } finally { await rm(paths.root, { recursive: true, force: true }); }
  });
});
