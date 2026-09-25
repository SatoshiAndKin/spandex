import { parentPort } from "node:worker_threads";
import { serializeError, type WorkerReply, type WorkerRequest } from "./protocol.js";

/** Providers supply only their handler; transport and error preservation live here. */
export function serveWorker<Request, Result>(handler: (payload: Request) => Promise<Result>): void {
  const port = parentPort;
  if (!port) throw new Error("SDK worker requires a parent port");
  const fatal = (error: unknown) => {
    port.postMessage({
      id: 0,
      success: false,
      fatal: true,
      error: serializeError(error),
    } satisfies WorkerReply<Result>);
    process.exit(1);
  };
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
  port.on("message", async ({ id, payload }: WorkerRequest<Request>) => {
    try {
      port.postMessage({
        id,
        success: true,
        result: await handler(payload),
      } satisfies WorkerReply<Result>);
    } catch (error) {
      port.postMessage({
        id,
        success: false,
        error: serializeError(error),
      } satisfies WorkerReply<Result>);
    }
  });
}
