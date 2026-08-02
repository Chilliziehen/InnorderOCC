import { parentPort, workerData } from "node:worker_threads";

import { parseDocument } from "./parser.js";

type Task = Readonly<{ bytes: Uint8Array; fileName: string; mimeType: string; hook?: "hang" | "memory" | "output" }>;

async function run(task: Task): Promise<void> {
  if (task.hook === "hang") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  if (task.hook === "memory") {
    const retained: string[][] = [];
    while (true) retained.push(Array.from({ length: 100_000 }, (_, index) => `bounded-${index}`));
  }
  const parsed = task.hook === "output"
    ? { text: "x".repeat(2_048), regions: [{ start: 0, end: 2_048, source: "test-output", injectionMarked: false }], parserVersion: "governed-parser-v1" }
    : await parseDocument({ bytes: task.bytes, fileName: task.fileName, mimeType: task.mimeType });
  parentPort!.postMessage({ ok: true, parsed });
}

run(workerData as Task).catch((error) => {
  const errorCode = error instanceof Error && /^OCC-AI-DOCUMENT-[A-Z0-9-]+$/u.test(error.message)
    ? error.message
    : "OCC-AI-PARSER-FAILED";
  parentPort!.postMessage({ ok: false, errorCode });
});
