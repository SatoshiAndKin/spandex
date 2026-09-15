export function createMockQuote(overrides?: {
  provider?: string;
  outputAmount?: bigint;
  inputAmount?: bigint;
  networkFee?: bigint;
  latency?: number;
}) {
  return {
    success: true,
    provider: overrides?.provider || "fabric",
    outputAmount: overrides?.outputAmount || 1000000n,
    inputAmount: overrides?.inputAmount || 500000000n,
    networkFee: overrides?.networkFee || 100000n,
    latency: overrides?.latency || 150,
    txData: { to: "0xabc", data: "0x123", value: 0n },
  };
}
