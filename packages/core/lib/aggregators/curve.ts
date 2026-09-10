import { createCurve } from "@curvefi/api";
import { type Address, formatUnits, parseUnits } from "viem";
import {
  type AggregatorFeature,
  type AggregatorMetadata,
  type PoolEdge,
  type ProviderConfig,
  type ProviderKey,
  QuoteError,
  type RouteGraph,
  type SuccessfulQuote,
  type SwapOptions,
  type SwapParams,
  type TokenNode,
} from "../types.js";
import { isNativeToken } from "../util/helpers.js";
import { Aggregator } from "./index.js";

const CURVE_DOCS_URL = "https://docs.curve.fi/api-docs/api-documentation/";
const DEFAULT_SUPPORTED_CHAINS = [1, 8453, 42161, 10, 137, 56, 43114];

export type CurveConfig = ProviderConfig & {
  /** Function to look up an RPC URL for a chain ID to initialize Curve SDK */
  rpcUrlLookup: (chainId: number) => string | undefined;
  /**
   * Chain IDs this curve deployment should be queried for.
   * Defaults to: Ethereum, Base, Arbitrum, Optimism, Polygon, BNB, Avalanche
   */
  supportedChains?: number[];
};

type CurveSdkInstance = ReturnType<typeof createCurve>;
export type CurveRouteStep = Awaited<
  ReturnType<CurveSdkInstance["router"]["getBestRouteAndOutput"]>
>["route"][number];

export type CurveQuoteResponse = {
  route: CurveRouteStep[];
  inputAmount: string;
  outputAmount: string;
};

type TokenData = { symbol: string; decimals: number };

/**
 * Aggregator implementation for the Curve SDK.
 */
export class CurveAggregator extends Aggregator<CurveConfig> {
  private readonly instances = new Map<string, Promise<CurveSdkInstance>>();
  private readonly tokenData = new Map<string, TokenData>();

  override metadata(): AggregatorMetadata {
    return {
      name: "curve",
      url: "https://curve.fi",
      docsUrl: CURVE_DOCS_URL,
    };
  }

  override name(): ProviderKey {
    return "curve";
  }

  override nativeTokenAddress(): Address {
    // Curve represents the native token internally as 0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
    return "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
  }

  override features(): AggregatorFeature[] {
    return ["exactIn", "targetOut"];
  }

  private supportedChains(): number[] {
    return this.config.supportedChains ?? DEFAULT_SUPPORTED_CHAINS;
  }

  private async getCurveInstance(chainId: number): Promise<CurveSdkInstance> {
    if (!this.supportedChains().includes(chainId)) {
      throw new QuoteError(`Curve aggregator does not support chain ${chainId}`);
    }

    const rpcUrl = this.config.rpcUrlLookup(chainId);
    if (!rpcUrl) {
      throw new QuoteError(`No RPC URL available for Curve SDK initialization on chain ${chainId}`);
    }
    const key = `${chainId}:${rpcUrl}`;
    const cached = this.instances.get(key);
    if (cached) return cached;

    const pending = this.initialize(chainId, rpcUrl).catch((error: unknown) => {
      this.instances.delete(key);
      throw new QuoteError(`Failed to initialize Curve SDK for chain ${chainId}`, { cause: error });
    });
    this.instances.set(key, pending);
    return pending;
  }

  private async initialize(chainId: number, rpcUrl: string): Promise<CurveSdkInstance> {
    const instance = createCurve();
    await instance.init("JsonRpc", { url: rpcUrl }, { chainId });
    await Promise.all([
      instance.factory.fetchPools(),
      instance.crvUSDFactory.fetchPools(),
      instance.cryptoFactory.fetchPools(),
      instance.twocryptoFactory.fetchPools(),
      instance.tricryptoFactory.fetchPools(),
      instance.stableNgFactory.fetchPools(),
    ]);
    return instance;
  }

  private async getCurveTokenData(curve: CurveSdkInstance, address: string): Promise<TokenData> {
    const key = `${curve.chainId}:${address.toLowerCase()}`;
    const cached = this.tokenData.get(key);
    if (cached !== undefined) return cached;

    const [data] = await curve.getCoinsData([address]);
    if (!data || !Number.isInteger(data.decimals) || data.decimals < 0 || data.decimals > 255) {
      throw new QuoteError(`Invalid Curve token metadata for ${address} on chain ${curve.chainId}`);
    }
    const tokenData = { symbol: data.symbol, decimals: data.decimals };
    this.tokenData.set(key, tokenData);
    return tokenData;
  }

