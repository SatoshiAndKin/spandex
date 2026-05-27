import { describe, expect, it, mock } from "bun:test";
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
    expect(quote.approval).toBeUndefined(); // mock hasAllowance returns true

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
