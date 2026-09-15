import { describe, expect, it } from "bun:test";
import { defaultSwapParams, simulatedQuoteSuccess, testConfig } from "../../test/utils.js";
import { fabric } from "../aggregators/fabric.js";
import { relay } from "../aggregators/relay.js";
import { prepareQuotes } from "../prepareQuotes.js";
import type { Quote, SimulatedQuote } from "../types.js";
import {
  decodeStream,
  newStream,
  quoteStreamErrorHandler,
  simulatedQuoteStreamErrorHandler,
} from "./streams.js";

const simulatedQuote = simulatedQuoteSuccess;

describe("streaming", () => {
  it("properly streams serialized quotes", async () => {
    const quotes = await prepareQuotes({
      swap: defaultSwapParams,
      config: testConfig([fabric({ appId: "test-fabric-key" }), relay({})]),
      mapFn: async (quote) => {
        return quote;
      },
    });

    const stream = newStream<Quote>(quotes, quoteStreamErrorHandler);
    const decodedPromises = await decodeStream<Quote>(stream);
    const decoded = await Promise.all(decodedPromises);
    expect(decoded.length).toBe(quotes.length);
    expect(decoded.find((q) => q.provider === "fabric")).toBeDefined();
    expect(decoded.find((q) => q.provider === "relay")).toBeDefined();
    expect(decoded.every((q) => typeof q.success === "boolean")).toBe(true);
  }, 10_000);

  it("properly streams serialized simulated quotes", async () => {
    const stream = newStream<SimulatedQuote>(
      [Promise.resolve(simulatedQuote)],
      simulatedQuoteStreamErrorHandler,
    );
    const decodedPromises = await decodeStream<SimulatedQuote>(stream);
    const decoded = await Promise.all(decodedPromises);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]?.simulation.success).toBe(true);
  });

  it("supports generic stream helpers", async () => {
    const stream = newStream<SimulatedQuote>(
      [Promise.resolve(simulatedQuote)],
      simulatedQuoteStreamErrorHandler,
    );
    const decodedPromises = await decodeStream<SimulatedQuote>(stream);
    const decoded = await Promise.all(decodedPromises);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]?.provider).toBe("fabric");
  });
});
