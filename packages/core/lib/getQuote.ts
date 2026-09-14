import type { PublicClient } from "viem";
import type { Config } from "./createConfig.js";
import { prepareSimulatedQuotes } from "./prepareSimulatedQuotes.js";
import { selectQuote } from "./selectQuote.js";
import type {
  QuoteSelectionStrategy,
  SimulationOptions,
  SuccessfulSimulatedQuote,
  SwapParams,
} from "./types.js";

/**
 * Fetches quotes, simulates them, and selects a winner using the provided strategy.
 * Owns and aborts the proxy stream controller after selection succeeds or fails.
 *
 * @param params - Request parameters.
 * @param params.config - Meta-aggregator configuration and providers.
 * @param params.swap - Swap request parameters.
 * @param params.strategy - Strategy used to pick the winning quote.
 * @param params.client - Optional public client used for simulation.
 * @param params.simulationOptions - Optional simulation controls, including state overrides.
 * @returns Winning quote, or `null` if no provider succeeds.
 */
export async function getQuote({
  config,
  swap,
  strategy,
  client,
  simulationOptions,
}: {
  config: Config;
  swap: SwapParams;
  strategy: QuoteSelectionStrategy;
  client?: PublicClient;
  simulationOptions?: SimulationOptions;
}): Promise<SuccessfulSimulatedQuote | null> {
  const controller = new AbortController();
  try {
    const quotes = await prepareSimulatedQuotes({
      config,
      swap,
      client,
      simulationOptions,
      signal: controller.signal,
    });
    return await selectQuote({ strategy, quotes });
  } finally {
    controller.abort();
  }
}
