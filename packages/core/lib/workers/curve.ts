import { LocalCurveAggregator } from "../aggregators/curve-local.js";
import type { SuccessfulQuote, SwapOptions, SwapParams } from "../types.js";
import { serveWorker } from "./serve.js";

export type CurveWork = {
  swap: SwapParams;
  options: SwapOptions;
  rpcUrl?: string;
  supportedChains?: number[];
};

class WorkerCurve extends LocalCurveAggregator {
  quote(swap: SwapParams, options: SwapOptions) {
    return this.tryFetchQuote(swap, options);
  }
}

const providers = new Map<string, WorkerCurve>();
serveWorker<CurveWork, SuccessfulQuote>(async ({ swap, options, rpcUrl, supportedChains }) => {
  const key = JSON.stringify([swap.chainId, rpcUrl, supportedChains]);
  let provider = providers.get(key);
  if (!provider) {
    provider = new WorkerCurve({ rpcUrlLookup: () => rpcUrl, supportedChains });
    providers.set(key, provider);
  }
  return provider.quote(swap, options);
});
