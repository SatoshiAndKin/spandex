import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { WorkerClient } from "./client.js";
import { deserializeError, serializeError } from "./protocol.js";

let directory: string;
const clients: Array<{ close: () => void }> = [];
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "spandex-workers-"));
  for (const name of ["echo", "blocking"]) {
    const result = await Bun.build({
      entrypoints: [new URL(`../../test/workers/${name}.ts`, import.meta.url).pathname],
      outdir: directory,
      target: "node",
      naming: "[name].mjs",
    });
    if (!result.success) throw new AggregateError(result.logs, "Fixture build failed");
  }
});
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function client<Request, Result>(name: string, idleMs = 60_000, deadlineMs = 2_000) {
  const workers: Worker[] = [];
  const instance = new WorkerClient<Request, Result>(
    () => {
      const worker = new Worker(join(directory, `${name}.mjs`), { execArgv: [] });
      workers.push(worker);
      return worker;
    },
    idleMs,
    deadlineMs,
  );
  clients.push(instance);
  return { instance, workers };
}

describe("shared provider workers", () => {
  it("correlates out-of-order results and preserves large bigint amounts", async () => {
    const { instance, workers } = client<
      { amount: bigint; delay?: number },
      { input: bigint; output: bigint }
    >("echo");
    const slow = instance.request({ amount: 9007199254740993n, delay: 50 });
    const fast = instance.request({ amount: 7n });
    expect(await fast).toEqual({ input: 7n, output: 14n });
    expect(await slow).toEqual({ input: 9007199254740993n, output: 18014398509481986n });
    expect(workers.length).toBe(1);
  });

  it("preserves error names, messages, codes, nested causes and details", async () => {
    const { instance } = client("echo");
    const error = await instance
      .request({ amount: 9007199254740993n, error: true })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "ProviderError",
      message: "Route unavailable",
      code: "NO_ROUTE",
      cause: {
        name: "Error",
        message: "RPC failure",
        code: -32000,
        details: { amount: 9007199254740993n },
      },
      details: { nested: { code: -32000 }, amount: 9007199254740993n },
    });
    if (!(error instanceof Error)) throw new Error("Expected Error");
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.stack).toContain("Route unavailable");
  });

  it("preserves cyclic diagnostics without confusing detail fields with protocol tags", () => {
    const error = Object.assign(new Error("cycle"), {
      details: { kind: "error", fields: { code: 9n } },
    });
    error.cause = error;
    const result = deserializeError(structuredClone(serializeError(error)));
    expect(result).toMatchObject({
      message: "cycle",
      details: { kind: "error", fields: { code: 9n } },
    });
    if (!(result instanceof Error)) throw new Error("Expected Error");
    expect(result.cause).toBe(result);
    expect(deserializeError(serializeError("plain failure"))).toBe("plain failure");
  });

  it.each(["crash", "exit"])("settles all requests on %s and restarts", async (action) => {
    const { instance, workers } = client("blocking");
    const results = await Promise.allSettled([
      instance.request({ action }),
      instance.request({ action: "hang" }),
    ]);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status !== "rejected") throw new Error("Expected rejection");
      expect(result.reason.message).toBe(
        action === "crash" ? "Worker fixture crashed" : "Worker exited with code 0",
      );
    }
    expect(await instance.request({})).toEqual({ completed: true });
    expect(workers.length).toBe(2);
  });

  it("kills timed-out work and restarts without retaining pending requests", async () => {
    const { instance, workers } = client("blocking", 60_000, 100);
    await expect(instance.request({ blockMs: 10_000 })).rejects.toThrow(
      "Worker deadline exceeded after 100ms",
    );
    expect(await instance.request({})).toEqual({ completed: true });
    expect(workers.length).toBe(2);
  });

  it("cancels one caller without rejecting another and ignores its late reply", async () => {
    const { instance, workers } = client("echo");
    const controller = new AbortController();
    const cancelled = instance.request({ amount: 1n, delay: 40 }, controller.signal);
    const other = instance.request({ amount: 2n, delay: 60 });
    controller.abort(new Error("Quote deadline"));
    await expect(cancelled).rejects.toThrow("Quote deadline");
    expect(await other).toEqual({ input: 2n, output: 4n });
    expect(await instance.request({ amount: 3n })).toEqual({ input: 3n, output: 6n });
    expect(workers.length).toBe(1);
  });

  it("does not start work for an aborted request and handles clone failures", async () => {
    const { instance, workers } = client("echo");
    await expect(instance.request({}, AbortSignal.abort(new Error("Cancelled")))).rejects.toThrow(
      "Cancelled",
    );
    expect(workers.length).toBe(0);
    await expect(instance.request({ callback: () => {} })).rejects.toThrow();
    expect(await instance.request({ amount: 4n })).toEqual({ input: 4n, output: 8n });
  });

  it("terminates idle workers and recreates on demand", async () => {
    const { instance, workers } = client("echo", 20);
    expect(await instance.request({ amount: 1n })).toEqual({ input: 1n, output: 2n });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await instance.request({ amount: 2n })).toEqual({ input: 2n, output: 4n });
    expect(workers.length).toBe(2);
    const pending = instance.request({ amount: 3n, delay: 10_000 });
    instance.close();
    await expect(pending).rejects.toThrow("Worker closed");
  });

  it("keeps a network provider responsive while another worker blocks", async () => {
    const { instance } = client("blocking", 60_000, 200);
    const server = createServer((_request, response) => response.end("network quote"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing listener");
      const blocked = instance.request({ blockMs: 10_000 }).catch((error: unknown) => error);
      const network = fetch(`http://127.0.0.1:${address.port}`).then((response) => response.text());
      expect(await Promise.race([network, blocked])).toBe("network quote");
      expect(await blocked).toMatchObject({ message: "Worker deadline exceeded after 200ms" });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
