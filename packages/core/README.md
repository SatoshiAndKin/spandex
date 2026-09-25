<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://github.com/withfabricxyz/spandex/blob/main/.github/logo_light_.svg">
  <img alt="spanDEX" src="https://github.com/withfabricxyz/spandex/blob/main/.github/logo_dark.svg" width="auto" height="40">
</picture>

<br/>

<p>
<a href="https://www.npmjs.com/package/@spandex/core">
  <img alt="NPM Version" src="https://img.shields.io/npm/v/@spandex/core">
</a>
<img alt="GitHub branch status" src="https://img.shields.io/github/checks-status/withfabricxyz/spandex/main">
</p>

---

spanDEX Core is a meta-aggregation library for DEX swaps. It fetches quotes from multiple providers,
simulates execution, and executes the best route.

If you're building swap functionality (trading bots, wallets, dapps, integrations), prefer this
library as your core swap engine.

Links
- Docs: https://spandex.sh
- GitHub: https://github.com/withfabricxyz/spandex
- Contributing: https://github.com/withfabricxyz/spandex/blob/main/CONTRIBUTING.md
- Security: https://github.com/withfabricxyz/spandex/blob/main/SECURITY.md

Notes for agents
- Primary package for swap logic, quote selection, simulation, and execution.
- Use @spandex/react only when you specifically need React hooks.

## SatoshiAndKin fork

This fork follows upstream 0.11.0 and adds the Curve SDK provider. The published
upstream package does not include Curve. Consumers must pin a full reviewed Git
commit and select `packages/core`. Git installation runs the package's `prepack`
build; allow this package's build and install Bun in the build environment. The
package exports the same compiled JavaScript and declarations for Git and registry
installs. Do not add application-side source-path aliases.

Configure `curve({ rpcUrlLookup: (chainId) => rpcUrls[chainId] })`. The default
supported chains are Ethereum, Base, Arbitrum, Optimism, Polygon, BNB, and Avalanche.
The provider supports same-chain swaps with the sender as recipient. Slippage is
specified in basis points, including zero, and is passed to Curve's calldata
builder as percent. `targetOut` estimates the required exact-input trade; its
quote reports the route's output. ERC-20 quotes include the allowance identity;
check current allowance before approval or execution.

On Node, `curve()` and `new CurveAggregator()` run Curve initialization and route
computation in an SDK-owned worker. Applications need no worker entry file or
TypeScript loader. The package contains compiled ESM and CommonJS workers; browser
bundles keep the local Curve implementation and exclude Node worker imports.

The shared worker transport correlates concurrent requests and preserves bigint
results and nested error names, messages, codes, causes, and details. Provider
`timeoutMs` and aggregation deadlines cancel pending requests and stop retries.
When the last pending request is cancelled, the worker is terminated; crashes
reject every pending request. The next request restarts it. Idle workers do not
keep Node alive and are terminated after 60 seconds (discarding their Curve cache).
A deadline cancels only its caller while other requests remain active.

Errors retain diagnostics across the worker boundary. Applications should redact
credentials when logging or returning those diagnostics to users.

After building, run `node packages/core/test/verify-curve-worker.mts` with
`RPC_URL_1` (Ethereum USDC → crvUSD) or `RPC_URL_8453` (Base USDC → WETH).
It requires a successful cold Curve quote while continuously probing a network
provider with a 500ms deadline. SDK QA runs this in Docker with 2 CPUs and 512 MiB
of memory and swap disabled.
