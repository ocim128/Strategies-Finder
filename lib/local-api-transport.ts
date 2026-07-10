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
 * Derive the local API origin from the server's bound socket, not the (spoofable)
 * Host header. Internal server-side `/api/sqlite/*` fetches must always target
 * the current Vite server; deriving from `Host`/`X-Forwarded-Proto` lets a
 * crafted request (when Vite runs with `--host`) redirect those fetches to an
 * attacker-controlled origin — an SSRF-like primitive (Finding 6).
 *
 * Strategy:
 *  1. Prefer `socket.localAddress` + `socket.localPort` — the actual address
 *     the server is listening on. This is server-controlled, not request-controlled.
 *  2. Fall back to the Host header ONLY when it is a loopback host (localhost /
 *     127.x / ::1 / 0.0.0.0), preserving random-port Vite support where the
 *     socket local address may be `::` (unspecified).
 *  3. An explicit `VITE_DEV_SERVER_ORIGIN` env var always wins (manual override).
 *
 * `X-Forwarded-Proto` is never trusted here — a forwarded proto header without
 * a configured proxy is the exact hazard this fix removes, so the origin is
 * always `http` (the loopback dev server does not serve TLS).
 */
export function rememberLoopbackOriginFromRequest(req: {
    headers?: Record<string, unknown>;
    socket?: { localAddress?: string; localPort?: number } | null;
}): void {
    // Explicit env override always wins and is never mutated by a request.
    if (typeof process !== "undefined" && process.env && process.env.VITE_DEV_SERVER_ORIGIN) {
        setRuntimeLocalApiOrigin(process.env.VITE_DEV_SERVER_ORIGIN);
        return;
    }

    const socket = req.socket;
    if (socket && typeof socket.localPort === "number" && socket.localPort > 0) {
        const addr = normalizeLoopbackAddress(socket.localAddress);
        setRuntimeLocalApiOrigin(`http://${addr}:${socket.localPort}`);
        return;
    }

    // Socket info unavailable (older runtime / test stub): fall back to the
    // Host header ONLY for loopback hosts. This keeps `vite --host` on a
    // loopback working without trusting an arbitrary external Host.
    const hostHeader = req.headers?.host;
    const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
    if (typeof host === "string" && isLoopbackHost(host)) {
        setRuntimeLocalApiOrigin(`http://${host.trim()}`);
    }
}

/** Map an unspecified/wildcard bind address to the loopback literal. */
function normalizeLoopbackAddress(address: string | undefined): string {
    if (!address) return "127.0.0.1";
    // `::` (IPv6 wildcard) and `0.0.0.0` (IPv4 wildcard) mean "all interfaces";
    // internal fetches must target loopback, not a wildcard.
    if (address === "::" || address === "::0" || address === "0.0.0.0") return "127.0.0.1";
    // IPv6 loopback variants — bracket for URL safety.
    if (address === "::1") return "[::1]";
    if (address.includes(":")) return `[${address}]`;
    return address;
}

/** True if `host` (with optional port) names a loopback destination. */
function isLoopbackHost(host: string): boolean {
    const bare = host.split(":")[0]!.trim().toLowerCase();
    return bare === "localhost"
        || bare === "127.0.0.1"
        || bare === "::1"
        || bare.startsWith("127.");
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
 * Finder and Batch Vite plugins set a runtime origin from the server's bound
 * socket via {@link rememberLoopbackOriginFromRequest} (NOT the spoofable Host
 * header — see Finding 6); an explicit `VITE_DEV_SERVER_ORIGIN` env var still
 * wins for manual overrides. Absolute URLs pass through unchanged.
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
