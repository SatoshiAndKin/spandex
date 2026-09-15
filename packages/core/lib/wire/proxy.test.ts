import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ok } from "node:assert";
import type { Address } from "viem";
import {
  defaultSwapParams,
  quoteSuccess,
  recordedQuotes,
  simulatedQuoteSuccess,
  testConfig,
} from "../../test/utils.js";
import { fabric } from "../aggregators/fabric.js";
import { createConfig } from "../createConfig.js";
import { getQuote } from "../getQuote.js";
import { getQuotes } from "../getQuotes.js";
import { getRawQuotes } from "../getRawQuotes.js";
import { prepareQuotes } from "../prepareQuotes.js";
import { prepareSimulatedQuotes } from "../prepareSimulatedQuotes.js";
import { selectQuote } from "../selectQuote.js";
import type {
  Quote,
  QuoteSelectionStrategy,
  SimulatedQuote,
  SimulationOptions,
  SwapParams,
} from "../types.js";
import { proxy } from "./proxy.js";
import { deserializeWithBigInt } from "./serde.js";
import { newStream, quoteStreamErrorHandler, simulatedQuoteStreamErrorHandler } from "./streams.js";

function makeSimulatedQuote(outputAmount: bigint): SimulatedQuote {
  return {
    ...simulatedQuoteSuccess,
    outputAmount,
    simulation: { ...simulatedQuoteSuccess.simulation, outputAmount },
    performance: { ...simulatedQuoteSuccess.performance, outputAmount },
  };
}

function withDelay<T>(value: T, delayMs: number): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), delayMs));
}

