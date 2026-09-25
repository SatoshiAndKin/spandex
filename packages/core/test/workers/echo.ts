import { serveWorker } from "../../lib/workers/serve.js";

serveWorker(async (request: { amount: bigint; delay?: number; error?: boolean }) => {
  await new Promise((resolve) => setTimeout(resolve, request.delay ?? 0));
  if (request.error) {
    const cause = Object.assign(new Error("RPC failure"), {
      code: -32000,
      details: { amount: request.amount },
    });
    throw Object.assign(new Error("Route unavailable", { cause }), {
      name: "ProviderError",
      code: "NO_ROUTE",
      details: { nested: cause, amount: request.amount },
    });
  }
  return { input: request.amount, output: request.amount * 2n };
});
