import { beforeEach, describe, expect, it, mock } from "bun:test";
import { parseUnits } from "viem";
import { defaultSwapParams } from "../../test/utils.js";
import { curve } from "./curve.js";

const ROUTER = "0x1111111111111111111111111111111111111111";
const POOL = "0x2222222222222222222222222222222222222222";
const INPUT_TOKEN = defaultSwapParams.inputToken.toLowerCase();
const OUTPUT_TOKEN = defaultSwapParams.outputToken.toLowerCase();

const mockCurveInstance = {
  chainId: 8453,
  init: mock(async () => {}),
  factory: { fetchPools: mock(async () => {}) },
  crvUSDFactory: { fetchPools: mock(async () => {}) },
  cryptoFactory: { fetchPools: mock(async () => {}) },
  twocryptoFactory: { fetchPools: mock(async () => {}) },
  tricryptoFactory: { fetchPools: mock(async () => {}) },
  stableNgFactory: { fetchPools: mock(async () => {}) },
  getCoinsData: mock(async (addresses: string[]) => {
    return addresses.map((a) => {
      if (a === INPUT_TOKEN) return { symbol: "IN", decimals: 18 };
      if (a === OUTPUT_TOKEN) return { symbol: "OUT", decimals: 6 };
      return { symbol: "UNK", decimals: 18 };
    });
  }),
  hasAllowance: mock(async () => true),
  router: {
    getBestRouteAndOutput: mock(async (from: string, to: string, _amount: string) => {
      return {
        route: [
          {
            inputCoinAddress: from,
            outputCoinAddress: to,
            poolAddress: POOL,
            poolId: "pool-1",
          },
        ],
        output: "123.456789",
      };
    }),
    populateSwap: mock(async () => {
      return {
        to: ROUTER,
        data: "0x1234",
        value: "0",
      };
    }),
    required: mock(async () => {
      return "500.0";
    }),
  },
};

mock.module("@curvefi/api", () => {
  return {
    createCurve: () => mockCurveInstance,
  };
});

