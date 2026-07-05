interface AvailabilityRecord {
    available: boolean | null;
    checkedAt: number;
    promise: Promise<boolean> | null;
}

interface CheckAvailabilityOptions {
    key: string;
    statusUrl: string;
    force?: boolean;
    cacheMs: number;
    timeoutMs: number;
}

const availabilityByKey = new Map<string, AvailabilityRecord>();
let runtimeLocalApiOrigin: string | null = null;

function getRecord(key: string): AvailabilityRecord {
    let record = availabilityByKey.get(key);
    if (!record) {
        record = { available: null, checkedAt: 0, promise: null };
        availabilityByKey.set(key, record);
    }
    return record;
}

function createTimeoutSignal(sourceSignal: AbortSignal | undefined, timeoutMs: number): {
    signal: AbortSignal | undefined;
    cleanup: () => void;
} {
    if (typeof AbortController === "undefined" || typeof setTimeout === "undefined") {
        return { signal: sourceSignal, cleanup: () => undefined };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const abortFromSource = () => controller.abort();
    if (sourceSignal) {
        if (sourceSignal.aborted) {
            abortFromSource();
        } else {
            sourceSignal.addEventListener("abort", abortFromSource, { once: true });
        }
    }

    return {
        signal: controller.signal,
        cleanup: () => {
            clearTimeout(timer);
            sourceSignal?.removeEventListener("abort", abortFromSource);
        },
    };
}

export function isAbortLikeError(error: unknown): boolean {
    return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export async function fetchLocalApi(input: string, init: RequestInit = {}, timeoutMs: number): Promise<Response> {
    const timeout = createTimeoutSignal(init.signal ?? undefined, timeoutMs);
    try {
        return await fetch(resolveLocalApiUrl(input), { ...init, signal: timeout.signal });
    } finally {
        timeout.cleanup();
    }
}

export function setRuntimeLocalApiOrigin(origin: string | null): void {
    if (!origin) {
        runtimeLocalApiOrigin = null;
        return;
    }

    try {
        const parsed = new URL(origin);
        runtimeLocalApiOrigin = parsed.origin;
    } catch {
        runtimeLocalApiOrigin = null;
    }
}

/**
 * Resolve a relative `/api/...` URL against the local dev-server origin.
 *
 * Browser `fetch` resolves relative URLs against `window.location` automatically.
 * Node's `fetch` does not — passing `"/api/sqlite/load-ohlcv"` to Node's global
 * `fetch` throws `TypeError: Invalid URL` because there is no implicit base.
 * Server-side surfaces (Batch Backtest plugin, server data loader) call into
 * the same SQLite/second-market helpers the browser does, so they need the
 * same origin resolution.
 *
 * The origin defaults to `http://127.0.0.1:5173` (Vite's default port). The
 * Batch Backtest Vite plugin sets a runtime origin from the incoming request
 * Host header so Node-side loads follow the actual dev-server port; an
 * explicit `VITE_DEV_SERVER_ORIGIN` env var still wins for manual overrides.
 * Absolute URLs pass through unchanged.
 */
export function resolveLocalApiUrl(input: string): string {
    if (typeof window !== "undefined") return input;
    if (!input.startsWith("/")) return input;
    const origin = (typeof process !== "undefined" && process.env && process.env.VITE_DEV_SERVER_ORIGIN)
        || runtimeLocalApiOrigin
        || "http://127.0.0.1:5173";
    return `${origin}${input}`;
}

export async function checkLocalApiAvailable(options: CheckAvailabilityOptions): Promise<boolean> {
    const record = getRecord(options.key);
    const now = Date.now();
    const cacheIsFresh = record.available !== null && now - record.checkedAt < options.cacheMs;
    if (cacheIsFresh && (!options.force || record.available === true)) {
        return record.available === true;
    }

    if (record.promise) {
        return await record.promise;
    }

    const availabilityCheck = (async () => {
        try {
            const response = await fetchLocalApi(options.statusUrl, { method: "GET" }, options.timeoutMs);
            record.available = response.ok;
        } catch {
            record.available = false;
        }
        record.checkedAt = Date.now();
        return record.available === true;
    })();

    record.promise = availabilityCheck;
    try {
        return await availabilityCheck;
    } finally {
        if (record.promise === availabilityCheck) {
            record.promise = null;
        }
    }
}

export function markLocalApiUnavailable(key: string): void {
    const record = getRecord(key);
    record.available = false;
    record.checkedAt = Date.now();
}

export function resetLocalApiAvailability(key?: string): void {
    if (key) {
        availabilityByKey.delete(key);
        return;
    }
    availabilityByKey.clear();
}
