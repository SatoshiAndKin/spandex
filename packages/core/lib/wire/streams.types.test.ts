import { expect, expectTypeOf, it } from "bun:test";
import type * as PublicCore from "@spandex/core";
import type { SimulatedQuote } from "../types.js";
import { decodeStream, newStream } from "./streams.js";

it("preserves Promise.all array types through source and public stream imports", async () => {
  expectTypeOf<ReturnType<typeof decodeStream<SimulatedQuote>>>().toEqualTypeOf<
    Promise<Promise<SimulatedQuote>[]>
  >();
  expectTypeOf<ReturnType<typeof PublicCore.decodeStream<SimulatedQuote>>>().toEqualTypeOf<
    Promise<Promise<SimulatedQuote>[]>
  >();

  const pending = await decodeStream<number>(newStream([Promise.resolve(42)], () => 0));
  const values = await Promise.all(pending);
  expectTypeOf(values).toEqualTypeOf<number[]>();
  expectTypeOf(values.length).toEqualTypeOf<number>();
  expectTypeOf(values.find((value): boolean => value === 42)).toEqualTypeOf<number | undefined>();
  expectTypeOf(values.every((value) => value === 42)).toEqualTypeOf<boolean>();
  expect(values).toEqual([42]);
});
