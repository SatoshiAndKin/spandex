import { describe, expect, it } from "bun:test";
import type { PublicClient, StateOverride } from "viem";
import { decodeFunctionData, erc20Abi, parseEther, toHex } from "viem";
import { base } from "viem/chains";
import { defaultSwapParams, quoteSuccess } from "../test/utils.js";
import { mergeSimulationStateOverrides, simulateQuote, simulateQuotes } from "./simulateQuote.js";
import type { SimulationOptions, SuccessfulQuote } from "./types.js";

const slot = toHex(1n, { size: 32 });
const slotValue = toHex(500_000_000n, { size: 32 });

describe("simulation state overrides", () => {
  it("uses the provider's approval token and spender for both approval calls", async () => {
    const requests: CapturedRequest[] = [];
    const approval = {
      token: "0x3333333333333333333333333333333333333333",
      spender: "0x4444444444444444444444444444444444444444",
    } as const;
    await simulateQuote({
      client: createSimulationClient(requests),
      swap: defaultSwapParams,
      quote: { ...validQuote(), approval },
    });
    const calls = requests[0]?.params[0].blockStateCalls[0]?.calls.slice(0, 2);
    expect(calls?.map((call) => call.to)).toEqual([approval.token, approval.token]);
    expect(
      calls?.map(
        (call) => decodeFunctionData({ abi: erc20Abi, data: call.data as `0x${string}` }).args?.[0],
      ),
    ).toEqual([approval.spender, approval.spender]);
  });

  it("does not approve native input", async () => {
    const requests: CapturedRequest[] = [];
    const quote = await simulateQuote({
      client: createSimulationClient(requests),
      swap: { ...defaultSwapParams, inputToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" },
      quote: validQuote(),
    });
    expect(quote.simulation.success).toBe(true);
    if (quote.simulation.success) {
      expect(quote.simulation.approvalGasUsed).toBeUndefined();
      expect(quote.simulation.outputAmount).toBe(100n);
    }
    expect(
      requests[0]?.params[0].blockStateCalls[0]?.calls.some((call) =>
        String(call.data).startsWith("0x095ea7b3"),
      ),
    ).toBe(false);
  });

  it("reports a failed reset instead of hiding it", async () => {
    const quote = await simulateQuote({
      client: createSimulationClient([], { rejectReset: true }),
      swap: defaultSwapParams,
      quote: validQuote(),
    });
    expect(quote.simulation.success).toBe(false);
  });
  it.each([
    false,
    true,
  ])("resets an existing token allowance before simulating (cross-chain: %s)", async (crossChain) => {
    const requests: CapturedRequest[] = [];
    const quote = await simulateQuote({
      client: createSimulationClient(requests, { allowance: 123n }),
      swap: { ...defaultSwapParams, ...(crossChain ? { outputChainId: 10 } : {}) },
      quote: validQuote(),
    });
    expect(quote.simulation.success).toBe(true);
    if (quote.simulation.success) {
      expect(quote.simulation.approvalGasUsed).toBe(2n);
      expect(quote.simulation.gasUsed).toBe(1n);
    }
    const approvals = requests[0]?.params[0].blockStateCalls[0]?.calls.filter((call) =>
      String(call.data).startsWith("0x095ea7b3"),
    );
    expect(
      approvals?.map(
        (call) => decodeFunctionData({ abi: erc20Abi, data: call.data as `0x${string}` }).args?.[1],
      ),
    ).toEqual([0n, validQuote().inputAmount]);
  });
  it("uses the RPC gas price on the swap without charging balance probes", async () => {
    const requests: CapturedRequest[] = [];
    const quote = await simulateQuote({
      client: createSimulationClient(requests),
      swap: defaultSwapParams,
      quote: validQuote(),
    });
    expect(quote.simulation.success).toBe(true);
    expect(requests[0]?.params[0].blockStateCalls[0]?.calls.map((call) => call.gasPrice)).toEqual([
      undefined,
      undefined,
      undefined,
      "0x64",
      undefined,
      undefined,
    ]);
  });

  it("uses an explicit zero gas price without requesting an estimate", async () => {
    const requests: CapturedRequest[] = [];
    const client = createSimulationClient(requests);
    client.getGasPrice = async () => {
      throw new Error("must not fetch");
    };
    const quote = await simulateQuote({
      client,
      swap: defaultSwapParams,
      quote: validQuote(),
      simulationOptions: { gasPrice: 0n },
    });
    expect(quote.simulation.success).toBe(true);
    expect(requests[0]?.params[0].blockStateCalls[0]?.calls[3]?.gasPrice).toBe("0x0");
  });

  it("fails simulation when the gas price cannot be obtained", async () => {
    const requests: CapturedRequest[] = [];
    const client = createSimulationClient(requests);
    client.getGasPrice = async () => {
      throw new Error("gas price unavailable");
    };
    const quote = await simulateQuote({ client, swap: defaultSwapParams, quote: validQuote() });
    expect(quote.simulation.success).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it.each([false, true])("rejects gas-sensitive reverts (cross-chain: %s)", async (crossChain) => {
    const quote = await simulateQuote({
      client: createSimulationClient([], { rejectPricedSwap: true }),
      swap: { ...defaultSwapParams, ...(crossChain ? { outputChainId: 10 } : {}) },
      quote: validQuote(),
    });
    expect(quote.simulation.success).toBe(false);
  });

  it.each(["payer", "recipient", "token"])("keeps gross output for %s", async (recipient) => {
    const native = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    const quote = await simulateQuote({
      client: createSimulationClient([], {
        before: 10000n,
        after: recipient === "payer" ? 9000n : 11000n,
      }),
      swap: {
        ...defaultSwapParams,
        ...(recipient !== "token" ? { outputToken: native } : {}),
        ...(recipient === "recipient"
          ? { recipientAccount: "0x5555555555555555555555555555555555555555" as const }
          : {}),
      },
      quote: validQuote(),
      simulationOptions: { gasPrice: 2000n },
    });
    expect(quote.simulation.success).toBe(true);
    if (quote.simulation.success) expect(quote.simulation.outputAmount).toBe(1000n);
  });

  it("keeps defaults, adds other accounts, and lets caller values win", () => {
    const swapper = "0x2222222222222222222222222222222222222222";
    const token = "0x4444444444444444444444444444444444444444";
    const base: StateOverride = [{ address: swapper, balance: parseEther("10000") }];
    const extra: StateOverride = [
      {
        address: swapper,
        balance: 123n,
        stateDiff: [{ slot: "0x01", value: "0x02" }],
      },
      {
        address: token,
        balance: 1n,
      },
    ];

    expect(mergeSimulationStateOverrides(base, extra)).toEqual([
      {
        address: swapper,
        balance: 123n,
        stateDiff: [{ slot: "0x01", value: "0x02" }],
      },
      {
        address: token,
        balance: 1n,
      },
    ]);
  });

  it("matches addresses and storage slots case-insensitively", () => {
    const lowerAddress = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const upperAddress = "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD";
    const merged = mergeSimulationStateOverrides(
      [
        {
          address: lowerAddress,
          stateDiff: [
            { slot: "0xAA", value: "0x01" },
            { slot: "0xbb", value: "0x02" },
          ],
        },
      ],
      [
        {
          address: upperAddress,
          stateDiff: [
            { slot: "0xaa", value: "0x03" },
            { slot: "0xCC", value: "0x04" },
          ],
        },
      ],
    );

    expect(merged).toEqual([
      {
        address: upperAddress,
        stateDiff: [
          { slot: "0xaa", value: "0x03" },
          { slot: "0xbb", value: "0x02" },
          { slot: "0xCC", value: "0x04" },
        ],
      },
    ]);
  });

  it("uses an incoming full state instead of an existing stateDiff", () => {
    const address = "0x3333333333333333333333333333333333333333";
    const merged = mergeSimulationStateOverrides(
      [{ address, stateDiff: [{ slot: "0x01", value: "0x01" }] }],
      [{ address, state: [{ slot: "0x02", value: "0x02" }] }],
    );

    expect(merged).toEqual([
      {
        address,
        state: [{ slot: "0x02", value: "0x02" }],
      },
    ]);
  });

  it("uses an incoming stateDiff instead of an existing full state", () => {
    const address = "0x3333333333333333333333333333333333333333";
    const merged = mergeSimulationStateOverrides(
      [{ address, state: [{ slot: "0x01", value: "0x01" }] }],
      [{ address, stateDiff: [{ slot: "0x02", value: "0x02" }] }],
    );

    expect(merged).toEqual([
      {
        address,
        stateDiff: [{ slot: "0x02", value: "0x02" }],
      },
    ]);
  });

  it("injects merged overrides into same-chain simulateCalls", async () => {
    const requests: CapturedRequest[] = [];
    const client = createSimulationClient(requests);
    const simulationOptions: SimulationOptions = {
      stateOverrides: [
        {
          address: defaultSwapParams.swapperAccount,
          balance: 123n,
        },
        {
          address: defaultSwapParams.inputToken,
          stateDiff: [{ slot, value: slotValue }],
        },
      ],
    };

    const quote = await simulateQuote({
      client,
      swap: defaultSwapParams,
      quote: validQuote(),
      simulationOptions,
    });

    expect(quote.simulation.success).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.params[0].blockStateCalls[0]?.stateOverrides).toEqual({
      [defaultSwapParams.swapperAccount]: {
        balance: "0x7b",
      },
      [defaultSwapParams.inputToken]: {
        stateDiff: {
          [slot]: slotValue,
        },
      },
    });
  });

  it("threads overrides through batch cross-chain simulation", async () => {
    const requests: CapturedRequest[] = [];
    const client = createSimulationClient(requests);
    const crossChainSwap = {
      ...defaultSwapParams,
      outputChainId: 10,
    };
    const simulationOptions: SimulationOptions = {
      stateOverrides: [
        {
          address: defaultSwapParams.inputToken,
          stateDiff: [{ slot, value: slotValue }],
        },
      ],
    };

    const quotes = await simulateQuotes({
      client,
      swap: crossChainSwap,
      quotes: [{ ...validQuote(), outputChainId: 10 }],
      simulationOptions,
    });

    expect(quotes[0]?.simulation.success).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.params[0].blockStateCalls[0]?.stateOverrides).toEqual({
      [defaultSwapParams.swapperAccount]: {
        balance: toHex(parseEther("10000")),
      },
      [defaultSwapParams.inputToken]: {
        stateDiff: {
          [slot]: slotValue,
        },
      },
    });
  });
});

type CapturedRequest = {
  method: string;
  params: [
    {
      blockStateCalls: Array<{
        calls: Record<string, unknown>[];
        stateOverrides?: Record<string, unknown>;
      }>;
    },
    unknown,
  ];
};

function validQuote(): SuccessfulQuote {
  return {
    ...quoteSuccess,
    txData: {
      to: "0x1111111111111111111111111111111111111111",
      data: "0x",
    },
  };
}

function createSimulationClient(
  requests: CapturedRequest[],
  options: {
    before?: bigint;
    after?: bigint;
    rejectPricedSwap?: boolean;
    allowance?: bigint;
    rejectReset?: boolean;
  } = {},
): PublicClient {
  return {
    chain: base,
    getGasPrice: async () => 100n,
    request: async (request: CapturedRequest) => {
      requests.push(request);
      const calls = request.params[0].blockStateCalls[0]?.calls ?? [];
      const swapIndex = calls.findIndex((call) => call.gasPrice !== undefined);
      let allowance = options.allowance ?? 0n;
      return [
        {
          number: "0x1",
          calls: calls.map((call, index) => {
            let approvalFailed = false;
            if (String(call.data).startsWith("0x095ea7b3")) {
              const decoded = decodeFunctionData({
                abi: erc20Abi,
                data: call.data as `0x${string}`,
              });
              const amount = decoded.args?.[1] as bigint;
              approvalFailed =
                (allowance > 0n && amount > 0n) || (options.rejectReset === true && amount === 0n);
              if (!approvalFailed) allowance = amount;
            }
            return {
              status: approvalFailed || (options.rejectPricedSwap && call.gasPrice) ? "0x0" : "0x1",
              ...(options.rejectPricedSwap && call.gasPrice
                ? { error: { code: 3, message: "gas price rejected" } }
                : {}),
              gasUsed: "0x1",
              returnData:
                index === swapIndex - 1
                  ? toHex(options.before ?? 100n, { size: 32 })
                  : index === swapIndex + 1
                    ? toHex(options.after ?? 200n, { size: 32 })
                    : "0x",
            };
          }),
        },
      ];
    },
  } as unknown as PublicClient;
}
