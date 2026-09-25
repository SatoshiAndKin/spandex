import { serveWorker } from "../../lib/workers/serve.js";

serveWorker(async (request: { action?: string; blockMs?: number }) => {
  if (request.action === "crash")
    setTimeout(() => {
      throw Object.assign(
        new Error("Worker fixture crashed", { cause: new Error("Crash cause") }),
        { code: "FIXTURE_CRASH", details: { amount: 99n } },
      );
    }, 0);
  if (request.action === "exit") process.exit(0);
  if (request.action === "crash" || request.action === "hang") return new Promise<never>(() => {});
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, request.blockMs ?? 0);
  return { completed: true };
});
