import type { Worker } from "node:worker_threads";
import { deserializeError, type WorkerReply, type WorkerRequest } from "./protocol.js";

type Pending<T> = {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
};

/** Lazy, restartable worker ownership shared by providers. Not a public configuration API. */
export class WorkerClient<Request, Result> {
  private worker?: Worker;
  private sequence = 0;
  private readonly pending = new Map<number, Pending<Result>>();
  private idleTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly spawn: () => Worker,
    private readonly idleMs = 60_000,
    private readonly deadlineMs = 120_000,
  ) {}

  request(payload: Request, signal?: AbortSignal): Promise<Result> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const worker = this.getWorker();
      clearTimeout(this.idleTimer);
      const id = ++this.sequence;
      const cancel = (error: unknown) => {
        this.settle(id, (pending) => pending.reject(error));
        // A synchronous task cannot be interrupted by messages. Terminate when no
        // other caller still owns a request, then recreate lazily on the next call.
        if (this.pending.size === 0) this.retire(worker);
      };
      const abort = () => cancel(signal?.reason);
      const timer = setTimeout(
        () => cancel(new Error(`Worker deadline exceeded after ${this.deadlineMs}ms`)),
        this.deadlineMs,
      );
      this.pending.set(id, {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      worker.ref();
      try {
        worker.postMessage({ id, payload } satisfies WorkerRequest<Request>);
      } catch (error) {
        this.settle(id, (pending) => pending.reject(error));
      }
    });
  }

  close(): void {
    if (this.worker) this.fail(this.worker, new Error("Worker closed"));
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = this.spawn();
    this.worker = worker;
    worker.on("message", (reply: WorkerReply<Result>) => {
      if (this.worker !== worker) return;
      if (!reply.success && reply.fatal) {
        this.fail(worker, deserializeError(reply.error));
        return;
      }
      this.settle(reply.id, (pending) => {
        if (reply.success) pending.resolve(reply.result);
        else pending.reject(deserializeError(reply.error));
      });
    });
    worker.once("error", (error) => this.fail(worker, error));
    worker.once("messageerror", (error) => this.fail(worker, error));
    worker.once("exit", (code) => this.fail(worker, new Error(`Worker exited with code ${code}`)));
    worker.unref();
    return worker;
  }

  private settle(id: number, apply: (pending: Pending<Result>) => void): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.cleanup();
    apply(pending);
    if (this.pending.size === 0 && this.worker) {
      const worker = this.worker;
      worker.unref();
      this.idleTimer = setTimeout(() => this.retire(worker), this.idleMs);
      this.idleTimer.unref();
    }
  }

  private retire(worker: Worker): void {
    if (this.worker !== worker) return;
    clearTimeout(this.idleTimer);
    this.worker = undefined;
    void worker.terminate();
  }

  private fail(worker: Worker, error: unknown): void {
    if (this.worker !== worker) return;
    this.retire(worker);
    for (const [id] of this.pending) this.settle(id, (pending) => pending.reject(error));
  }
}