describe("curve", () => {
  beforeEach(() => {
    mockCurveInstance.init.mockClear();
    mockCurveInstance.router.populateSwap.mockClear();
  });

  it("shares concurrent initialization and retries after a failed initialization", async () => {
    const aggregator = curve({ rpcUrlLookup: () => "https://test.rpc" });
    mockCurveInstance.init.mockRejectedValueOnce(new Error("RPC unavailable"));
    const failed = await aggregator.fetchQuote(defaultSwapParams, { numRetries: 0 });
    expect(failed.success).toBe(false);
    const quotes = await Promise.all([
      aggregator.fetchQuote(defaultSwapParams, { numRetries: 0 }),
      aggregator.fetchQuote(defaultSwapParams, { numRetries: 0 }),
    ]);
    expect(quotes.map((quote) => quote.success)).toEqual([true, true]);
    expect(mockCurveInstance.init).toHaveBeenCalledTimes(2);
  });

  it("does not reuse SDK state across different configured RPC endpoints", async () => {
    await curve({ rpcUrlLookup: () => "https://first.rpc" }).fetchQuote(defaultSwapParams);
    await curve({ rpcUrlLookup: () => "https://second.rpc" }).fetchQuote(defaultSwapParams);
    expect(mockCurveInstance.init).toHaveBeenNthCalledWith(
      1,
      "JsonRpc",
      { url: "https://first.rpc" },
      { chainId: 8453 },
    );
    expect(mockCurveInstance.init).toHaveBeenNthCalledWith(
      2,
      "JsonRpc",
      { url: "https://second.rpc" },
      { chainId: 8453 },
    );
  });

  it("does not substitute 18 decimals when metadata lookup fails", async () => {
    mockCurveInstance.getCoinsData.mockRejectedValueOnce(new Error("metadata unavailable"));
    const quote = await curve({ rpcUrlLookup: () => "https://test.rpc" }).fetchQuote(
      defaultSwapParams,
      { numRetries: 0 },
    );
    expect(quote.success).toBe(false);
    expect(mockCurveInstance.router.populateSwap).not.toHaveBeenCalled();
  });

  it("keeps zero-decimal token amounts", async () => {
    mockCurveInstance.getCoinsData.mockResolvedValueOnce([{ symbol: "ZERO", decimals: 0 }]);
    const quote = await curve({ rpcUrlLookup: () => "https://test.rpc" }).fetchQuote(
      { ...defaultSwapParams, inputAmount: 1n },
      { numRetries: 0 },
    );
    expect(quote.success && quote.inputAmount).toBe(1n);
    expect(mockCurveInstance.router.populateSwap).toHaveBeenCalledWith(
      INPUT_TOKEN,
      OUTPUT_TOKEN,
      "1",
      1,
    );
  });

  it("omits approval for native input", async () => {
    const quote = await curve({ rpcUrlLookup: () => "https://test.rpc" }).fetchQuote(
      { ...defaultSwapParams, inputToken: "0x0000000000000000000000000000000000000000" },
      { numRetries: 0 },
    );
    expect(quote.success && quote.approval).toBeUndefined();
  });

  it.each([0, 10, 50, 100])("passes %i basis points for targetOut", async (slippageBps) => {
    const quote = await curve({ rpcUrlLookup: () => "https://test.rpc" }).fetchQuote(
      {
        chainId: 8453,
        inputToken: defaultSwapParams.inputToken,
        outputToken: defaultSwapParams.outputToken,
        swapperAccount: defaultSwapParams.swapperAccount,
        mode: "targetOut",
        outputAmount: 123456789n,
        slippageBps,
      },
      { numRetries: 0 },
    );
    expect(quote.success && quote.outputAmount).toBe(123456789n);
    expect(mockCurveInstance.router.populateSwap).toHaveBeenCalledWith(
      INPUT_TOKEN,
      OUTPUT_TOKEN,
      "500.0",
      slippageBps / 100,
    );
  });

  it.each([0, 10, 50, 100])("passes %i basis points to Curve as percent", async (slippageBps) => {
    mockCurveInstance.router.populateSwap.mockClear();
    const aggregator = curve({ rpcUrlLookup: () => "https://test.rpc" });
    await aggregator.fetchQuote({ ...defaultSwapParams, slippageBps }, { numRetries: 0 });
    expect(mockCurveInstance.router.populateSwap).toHaveBeenCalledWith(
      INPUT_TOKEN,
      OUTPUT_TOKEN,
      "0.0000000005",
      slippageBps / 100,
    );
  });

  it("provides metadata", () => {
    const aggregator = curve({
      rpcUrlLookup: () => "https://test.rpc",
    });
    expect(aggregator.name()).toBe("curve");
    expect(aggregator.features()).toEqual(["exactIn", "targetOut"]);
    const metadata = aggregator.metadata();
    expect(metadata.name).toBe("curve");
    expect(metadata.url).toMatch(/curve/);
    expect(metadata.docsUrl).toBe("https://docs.curve.fi/api-docs/api-documentation/");
  });

  it("fetches an exactIn quote", async () => {
    mockCurveInstance.router.getBestRouteAndOutput.mockClear();

    const aggregator = curve({
      rpcUrlLookup: () => "https://test.rpc",
    });

    const quote = await aggregator.fetchQuote(
      {
        ...defaultSwapParams,
        inputAmount: parseUnits("500.0", 18),
      },
      { numRetries: 0 },
    );

    expect(quote.success).toBe(true);
    if (!quote.success) throw new Error("Expected successful quote");

    expect(quote.provider).toBe("curve");
    expect(quote.inputAmount).toBe(parseUnits("500.0", 18));
    expect(quote.outputAmount).toBe(parseUnits("123.456789", 6));
    expect(quote.txData.to).toBe(ROUTER);
    expect(quote.txData.data).toBe("0x1234");
    expect(quote.approval).toEqual({ token: defaultSwapParams.inputToken, spender: ROUTER });

    expect(quote.route?.nodes.length).toBe(2);
    expect(quote.route?.edges.length).toBe(1);
    expect(quote.route?.edges[0]?.address).toBe(POOL);
  });

  it("fetches a targetOut quote", async () => {
    mockCurveInstance.router.required.mockClear();
    mockCurveInstance.router.getBestRouteAndOutput.mockClear();

    const aggregator = curve({
      rpcUrlLookup: () => "https://test.rpc",
    });

    const quote = await aggregator.fetchQuote(
      {
        chainId: 8453,
        inputToken: defaultSwapParams.inputToken,
        outputToken: defaultSwapParams.outputToken,
        outputAmount: parseUnits("123.456789", 6),
        slippageBps: 100,
        swapperAccount: defaultSwapParams.swapperAccount,
        mode: "targetOut",
      },
      { numRetries: 0 },
    );

    expect(quote.success).toBe(true);
    if (!quote.success) throw new Error("Expected successful quote");

    expect(quote.provider).toBe("curve");
    expect(quote.inputAmount).toBe(parseUnits("500.0", 18));
    expect(quote.outputAmount).toBe(parseUnits("123.456789", 6));

    // Verify required was called
    expect(mockCurveInstance.router.required).toHaveBeenCalled();
  });

  it("does not support cross-chain quotes", async () => {
    const aggregator = curve({
      rpcUrlLookup: () => "https://test.rpc",
    });

    const quote = await aggregator.fetchQuote(
      {
        ...defaultSwapParams,
        outputChainId: 1,
      },
      { numRetries: 0 },
    );

    expect(quote.success).toBe(false);
  });

  it("rejects separate recipient accounts", async () => {
    const aggregator = curve({
      rpcUrlLookup: () => "https://test.rpc",
    });

    const quote = await aggregator.fetchQuote(
      {
        ...defaultSwapParams,
        recipientAccount: "0x0000000000000000000000000000000000000001",
      },
      { numRetries: 0 },
    );

    expect(quote.success).toBe(false);
  });
});