  protected override async tryFetchQuote(
    request: SwapParams,
    _options: SwapOptions,
  ): Promise<SuccessfulQuote> {
    if ((request.outputChainId ?? request.chainId) !== request.chainId) {
      throw new QuoteError("Curve aggregator does not support cross-chain quotes");
    }

    const recipient = request.recipientAccount ?? request.swapperAccount;
    if (recipient.toLowerCase() !== request.swapperAccount.toLowerCase()) {
      throw new QuoteError("Curve aggregator does not support separate recipient accounts");
    }

    const curve = await this.getCurveInstance(request.chainId);
    const fromLower = request.inputToken.toLowerCase();
    const toLower = request.outputToken.toLowerCase();

    const [inData, outData] = await Promise.all([
      this.getCurveTokenData(curve, fromLower),
      this.getCurveTokenData(curve, toLower),
    ]);

    let inputAmountDecimalStr: string;
    let outputAmountDecimalStr: string;
    let route: CurveRouteStep[];

    try {
      if (request.mode === "targetOut") {
        const outDecimalStr = formatUnits(request.outputAmount, outData.decimals);
        const requiredInput = await curve.router.required(fromLower, toLower, outDecimalStr);
        inputAmountDecimalStr = requiredInput;
        const routeResult = await curve.router.getBestRouteAndOutput(
          fromLower,
          toLower,
          inputAmountDecimalStr,
        );
        route = routeResult.route;
        outputAmountDecimalStr = routeResult.output;
      } else {
        const inDecimalStr = formatUnits(request.inputAmount, inData.decimals);
        const routeResult = await curve.router.getBestRouteAndOutput(
          fromLower,
          toLower,
          inDecimalStr,
        );
        route = routeResult.route;
        inputAmountDecimalStr = inDecimalStr;
        outputAmountDecimalStr = routeResult.output;
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (errorMsg.includes("This method exists only for L2 networks")) {
        throw new QuoteError(
          `No Curve route found for ${request.inputToken}→${request.outputToken} on chain ${request.chainId}. The pair may not be supported by Curve pools on this chain.`,
          { cause: err },
        );
      }
      throw new QuoteError(`Curve quote failed: ${errorMsg}`, err);
    }

    if (!route || route.length === 0) {
      throw new QuoteError(
        `No Curve route found for ${request.inputToken}→${request.outputToken} on chain ${request.chainId}.`,
      );
    }

    const swapTx = await curve.router.populateSwap(
      fromLower,
      toLower,
      inputAmountDecimalStr,
      request.slippageBps / 100,
    );
    if (!swapTx.to || !swapTx.data) {
      throw new QuoteError("Failed to generate Curve swap transaction");
    }

    // Convert decimal strings back to raw wei bigint
    const inputAmountRaw = parseUnits(inputAmountDecimalStr, inData.decimals);
    const outputAmountRaw = parseUnits(outputAmountDecimalStr, outData.decimals);

    // Expose the allowance identity even when the wallet already has sufficient allowance.
    // buildCalls and consumers check its current value before submitting an approval.
    const approval = isNativeToken(request.inputToken)
      ? undefined
      : { token: request.inputToken, spender: swapTx.to as Address };

    return {
      success: true,
      provider: "curve",
      details: { route, inputAmount: inputAmountDecimalStr, outputAmount: outputAmountDecimalStr },
      latency: 0,
      inputChainId: request.chainId,
      outputChainId: request.chainId,
      execution: "atomic",
      inputAmount: inputAmountRaw,
      outputAmount: outputAmountRaw,
      networkFee: 0n,
      txData: {
        to: swapTx.to as Address,
        data: swapTx.data as `0x${string}`,
        ...(swapTx.value ? { value: BigInt(swapTx.value) } : {}),
      },
      approval,
      route: await this.buildRouteGraph(curve, route, request),
    };
  }

  private async buildRouteGraph(
    curve: CurveSdkInstance,
    route: CurveRouteStep[],
    _request: SwapParams,
  ): Promise<RouteGraph> {
    const nodeMap = new Map<string, TokenNode>();
    const edges: PoolEdge[] = [];

    const addNode = async (address: string) => {
      const addrLower = address.toLowerCase();
      if (!nodeMap.has(addrLower)) {
        const tokenData = await this.getCurveTokenData(curve, address);
        nodeMap.set(addrLower, {
          address: address as Address,
          symbol: tokenData.symbol,
        });
      }
    };

    for (const step of route) {
      if (step.inputCoinAddress) await addNode(step.inputCoinAddress);
      if (step.outputCoinAddress) await addNode(step.outputCoinAddress);

      if (step.inputCoinAddress && step.outputCoinAddress) {
        edges.push({
          source: step.inputCoinAddress as Address,
          target: step.outputCoinAddress as Address,
          address: step.poolAddress as Address | undefined,
          key:
            step.poolId || step.poolAddress || `${step.inputCoinAddress}-${step.outputCoinAddress}`,
          value: 0,
        });
      }
    }

    return {
      nodes: [...nodeMap.values()],
      edges,
    };
  }
}

export function curve(config: CurveConfig): CurveAggregator {
  return new CurveAggregator(config);
}
