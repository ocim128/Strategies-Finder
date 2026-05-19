export function safeJsonParse<T>(raw: string, fallback: T): T {
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
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