describe("proxy", () => {
  const baseUrl = "https://example.com/api";
  const delegatedActions: ["prepareQuotes", "prepareSimulatedQuotes"] = [
    "prepareQuotes",
    "prepareSimulatedQuotes",
  ];
  let originalFetch: typeof fetch;
  let requests: Request[];
  let responses: Response[];
  let signals: (AbortSignal | null | undefined)[];

  async function enqueue(swap: SwapParams) {
    const quotes = await recordedQuotes("proxy", swap, testConfig([fabric({ appId: "test-app" })]));
    const stream = newStream<Quote>(
      quotes.map((q) => Promise.resolve(q)),
      quoteStreamErrorHandler,
    );
    responses.push(
      new Response(stream, {
        headers: { "Content-Type": "application/octet-stream" },
      }),
    );
  }

  function enqueueSimulated() {
    const stream = newStream<SimulatedQuote>(
      [Promise.resolve(makeSimulatedQuote(10n))],
      simulatedQuoteStreamErrorHandler,
    );
    responses.push(
      new Response(stream, {
        headers: { "Content-Type": "application/octet-stream" },
      }),
    );
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    requests = [];
    responses = [];
    signals = [];
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const request =
          typeof input === "string"
            ? new Request(input, init)
            : input instanceof URL
              ? new Request(input.href, init)
              : new Request(input, init);
        requests.push(request);
        signals.push(init?.signal);
        return responses.shift() ?? new Response(null, { status: 404 });
      },
      { preconnect: originalFetch.preconnect },
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("delegates quote fetching to a server", async () => {
    await enqueue(defaultSwapParams);

    const quotes = await getRawQuotes({
      config: createConfig({
        proxy: proxy({ pathOrUrl: baseUrl, delegatedActions }),
      }),
      swap: defaultSwapParams,
    });

    expect(quotes).toBeDefined();
    expect(quotes.length).toBe(1);
    expect(quotes?.[0]?.provider).toBe("fabric");
    expect(new URL(requests[0]?.url || "").pathname).toBe("/api/prepareQuotes");
  }, 10_000);

  it("forwards recipientAccount to the proxy query", async () => {
    const recipientAccount: Address = "0x0000000000000000000000000000000000000abc";
    const swap = {
      ...defaultSwapParams,
      recipientAccount,
    };
    await enqueue(swap);

    await getRawQuotes({
      config: createConfig({
        proxy: proxy({ pathOrUrl: baseUrl, delegatedActions }),
      }),
      swap,
    });

    const request = requests[0];
    expect(request).toBeDefined();
    const url = new URL(request?.url || "");
    expect(url.searchParams.get("recipientAccount")).toBe(recipientAccount);
  }, 10_000);

  it("forwards outputChainId to the proxy query", async () => {
    const swap = {
      ...defaultSwapParams,
      outputChainId: 10,
    };
    const stream = newStream<Quote>(
      [
        Promise.resolve({
          ...quoteSuccess,
          outputChainId: 10,
          outputAmount: 10n,
        } satisfies Quote),
      ],
      quoteStreamErrorHandler,
    );
    responses.push(
      new Response(stream, {
        headers: { "Content-Type": "application/octet-stream" },
      }),
    );

    await getRawQuotes({
      config: createConfig({
        proxy: proxy({ pathOrUrl: baseUrl, delegatedActions }),
      }),
      swap,
    });

    const request = requests[0];
    expect(request).toBeDefined();
    const url = new URL(request?.url || "");
    expect(url.searchParams.get("outputChainId")).toBe("10");
  }, 10_000);

  it("adds optional headers to the proxy request", async () => {
    await enqueue(defaultSwapParams);

    await getRawQuotes({
      config: createConfig({
        proxy: proxy({
          pathOrUrl: baseUrl,
          delegatedActions,
          headers: { "X-Custom-Header": "CustomValue" },
        }),
      }),
      swap: defaultSwapParams,
    });

    const request = requests[0];
    expect(request).toBeDefined();
    expect(request?.headers.get("X-Custom-Header")).toBe("CustomValue");
  }, 10_000);

  it("streams simulated quotes from the proxy", async () => {
    enqueueSimulated();

    const quotes = await getQuotes({
      config: createConfig({
        proxy: proxy({ pathOrUrl: baseUrl, delegatedActions }),
      }),
      swap: defaultSwapParams,
    });

    expect(quotes).toHaveLength(1);
    expect(quotes[0]?.simulation).toBeDefined();
    const url = new URL(requests[0]?.url || "");
    expect(url.pathname).toBe("/api/prepareSimulatedQuotes");
    expect(url.searchParams.get("simulationOptions")).toBeNull();
  }, 10_000);

  it("forwards bigint-aware simulationOptions to delegated simulation", async () => {
    enqueueSimulated();
    const simulationOptions: SimulationOptions = {
      stateOverrides: [
        {
          address: defaultSwapParams.inputToken,
          balance: 123n,
          stateDiff: [{ slot: "0x01", value: "0x02" }],
        },
      ],
    };

    await getQuotes({
      config: createConfig({
        proxy: proxy({ pathOrUrl: baseUrl, delegatedActions }),
      }),
      swap: defaultSwapParams,
      simulationOptions,
    });

    const request = requests[0];
    expect(request).toBeDefined();
    const encoded = new URL(request?.url || "").searchParams.get("simulationOptions");
    expect(encoded).not.toBeNull();
    expect(deserializeWithBigInt<SimulationOptions>(encoded as string)).toEqual(simulationOptions);
  }, 10_000);

  it("selects quotes locally from streamed simulated proxy results", async () => {
    enqueueSimulated();

    const quote = await getQuote({
      config: createConfig({
        proxy: proxy({ pathOrUrl: baseUrl, delegatedActions }),
      }),
      swap: defaultSwapParams,
      strategy: "fastest",
    });

    expect(quote).not.toBeNull();
    expect(quote?.simulation.success).toBe(true);
  }, 10_000);

  it("aborts the remote simulated stream when fastest resolves", async () => {
    let aborted = false;
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const request =
          typeof input === "string"
            ? new Request(input, init)
            : input instanceof URL
              ? new Request(input.href, init)
              : new Request(input, init);
        requests.push(request);
        signals.push(init?.signal);
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return new Response(
          newStream<SimulatedQuote>(
            [withDelay(makeSimulatedQuote(10n), 20), withDelay(makeSimulatedQuote(9n), 250)],
            simulatedQuoteStreamErrorHandler,
          ),
          {
            headers: { "Content-Type": "application/octet-stream" },
          },
        );
      },
      { preconnect: originalFetch.preconnect },
    );

    const quote = await getQuote({
      config: createConfig({
        proxy: proxy({ pathOrUrl: baseUrl, delegatedActions }),
      }),
      swap: defaultSwapParams,
      strategy: "fastest",
    });

    expect(quote?.simulation.outputAmount).toBe(10n);
    await Bun.sleep(50);
    expect(aborted).toBe(true);
  }, 10_000);

  const earlyStrategies: { name: string; strategy: QuoteSelectionStrategy; expected: bigint }[] = [
    { name: "fastest", strategy: "fastest", expected: 10n },
    {
      name: "firstN",
      strategy: { collect: { type: "firstN", count: 2 }, rank: "bestPrice" },
      expected: 20n,
    },
    {
      name: "benchmark",
      strategy: {
        collect: { type: "benchmark", provider: "fabric", minQuotes: 2 },
        rank: "bestPrice",
      },
      expected: 20n,
    },
    { name: "custom", strategy: async () => null, expected: 0n },
  ];

  it.each(earlyStrategies)("cleans up the proxy after $name selection", async ({
    strategy,
    expected,
  }) => {
    const stream = newStream<SimulatedQuote>(
      [
        Promise.resolve(makeSimulatedQuote(10n)),
        withDelay(makeSimulatedQuote(20n), 1),
        new Promise(() => {}),
      ],
      simulatedQuoteStreamErrorHandler,
    );
    responses.push(new Response(stream));
    const result = await getQuote({
      config: createConfig({ proxy: proxy({ pathOrUrl: baseUrl, delegatedActions }) }),
      swap: defaultSwapParams,
      strategy,
    });
    expect(result?.simulation.outputAmount ?? 0n).toBe(expected);
    expect(signals[0]?.aborted).toBe(true);
    await Bun.sleep(0);
    expect(stream.locked).toBe(false);
  });

  it("aborts the proxy when a custom selector throws without consuming results", async () => {
    const stream = newStream<SimulatedQuote>(
      [new Promise(() => {})],
      simulatedQuoteStreamErrorHandler,
    );
    responses.push(new Response(stream));
    const reason = new Error("selector failed");
    await expect(
      getQuote({
        config: createConfig({ proxy: proxy({ pathOrUrl: baseUrl, delegatedActions }) }),
        swap: defaultSwapParams,
        strategy: async () => {
          throw reason;
        },
      }),
    ).rejects.toBe(reason);
    expect(signals[0]?.aborted).toBe(true);
    await Bun.sleep(0);
    expect(stream.locked).toBe(false);
  });

  it("aborts the proxy when selection parameters are invalid", async () => {
    const stream = newStream<SimulatedQuote>(
      [new Promise(() => {})],
      simulatedQuoteStreamErrorHandler,
    );
    responses.push(new Response(stream));
    await expect(
      getQuote({
        config: createConfig({ proxy: proxy({ pathOrUrl: baseUrl, delegatedActions }) }),
        swap: defaultSwapParams,
        strategy: { collect: { type: "firstN", count: 2 }, rank: "bestPrice" },
      }),
    ).rejects.toThrow("cannot exceed the number of providers");
    expect(signals[0]?.aborted).toBe(true);
    await Bun.sleep(0);
    expect(stream.locked).toBe(false);
  });

  it("aborts and releases the response when preparation fails", async () => {
    const stream = new ReadableStream<Uint8Array>();
    responses.push(new Response(stream, { status: 503 }));
    await expect(
      getQuote({
        config: createConfig({ proxy: proxy({ pathOrUrl: baseUrl, delegatedActions }) }),
        swap: defaultSwapParams,
        strategy: "fastest",
      }),
    ).rejects.toThrow("Proxy request failed with status 503");
    expect(signals[0]?.aborted).toBe(true);
    expect(await stream.getReader().read()).toEqual({ value: undefined, done: true });
  });

  it("passes an external signal to fetch before a stream header arrives", async () => {
    const stream = new ReadableStream<Uint8Array>();
    responses.push(new Response(stream));
    const controller = new AbortController();
    const reason = new Error("caller stopped before the header");
    const result = prepareSimulatedQuotes({
      config: createConfig({ proxy: proxy({ pathOrUrl: baseUrl, delegatedActions }) }),
      swap: defaultSwapParams,
      signal: controller.signal,
    });
    await Bun.sleep(0);
    expect(signals[0]).toBe(controller.signal);
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    expect(stream.locked).toBe(false);
  });

  it("lets direct callers select and cancel simulated quotes with their own controller", async () => {
    const stream = newStream<SimulatedQuote>(
      [Promise.resolve(makeSimulatedQuote(10n)), new Promise(() => {})],
      simulatedQuoteStreamErrorHandler,
    );
    responses.push(new Response(stream));
    const controller = new AbortController();
    const simulationOptions: SimulationOptions = { gasPrice: 123n };
    const pending = await prepareSimulatedQuotes({
      config: createConfig({ proxy: proxy({ pathOrUrl: baseUrl, delegatedActions }) }),
      swap: defaultSwapParams,
      simulationOptions,
      signal: controller.signal,
    });
    const winner = await selectQuote({ strategy: "fastest", quotes: pending });
    expect(winner?.simulation.outputAmount).toBe(10n);
    expect(signals[0]).toBe(controller.signal);
    expect(controller.signal.aborted).toBe(false);
    const reason = new Error("caller selected a quote");
    controller.abort(reason);
    if (!winner) throw new Error("Expected a selected quote");
    expect(await pending[0]).toEqual(winner);
    await expect(pending[1]).rejects.toBe(reason);
    const request = requests[0];
    ok(request);
    const query = new URL(request.url).searchParams;
    const encodedOptions = query.get("simulationOptions");
    ok(encodedOptions);
    expect(deserializeWithBigInt<SimulationOptions>(encodedOptions)).toEqual(simulationOptions);
    expect(query.has("signal")).toBe(false);
    expect(stream.locked).toBe(false);
  });

  it("passes cancellation through raw quote preparation and its map function", async () => {
    const stream = newStream<Quote>(
      [Promise.resolve(quoteSuccess), new Promise(() => {})],
      quoteStreamErrorHandler,
    );
    responses.push(new Response(stream));
    const controller = new AbortController();
    const pending = await prepareQuotes({
      config: createConfig({ proxy: proxy({ pathOrUrl: baseUrl, delegatedActions }) }),
      swap: defaultSwapParams,
      mapFn: async (quote) => (quote.success ? quote.outputAmount : 0n),
      signal: controller.signal,
    });
    expect(await pending[0]).toBe(quoteSuccess.outputAmount);
    expect(signals[0]).toBe(controller.signal);
    const reason = new Error("caller stopped raw quotes");
    controller.abort(reason);
    await Bun.sleep(0);
    await expect(pending[1]).rejects.toBe(reason);
    const request = requests[0];
    ok(request);
    expect(new URL(request.url).searchParams.has("signal")).toBe(false);
    expect(stream.locked).toBe(false);
  });

  it("rejects a pre-aborted preparation without sending a proxy request", async () => {
    const signal = AbortSignal.abort(new Error("already stopped"));
    const config = createConfig({ proxy: proxy({ pathOrUrl: baseUrl, delegatedActions }) });
    await expect(prepareSimulatedQuotes({ config, swap: defaultSwapParams, signal })).rejects.toBe(
      signal.reason,
    );
    await expect(
      prepareQuotes({ config, swap: defaultSwapParams, signal, mapFn: async (quote) => quote }),
    ).rejects.toBe(signal.reason);
    expect(requests).toEqual([]);
  });
});

describe("proxy delegatedActions config", () => {
  it("requires at least one delegated action", () => {
    expect(() =>
      proxy({
        pathOrUrl: "https://example.com/api",
        delegatedActions: [] as unknown as ["prepareQuotes"],
      }),
    ).toThrow("at least one delegated action");
  });

  it("supports delegatedActions using function names", () => {
    const delegated = proxy({
      pathOrUrl: "https://example.com/api",
      delegatedActions: ["prepareQuotes"],
    });
    const both = proxy({
      pathOrUrl: "https://example.com/api",
      delegatedActions: ["prepareQuotes", "prepareSimulatedQuotes"],
    });

    expect(delegated.isDelegatedAction("prepareQuotes")).toBe(true);
    expect(delegated.isDelegatedAction("prepareSimulatedQuotes")).toBe(false);
    expect(both.isDelegatedAction("prepareQuotes")).toBe(true);
    expect(both.isDelegatedAction("prepareSimulatedQuotes")).toBe(true);
  });
});
