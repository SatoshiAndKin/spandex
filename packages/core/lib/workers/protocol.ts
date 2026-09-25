/** One structured-clone protocol for all SDK workers. */
export type WorkerRequest<T> = { id: number; payload: T };
export type WorkerReply<T> =
  | { id: number; success: true; result: T }
  | { id: number; success: false; error: EncodedValue; fatal?: true };

type EncodedValue =
  | { kind: "value"; value: unknown }
  | { kind: "array"; items: EncodedValue[] }
  | { kind: "object" | "error"; fields: Record<string, EncodedValue> };

/** Encode every container, so user detail objects cannot collide with error tags. */
export function serializeError(
  value: unknown,
  seen = new Map<object, EncodedValue>(),
): EncodedValue {
  if (typeof value === "function" || typeof value === "symbol") {
    return { kind: "value", value: String(value) };
  }
  if (value === null || typeof value !== "object") return { kind: "value", value };
  const previous = seen.get(value);
  if (previous) return previous;
  if (Array.isArray(value)) {
    const result: EncodedValue = { kind: "array", items: [] };
    seen.set(value, result);
    result.items = value.map((item) => serializeError(item, seen));
    return result;
  }
  if (
    !(value instanceof Error) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    // Preserve cloneable diagnostic values such as dates and typed arrays.
    try {
      return { kind: "value", value: structuredClone(value) };
    } catch {
      /* Fall back to fields. */
    }
  }
  const result: EncodedValue = { kind: value instanceof Error ? "error" : "object", fields: {} };
  seen.set(value, result);
  const keys = new Set(Object.getOwnPropertyNames(value));
  if (value instanceof Error) {
    for (const key of ["name", "message", "stack", "code", "cause", "details"]) keys.add(key);
  }
  for (const key of keys) {
    let field: unknown;
    try {
      field = Reflect.get(value, key);
    } catch {
      field = "[Unavailable property]";
    }
    Object.defineProperty(result.fields, key, {
      value: serializeError(field, seen),
      enumerable: true,
    });
  }
  return result;
}

export function deserializeError(
  value: EncodedValue,
  seen = new Map<EncodedValue, unknown>(),
): unknown {
  if (value.kind === "value") return value.value;
  if (seen.has(value)) return seen.get(value);
  if (value.kind === "array") {
    const result: unknown[] = [];
    seen.set(value, result);
    for (const item of value.items) result.push(deserializeError(item, seen));
    return result;
  }
  const result = value.kind === "error" ? new Error() : {};
  seen.set(value, result);
  for (const [key, field] of Object.entries(value.fields)) {
    Object.defineProperty(result, key, {
      value: deserializeError(field, seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}
