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
