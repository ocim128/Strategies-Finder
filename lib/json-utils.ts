export function safeJsonParse<T>(raw: string, fallback: T): T {
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

type NonFiniteNumberMarker = {
    __type: "non-finite-number";
    value: "NaN" | "Infinity" | "-Infinity";
};

function jsonNonFiniteReplacer(_key: string, value: unknown): unknown {
    if (typeof value !== "number" || Number.isFinite(value)) return value;
    const marker: NonFiniteNumberMarker = {
        __type: "non-finite-number",
        value: Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity",
    };
    return marker;
}

function jsonNonFiniteReviver(_key: string, value: unknown): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const marker = value as Partial<NonFiniteNumberMarker>;
    if (marker.__type !== "non-finite-number") return value;
    if (marker.value === "NaN") return Number.NaN;
    if (marker.value === "Infinity") return Number.POSITIVE_INFINITY;
    if (marker.value === "-Infinity") return Number.NEGATIVE_INFINITY;
    return value;
}

export function serializeJsonPreservingNonFinite(value: unknown): string {
    return JSON.stringify(value, jsonNonFiniteReplacer) ?? "null";
}

/**
 * Default number of UTF-16 code units accumulated before a chunk is yielded.
 * Well below V8's maximum string length (~536,870,888 characters), which is a
 * hard limit on ONE string: a single `JSON.stringify` of a large result
 * inventory throws `RangeError: Invalid string length` long before memory runs
 * out. Never raise this near the limit.
 */
export const JSON_SERIALIZE_CHUNK_CHARS = 4 * 1024 * 1024;

const NON_FINITE_MARKER: Record<"NaN" | "Infinity" | "-Infinity", { __type: "non-finite-number"; value: "NaN" | "Infinity" | "-Infinity" }> = {
    NaN: { __type: "non-finite-number", value: "NaN" },
    Infinity: { __type: "non-finite-number", value: "Infinity" },
    "-Infinity": { __type: "non-finite-number", value: "-Infinity" },
};

/**
 * Streaming equivalent of {@link serializeJsonPreservingNonFinite}: yields the
 * same JSON text in bounded pieces instead of building one string, so a caller
 * can write payloads that exceed V8's single-string limit.
 *
 * Output is byte-for-byte identical to the string form for every value shape
 * this repository serializes (plain JSON data plus non-finite numbers), and it
 * follows `JSON.stringify` semantics for the cases it can hit: `toJSON`, key
 * order, skipping `undefined`/function/symbol object members, `null` for those
 * in arrays, `-0`, and the BigInt / circular-structure `TypeError`s.
 *
 * Chunks are only split between values, never inside a token, so every chunk
 * is independently valid JSON text once concatenated in yield order. A single
 * string field larger than `maxChunkChars` is emitted as one oversized chunk;
 * splitting inside a JSON string token is not possible.
 */
export function* serializeJsonPreservingNonFiniteChunks(
    value: unknown,
    maxChunkChars: number = JSON_SERIALIZE_CHUNK_CHARS,
): Generator<string, void, undefined> {
    const limit = Number.isFinite(maxChunkChars) && maxChunkChars > 0
        ? Math.max(1024, Math.floor(maxChunkChars))
        : JSON_SERIALIZE_CHUNK_CHARS;
    let parts: string[] = [];
    let buffered = 0;
    const ancestors: object[] = [];

    function* flush(): Generator<string, void, undefined> {
        if (parts.length === 0) return;
        const chunk = parts.join("");
        parts = [];
        buffered = 0;
        if (chunk.length > 0) yield chunk;
    }

    const append = (piece: string): void => {
        parts.push(piece);
        buffered += piece.length;
    };

    // The replacer's effect, resolved BEFORE deciding whether a member is
    // emitted: `JSON.stringify` drops members whose post-replacer value is
    // undefined/function/symbol, and that decision needs the final value.
    // A non-finite number becomes the same marker OBJECT the string form's
    // replacer returns, so it serializes through the normal object path.
    const prepare = (raw: unknown, key: string): unknown => {
        let current = raw;
        if (current !== null && typeof current === "object" && typeof (current as { toJSON?: unknown }).toJSON === "function") {
            current = (current as { toJSON: (key: string) => unknown }).toJSON(key);
        }
        if (typeof current === "number" && !Number.isFinite(current)) {
            return NON_FINITE_MARKER[Number.isNaN(current) ? "NaN" : current > 0 ? "Infinity" : "-Infinity"];
        }
        return current;
    };

    function* visitPrepared(current: unknown): Generator<string, void, undefined> {
        if (current !== null && typeof current === "object") {
            const container = current as Record<string, unknown>;
            if (ancestors.includes(container)) {
                throw new TypeError("Converting circular structure to JSON");
            }
            ancestors.push(container);
            try {
                if (Array.isArray(container)) {
                    append("[");
                    for (let index = 0; index < container.length; index += 1) {
                        if (index > 0) append(",");
                        if (buffered >= limit) yield* flush();
                        const element = prepare(container[index], String(index));
                        if (element === undefined || typeof element === "function" || typeof element === "symbol") {
                            append("null");
                        } else {
                            yield* visitPrepared(element);
                        }
                    }
                    append("]");
                } else {
                    append("{");
                    let emitted = 0;
                    for (const key of Object.keys(container)) {
                        if (buffered >= limit) yield* flush();
                        const member = prepare(container[key], key);
                        if (member === undefined || typeof member === "function" || typeof member === "symbol") continue;
                        if (emitted > 0) append(",");
                        emitted += 1;
                        append(JSON.stringify(key));
                        append(":");
                        yield* visitPrepared(member);
                    }
                    append("}");
                }
            } finally {
                ancestors.pop();
            }
        } else if (current === null) {
            append("null");
        } else if (typeof current === "string") {
            append(JSON.stringify(current));
        } else if (typeof current === "number") {
            append(Object.is(current, -0) ? "0" : String(current));
        } else if (typeof current === "boolean") {
            append(current ? "true" : "false");
        } else if (typeof current === "bigint") {
            throw new TypeError("Do not know how to serialize a BigInt");
        } else {
            // Root/array-level undefined, function, or symbol.
            append("null");
        }
        if (buffered >= limit) yield* flush();
    }

    const root = prepare(value, "");
    yield* visitPrepared(root);
    yield* flush();
}

export function parseJsonPreservingNonFinite(raw: string): unknown {
    return JSON.parse(raw, jsonNonFiniteReviver);
}

export function stableNormalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(stableNormalize);
    }
    if (value && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, stableNormalize(item)]);
        return Object.fromEntries(entries);
    }
    return value;
}

export function stableStringify(value: unknown): string {
    return JSON.stringify(stableNormalize(value)) ?? "undefined";
}

export function cloneJsonCompatible<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}
