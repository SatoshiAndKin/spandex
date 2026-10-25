import assert from "node:assert/strict";
import { createPublicClient, http, zeroAddress } from "viem";
import { simulateCalls } from "viem/actions";
import { base } from "viem/chains";

const url = process.env.RPC_URL_8453;
assert.ok(url, "RPC_URL_8453 is required");
const client = createPublicClient({
  chain: base,
  transport: http(url, { timeout: 10_000, retryCount: 0 }),
});
let stage = "eth_chainId";
try {
  assert.equal(await client.getChainId(), base.id, "RPC must serve Base");
  stage = "eth_getBlockByNumber";
  const block = await client.getBlock();
  stage = "eth_simulateV1";
  const simulation = await simulateCalls(client, { calls: [{ to: zeroAddress, data: "0x" }] });
  assert.equal(simulation.results[0]?.status, "success", "RPC must support call simulation");
  console.log(
    JSON.stringify({ chainId: base.id, block: block.number.toString(), simulation: "success" }),
  );
} catch (error) {
  // Provider errors can contain credentials. Report only the failed RPC method and type.
  const type = error instanceof Error ? error.name : typeof error;
  throw new Error(`Base RPC preflight failed at ${stage} (${type})`);
}
