import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const core = new URL("../../", import.meta.url).pathname;
let directory: string;
let packed: string;

async function run(cmd: string[], cwd: string) {
  const child = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${cmd[0]} failed (${exitCode}): ${stderr}\n${stdout}`);
  return stdout;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "spandex-package-"));
  await run(["bun", "pm", "pack", "--ignore-scripts", "--destination", directory], core);
  const archive = (await Array.fromAsync(new Bun.Glob("*.tgz").scan(directory)))[0];
  if (!archive) throw new Error("Package archive missing; run bun run build first");
  await run(["tar", "-xzf", join(directory, archive), "-C", directory], core);
  packed = join(directory, "package");
  await symlink(resolve(core, "node_modules"), join(packed, "node_modules"), "dir");
  for (const name of ["echo", "blocking"]) {
    const result = await Bun.build({
      entrypoints: [join(core, "test/workers", `${name}.ts`)],
      outdir: packed,
      target: "node",
      naming: "[name].mjs",
    });
    if (!result.success) throw new AggregateError(result.logs, "Fixture build failed");
  }
}, 20_000);
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const exercise = `
const assert = requireAssert;
const swap = {
 chainId: 1, inputToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
 outputToken: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E",
 swapperAccount: "0xEe7aE85f2Fe2239E27D9c1E23fFFe168D63b4055",
 mode: "exactIn", inputAmount: 1000000000n, slippageBps: 50,
};
const provider = sdk.curve({ rpcUrlLookup: () => "invalid-rpc-url" });
const quote = await provider.fetchQuote(swap, { numRetries: 0, deadlineMs: 10000 });
assert.equal(quote.success, false);
assert.equal(quote.error.name, "QuoteError");
assert.equal(quote.error.message, "Failed to initialize Curve SDK for chain 1");
assert.equal(quote.error.details.cause.code, "UNSUPPORTED_OPERATION");
assert.ok(quote.error.details.cause instanceof Error);
const deadlineProvider = sdk.curve({ rpcUrlLookup: () => "invalid-rpc-url", timeoutMs: 10 });
const deadline = await deadlineProvider.fetchQuote(swap, { numRetries: 10 });
assert.equal(deadline.success, false);
assert.match(deadline.error.message, /deadline exceeded after 10ms/);
console.log("packaged worker passed");
`;

describe("published worker package", () => {
  it.each([
    "module",
    "commonjs",
  ])("runs normal curve() in Node %s without a loader and exits when idle", async (format) => {
    const prefix =
      format === "module"
        ? 'import * as sdk from "@spandex/core"; import requireAssert from "node:assert/strict";'
        : 'const sdk = require("@spandex/core"); const requireAssert = require("node:assert/strict");';
    const script =
      format === "module"
        ? `${prefix}\n${exercise}`
        : `${prefix}\n(async () => { ${exercise} })().catch(error => { console.error(error); process.exitCode = 1; });`;
    expect(await run(["node", `--input-type=${format}`, "-e", script], packed)).toContain(
      "packaged worker passed",
    );
  }, 15_000);

  it("preserves fatal diagnostics and restarts with actual Node workers", async () => {
    const script = `
      import assert from "node:assert/strict";
      import { Worker } from "node:worker_threads";
      import { WorkerClient } from "./dist/esm/lib/workers/client.js";
      const client = new WorkerClient(() => new Worker(new URL("./blocking.mjs", import.meta.url), {execArgv: []}));
      const results = await Promise.allSettled([client.request({action: "crash"}), client.request({action: "hang"})]);
      for (const result of results) {
        assert.equal(result.status, "rejected");
        assert.equal(result.reason.code, "FIXTURE_CRASH");
        assert.deepEqual(result.reason.details, {amount: 99n});
        assert.equal(result.reason.cause.message, "Crash cause");
        assert.ok(result.reason.cause instanceof Error);
      }
      assert.deepEqual(await client.request({}), {completed: true});
      client.close();
    `;
    await run(["node", "--input-type=module", "-e", script], packed);
  });

  it("bundles browser imports without Node worker builtins", async () => {
    const entry = join(packed, "browser-consumer.ts");
    await writeFile(
      entry,
      'import { curve } from "@spandex/core"; globalThis.curveProvider = curve({rpcUrlLookup: () => undefined});',
    );
    await mkdir(join(directory, "browser"));
    const result = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      outdir: join(directory, "browser"),
    });
    if (!result.success) throw new AggregateError(result.logs, "Browser package build failed");
    expect(result.success).toBe(true);
    const output = result.outputs[0];
    if (!output) throw new Error("Browser bundle missing");
    // Execute the bundle without Node globals to verify the browser import surface.
    const script = `const {runInNewContext} = require("node:vm"); const {readFileSync} = require("node:fs"); const {webcrypto} = require("node:crypto"); const context = { TextEncoder, TextDecoder, URL, URLSearchParams, crypto: webcrypto, fetch, setTimeout, clearTimeout, console }; runInNewContext(readFileSync(process.argv[1], "utf8"), context); require("node:assert/strict").equal(context.curveProvider.name(), "curve");`;
    await run(["node", "-e", script, output.path], packed);
  }, 15_000);
});
