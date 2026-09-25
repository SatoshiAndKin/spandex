import type { SuccessfulQuote, SwapOptions, SwapParams } from "../types.js";
import { WorkerClient } from "../workers/client.js";
import type { CurveWork } from "../workers/curve.js";
import { type CurveConfig, LocalCurveAggregator } from "./curve-local.js";

export type { CurveConfig, CurveQuoteResponse, CurveRouteStep } from "./curve-local.js";

/** Curve uses the SDK's packaged worker on Node and runs locally in browsers. */
export class CurveAggregator extends LocalCurveAggregator {
  private executor?: Promise<WorkerClient<CurveWork, SuccessfulQuote> | undefined>;

  protected override async tryFetchQuote(
    swap: SwapParams,
    options: SwapOptions,
    signal?: AbortSignal,
  ): Promise<SuccessfulQuote> {
    if (typeof process === "undefined" || !process.versions?.node) {
      return super.tryFetchQuote(swap, options);
    }
    this.executor ??= import("../workers/node.cjs").then(({ default: runtime }) =>
      runtime.createCurveWorker
        ? new WorkerClient<CurveWork, SuccessfulQuote>(runtime.createCurveWorker)
        : undefined,
    );
    const executor = await this.executor;
    if (!executor) return super.tryFetchQuote(swap, options);
    // Resolve functions on the caller thread; only cloneable request data crosses the boundary.
    const rpcUrl = this.config.rpcUrlLookup(swap.chainId);
    return executor.request(
      { swap, options, rpcUrl, supportedChains: this.config.supportedChains },
      signal,
    );
  }
}

export function curve(config: CurveConfig): CurveAggregator {
  return new CurveAggregator(config);
}
