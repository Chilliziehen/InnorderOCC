import { parentPort, workerData } from "node:worker_threads";

if (workerData.hook === "hang") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
if (workerData.hook === "memory") {
  const retained = [];
  while (true) retained.push(Array.from({ length: 100_000 }, (_, index) => `bounded-${index}`));
}
const text = workerData.hook === "output"
  ? "x".repeat(2_048)
  : Buffer.from(workerData.bytes).toString("utf8").replaceAll("\r\n", "\n").replaceAll("\r", "\n").normalize("NFC").trim();
parentPort.postMessage({ ok: true, parsed: { text, regions: [{ start: 0, end: text.length, source: "section:1", injectionMarked: false }], parserVersion: "governed-parser-v1" } });
