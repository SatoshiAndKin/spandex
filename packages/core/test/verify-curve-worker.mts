// Run with Node 24 after `bun run build`, including inside the production resource limit.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { curve, KyberAggregator, type SuccessfulQuote, type SwapParams } from "@spandex/core";

const chainId = process.env.RPC_URL_1 ? 1 : 8453;
const rpcUrl = process.env[`RPC_URL_${chainId}`];
if (!rpcUrl) throw new Error("RPC_URL_1 or RPC_URL_8453 is required");
const swap: SwapParams = {
  chainId,
  inputToken:
    chainId === 1
      ? "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
      : "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  outputToken:
    chainId === 1
      ? "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E"
      : "0x4200000000000000000000000000000000000006",
  swapperAccount: "0xEe7aE85f2Fe2239E27D9c1E23fFFe168D63b4055",
  mode: "exactIn",
  inputAmount: 1000000000n,
  slippageBps: 50,
};
const server = createServer((_request, response) => response.end("quote"));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Missing listener");
const url = `http://127.0.0.1:${address.port}`;
class NetworkProvider extends KyberAggregator {
  protected override async tryFetchQuote(): Promise<SuccessfulQuote> {
    assert.equal(await (await fetch(url)).text(), "quote");
    return {
      success: true,
      provider: "kyberswap",
      inputChainId: chainId,
      outputChainId: chainId,
      execution: "atomic",
      inputAmount: 1000000000n,
      outputAmount: 1n,
      networkFee: 0n,
      latency: 0,
      txData: { to: swap.outputToken, data: "0x", value: 0n },
      details: {
        inputAmount: "1000000000",
        outputAmount: "1",
        totalGas: 100000,
        gasPriceGwei: "1",
        gasUsd: 1,
        amountInUsd: 1000,
        amountOutUsd: 1000,
        receivedUsd: 999,
        swaps: [],
        tokens: {},
        encodedSwapData: "0x",
        routerAddress: swap.outputToken,
      },
    };
  }
}

try {
  const start = performance.now();
  const provider = curve({ rpcUrlLookup: () => rpcUrl });
  const cold = provider.fetchQuote(swap, { deadlineMs: 60_000, numRetries: 0 });
  const network = new NetworkProvider({ clientId: "worker-isolation-test" });
  // Probe throughout cold catalog initialization, not only before it starts.
  let done = false;
  let probes = 0;
  let maximumNetworkMs = 0;
  void cold.then(() => {
    done = true;
  });
  while (!done) {
    const began = performance.now();
    const result = await network.fetchQuote(swap, { deadlineMs: 500, numRetries: 0 });
    assert.equal(
      result.success,
      true,
      "Network provider missed its 500ms deadline during cold Curve initialization",
    );
    maximumNetworkMs = Math.max(maximumNetworkMs, performance.now() - began);
    probes++;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const result = await cold;
  // Never print provider diagnostics containing RPC credentials in CI.
  console.log(
    JSON.stringify({
      chainId,
      probes,
      maximumNetworkMs,
      elapsedMs: performance.now() - start,
      curveSuccess: result.success,
      rssBytes: process.memoryUsage().rss,
    }),
  );
  assert.equal(
    result.success,
    true,
    "Cold Curve quote failed; isolation alone is insufficient validation",
  );
  assert.ok(probes > 1, "Expected probes during cold Curve initialization");
} finally {
  server.closeAllConnections();
  server.close();
}
