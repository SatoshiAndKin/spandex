import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { quoteSuccess, simulatedQuoteSuccess, usdcBalanceSwap } from "../../test/utils.js";
import type { Quote, SimulatedQuote } from "../types.js";
import { spandexCloud } from "./proxy.js";
import { newStream, quoteStreamErrorHandler, simulatedQuoteStreamErrorHandler } from "./streams.js";

const quote = quoteSuccess;
const simulatedQuote = simulatedQuoteSuccess;

describe("spandexCloud", () => {
  const cloud = spandexCloud({ apiKey: "testing" });
  let originalFetch: typeof fetch;
  let requests: Request[];
  let responses: Response[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    requests = [];
    responses = [];
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        requests.push(
          typeof input === "string"
            ? new Request(input, init)
            : input instanceof URL
              ? new Request(input.href, init)
              : new Request(input, init),
        );
        return responses.shift() ?? new Response(null, { status: 404 });
      },
      { preconnect: originalFetch.preconnect },
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("consumes streamed quote responses from cloud", async () => {
    responses.push(
      new Response(newStream<Quote>([Promise.resolve(quote)], quoteStreamErrorHandler), {
        headers: { "Content-Type": "application/octet-stream" },
      }),
    );

    const quotes = await Promise.all(await cloud.prepareQuotes(usdcBalanceSwap));

    expect(quotes).toHaveLength(1);
    expect(quotes[0]?.provider).toBe("fabric");
    expect(new URL(requests[0]?.url || "").pathname).toBe("/api/v1/prepareQuotes");
    expect(requests[0]?.headers.get("X-Api-Key")).toBe("testing");
  });

  it("consumes streamed simulated quote responses from cloud", async () => {
    responses.push(
      new Response(
        newStream<SimulatedQuote>(
          [Promise.resolve(simulatedQuote)],
          simulatedQuoteStreamErrorHandler,
        ),
        {
          headers: { "Content-Type": "application/octet-stream" },
        },
      ),
    );

    const quotes = await Promise.all(await cloud.prepareSimulatedQuotes(usdcBalanceSwap));

    expect(quotes).toHaveLength(1);
    expect(quotes[0]?.simulation.success).toBe(true);
    expect(new URL(requests[0]?.url || "").pathname).toBe("/api/v1/prepareSimulatedQuotes");
    expect(requests[0]?.headers.get("X-Api-Key")).toBe("testing");
  });
});
