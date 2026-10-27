import { describe, expect, it } from "bun:test";
import { createServer } from "node:http";
import { defaultSwapParams } from "../../test/utils.js";
import { zeroX } from "./0x.js";
import { fynd } from "./fynd.js";
import { kyberswap } from "./kyber.js";
import { lifi } from "./lifi.js";
import { mobula } from "./mobula.js";
import { nordstern } from "./nordstern.js";
import { o1 } from "./o1.js";
import { relay } from "./relay.js";
import { velora } from "./velora.js";

const providers = [
  zeroX({ apiKey: "test-key" }),
  fynd({ apiKey: "test-key" }),
  kyberswap({ clientId: "test-client" }),
  lifi({}),
  mobula({ apiKey: "test-key" }),
  nordstern({}),
  o1({ apiKey: "test-key", baseUrl: "https://example.invalid" }),
  relay({}),
  velora({}),
];

describe("provider HTTP deadline cancellation", () => {
  for (const provider of providers) {
    it.each([
      "headers",
      "body",
    ])(`${provider.name()} closes a stalled %s request`, async (phase) => {
      const closed = Promise.withResolvers<void>();
      let requestCount = 0;
      const server = createServer((_request, response) => {
        requestCount++;
        response.on("close", () => closed.resolve());
        if (phase === "body") {
          response.writeHead(200, { "content-type": "application/json" });
          response.write('{"incomplete":');
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing server address");
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(
        (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
          originalFetch(`http://127.0.0.1:${address.port}`, init),
        { preconnect: originalFetch.preconnect },
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        // Allow retries so a late abort cannot restart work after the deadline.
        const quote = provider.fetchQuote(defaultSwapParams, { deadlineMs: 100, numRetries: 1 });
        const result = await quote;
        expect(result.success).toBe(false);
        if (result.success) throw new Error("Expected a deadline failure");
        expect(result.error?.message).toContain("deadline exceeded");
        await Promise.race([
          closed.promise,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error("HTTP request survived its deadline")),
              500,
            );
          }),
        ]);
        expect(requestCount).toBe(1);
      } finally {
        clearTimeout(timeout);
        globalThis.fetch = originalFetch;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  }
});
