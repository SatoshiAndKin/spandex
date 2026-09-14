import { describe, expect, it, mock, spyOn } from "bun:test";
import { ok } from "node:assert";
import { decodeStream, newStream } from "./streams.js";

async function framesFor(values: readonly number[]): Promise<Uint8Array[]> {
  const reader = newStream(
    values.map((value) => Promise.resolve(value)),
    () => -1,
  ).getReader();
  const frames: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    frames.push(value);
  }
  reader.releaseLock();
  return frames;
}

function controlledStream(cancel = mock((_reason?: unknown) => {})) {
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      writer = controller;
    },
    cancel,
  });
  return { stream, writer, cancel };
}

describe("stream cancellation and cleanup", () => {
  it.each([
    new Error("cancelled before reading"),
    "caller stopped",
    { stopped: true },
  ])("rejects an already aborted decode with the exact reason: %p", async (reason) => {
    const { stream, cancel } = controlledStream();
    const signal = AbortSignal.abort(reason);
    const remove = spyOn(signal, "removeEventListener");
    try {
      await expect(decodeStream(stream, { signal })).rejects.toBe(reason);
      expect(cancel).toHaveBeenCalledWith(reason);
      expect(stream.locked).toBe(false);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      remove.mockRestore();
    }
  });

  it.each([0, 3])("aborts while waiting for a header after %i bytes", async (bytes) => {
    const { stream, writer, cancel } = controlledStream();
    const controller = new AbortController();
    const reason = new Error("header cancelled");
    if (bytes) writer.enqueue(new Uint8Array([0xde, 0xc5, 0xfe]));
    const result = decodeStream(stream, { signal: controller.signal });
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(reason);
    expect(stream.locked).toBe(false);
  });

  it("preserves completed values and rejects all pending values after abort", async () => {
    const [header, first] = await framesFor([11, 22, 33]);
    ok(header && first);
    const { stream, writer, cancel } = controlledStream();
    const controller = new AbortController();
    const remove = spyOn(controller.signal, "removeEventListener");
    const reason = { code: "selection-complete" };
    try {
      writer.enqueue(header);
      const pending = await decodeStream<number>(stream, { signal: controller.signal });
      writer.enqueue(first);
      expect(await pending[0]).toBe(11);
      controller.abort(reason);
      // Let a turn pass before attaching consumers. Pending values must not cause
      // an unhandled rejection when the caller only selected the first value.
      await Bun.sleep(0);
      expect(await Promise.allSettled(pending)).toEqual([
        { status: "fulfilled", value: 11 },
        { status: "rejected", reason },
        { status: "rejected", reason },
      ]);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledWith(reason);
      expect(stream.locked).toBe(false);
      expect(remove).toHaveBeenCalledTimes(1);
    } finally {
      remove.mockRestore();
    }
  });

  it("releases readers even if the source rejects cancellation", async () => {
    const reason = new Error("abort");
    const stream = new ReadableStream<Uint8Array>({
      cancel: () => Promise.reject(new Error("source cleanup failed")),
    });
    const controller = new AbortController();
    const result = decodeStream(stream, { signal: controller.signal });
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    await Bun.sleep(0);
    expect(stream.locked).toBe(false);
  });

  it("does not wait for source cleanup to finish after abort", async () => {
    const stream = new ReadableStream<Uint8Array>({ cancel: () => new Promise(() => {}) });
    const controller = new AbortController();
    const result = decodeStream(stream, { signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toBe(controller.signal.reason);
    expect(stream.locked).toBe(false);
  });

  it.each([
    0, 3,
  ])("rejects a truncated header of %i bytes and releases the reader", async (bytes) => {
    const { stream, writer } = controlledStream();
    writer.enqueue(new Uint8Array(bytes));
    writer.close();
    await expect(decodeStream(stream)).rejects.toThrow("before header was received");
    expect(stream.locked).toBe(false);
  });

  it("cancels an invalid header and removes the signal listener", async () => {
    const { stream, writer, cancel } = controlledStream();
    const controller = new AbortController();
    const remove = spyOn(controller.signal, "removeEventListener");
    try {
      writer.enqueue(new Uint8Array(6));
      await expect(decodeStream(stream, { signal: controller.signal })).rejects.toThrow(
        "Unsupported quote stream header",
      );
      expect(stream.locked).toBe(false);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledTimes(1);
    } finally {
      remove.mockRestore();
    }
  });

  it.each([
    0, 2, 4,
  ])("rejects a truncated value after %i bytes and preserves earlier values", async (bytes) => {
    const [header, first, last] = await framesFor([11, 22]);
    ok(header && first && last);
    const { stream, writer } = controlledStream();
    writer.enqueue(header);
    writer.enqueue(first);
    writer.enqueue(last.slice(0, bytes));
    writer.close();
    const pending = await decodeStream<number>(stream);
    expect(await pending[0]).toBe(11);
    await expect(pending[1]).rejects.toThrow("before all quotes were received");
    expect(stream.locked).toBe(false);
  });

  it("rejects malformed payloads and cancels the source", async () => {
    const [header, frame] = await framesFor([11]);
    ok(header && frame);
    const { stream, writer, cancel } = controlledStream();
    frame[4] = 0xff;
    writer.enqueue(header);
    writer.enqueue(frame);
    const pending = await decodeStream<number>(stream);
    await expect(pending[0]).rejects.toBeInstanceOf(SyntaxError);
    expect(stream.locked).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("propagates a read error and removes the signal listener", async () => {
    const [header] = await framesFor([11]);
    ok(header);
    const { stream, writer } = controlledStream();
    const controller = new AbortController();
    const remove = spyOn(controller.signal, "removeEventListener");
    const reason = new Error("network failed");
    try {
      writer.enqueue(header);
      const pending = await decodeStream<number>(stream, { signal: controller.signal });
      writer.error(reason);
      await expect(pending[0]).rejects.toBe(reason);
      expect(stream.locked).toBe(false);
      expect(remove).toHaveBeenCalledTimes(1);
    } finally {
      remove.mockRestore();
    }
  });

  it.each([
    { values: [] },
    { values: [0] },
    { values: [11, 22] },
  ])("decodes fragmented frames and cleans up a complete stream: %p", async ({ values }) => {
    const frames = await framesFor(values);
    const { stream, writer, cancel } = controlledStream();
    for (const frame of frames) {
      for (const byte of frame) writer.enqueue(new Uint8Array([byte]));
    }
    const controller = new AbortController();
    const remove = spyOn(controller.signal, "removeEventListener");
    try {
      const pending = await decodeStream<number>(stream, { signal: controller.signal });
      expect(await Promise.all(pending)).toEqual([...values]);
      expect(stream.locked).toBe(false);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
      controller.abort();
      expect(await Promise.all(pending)).toEqual([...values]);
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      remove.mockRestore();
    }
  });
});
