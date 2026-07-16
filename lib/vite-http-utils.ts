import type { IncomingMessage } from "node:http";
import { createFetchTimeoutSignal, isAbortError } from "./dataProviders/fetch-helpers";

export const DEFAULT_MAX_BODY_BYTES = 80 * 1024 * 1024;

/**
 * Minimal logger surface for Vite plugin helpers. Injected by callers (Vite
 * plugins pass `debugLogger`) so this Node-only utility does not have to import
 * the browser-coupled `debug-logger` module — that import was pulling
 * browser/Vite-runtime assumptions into the server config bundle and tripping
 * Vite's CJS/import-meta warnings during `vite build`.
 */
export interface ViteHttpLogger {
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
}

const noopLogger: ViteHttpLogger = {
    info: () => undefined,
    warn: () => undefined,
};

export interface ViteHttpResponse {
    statusCode: number;
    setHeader(name: string, value: string): void;
    // Optional because every established helper (`sendJson`, `sendBinary`)
    // ends the response in one shot. Streaming responses (NDJSON progress)
    // use `write` repeatedly before a final `end`. Runtime `res` from Vite is
    // a Node `ServerResponse` that already implements `write`.
    write?(body: string | Buffer): boolean;
    end(body: string | Buffer): void;
}

export class HttpStatusError extends Error {
    constructor(
        public readonly status: number,
        message: string
    ) {
        super(message);
        this.name = "HttpStatusError";
    }
}

export function sendJson(res: ViteHttpResponse, status: number, payload: unknown): void {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(payload));
}

export function sendBinary(res: ViteHttpResponse, status: number, payload: Buffer): void {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.end(payload);
}

/**
 * Begins an NDJSON (newline-delimited JSON) chunked response. Each `write`
 * serializes one event as a JSON line; `end` closes the stream. Used by
 * long-running Vite middleware (e.g. IBKR sync) to report per-symbol
 * progress incrementally instead of buffering the whole batch.
 *
 * Returns `write` / `end` bound to `res` so callers don't have to thread
 * `res` through async loops. `end` accepts an optional final event for
 * convenience, then ends the response.
 */
export function beginNdjsonStream(res: ViteHttpResponse): {
    write: (event: unknown) => void;
    end: (event?: unknown) => void;
} {
    if (typeof res.write !== "function") {
        throw new Error("NDJSON streaming requires a writable response stream.");
    }
    // Attach an error handler so a mid-stream socket error (client disconnect,
    // TCP reset) doesn't surface as an unhandled EventEmitter 'error' that
    // tears down the dev server. `ViteHttpResponse` doesn't formally expose
    // `on`, but the runtime object is a Node ServerResponse that does.
    const anyRes = res as ViteHttpResponse & { on?: (event: string, listener: () => void) => void };
    if (typeof anyRes.on === "function") {
        anyRes.on("error", () => { /* socket died; best-effort */ });
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return {
        write: (event: unknown) => {
            res.write!(`${JSON.stringify(event)}\n`);
        },
        end: (event?: unknown) => {
            if (event !== undefined) {
                res.write!(`${JSON.stringify(event)}\n`);
            }
            res.end("");
        },
    };
}

/**
 * Disconnect-safe NDJSON stream wrapper (audit Finding 4).
 *
 * Wraps {@link beginNdjsonStream} and tracks the response lifecycle: once the
 * client disconnects (`close` / `error`), every subsequent `write` is silently
 * dropped instead of throwing into a long-running async loop. The production
 * Finder plugin already used this pattern inline; this extracts it so the
 * Batch run/mine/stability/portfolio-fit handlers can share the exact same
 * transport-safety contract.
 *
 * Why this matters: without it, a browser reload mid-run makes `stream.write`
 * throw on a dead socket, which the Batch run loop treated as fatal — calling
 * `releaseLastResults` and undermining the documented status-reattach path.
 * The caller decides whether disconnect means "keep running for /status
 * reattach" or "cancel because the streamed result cannot be recovered" via
 * `onDisconnect`; either policy is isolated from socket write failures.
 *
 * `end` is a no-op once disconnected (the socket is already gone). Returns the
 * raw `write`/`end` plus an `isWritable` predicate for callers that gate
 * terminal writes (e.g. the Finder `safeWrite` pattern).
 */
export function createDisconnectSafeStream(
    res: ViteHttpResponse,
    options: { onDisconnect?: () => void } = {},
): {
    write: (event: unknown) => void;
    end: (event?: unknown) => void;
    isWritable: () => boolean;
} {
    const stream = beginNdjsonStream(res);
    let writable = true;
    let disconnectNotified = false;
    const markDisconnected = (): void => {
        writable = false;
        if (disconnectNotified) return;
        disconnectNotified = true;
        try {
            options.onDisconnect?.();
        } catch {
            // Transport cleanup must never throw into the response emitter.
        }
    };
    const responseWithEvents = res as ViteHttpResponse & {
        on?: (event: string, listener: () => void) => void;
    };
    if (typeof responseWithEvents.on === "function") {
        responseWithEvents.on("close", markDisconnected);
        // `beginNdjsonStream` already attaches its own `error` no-op; attaching
        // a second `error` listener for the disconnect flag is safe (Node
        // EventEmitter permits multiple listeners) and necessary so an emitted
        // 'error' flips `writable` before the next write attempt.
        responseWithEvents.on("error", markDisconnected);
    }
    return {
        write: (event: unknown) => {
            if (!writable) return;
            try {
                stream.write(event);
            } catch {
                // A socket that died between the close/error event and this
                // write would throw; flip the flag so subsequent writes no-op.
                markDisconnected();
            }
        },
        end: (event?: unknown) => {
            if (!writable) return;
            try {
                stream.end(event);
            } catch {
                markDisconnected();
            }
        },
        isWritable: () => writable,
    };
}

export async function readBodyBuffer(
    req: IncomingMessage,
    maxBytes = DEFAULT_MAX_BODY_BYTES
): Promise<Buffer> {
    const rawContentLength = req.headers["content-length"];
    const contentLength = Array.isArray(rawContentLength)
        ? Number(rawContentLength[0])
        : Number(rawContentLength);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new HttpStatusError(413, `Request body too large. Limit is ${maxBytes} bytes.`);
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of req) {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        total += bytes.length;
        if (total > maxBytes) {
            throw new HttpStatusError(413, `Request body too large. Limit is ${maxBytes} bytes.`);
        }
        chunks.push(bytes);
    }
    return Buffer.concat(chunks);
}

export async function readJsonBody(
    req: IncomingMessage,
    maxBytes?: number,
    options?: { requireJsonContentType?: boolean }
): Promise<Record<string, unknown>> {
    if (options?.requireJsonContentType) {
        const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
        if (!contentType.includes("application/json")) {
            throw new HttpStatusError(415, "Content-Type must be application/json.");
        }
    }
    const buffer = await readBodyBuffer(req, maxBytes);
    const text = buffer.toString("utf8").trim();
    if (!text) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new HttpStatusError(400, "Invalid JSON body.");
    }
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
}

export function sendCaughtErrorJson(res: ViteHttpResponse, error: unknown): void {
    if (error instanceof HttpStatusError) {
        sendJson(res, error.status, { ok: false, error: error.message });
        return;
    }

    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, { ok: false, error: message });
}

export type ProxyUpstreamJsonHandlers = {
    onTimeout: () => void;
    onError: (error: unknown) => void;
};

/**
 * Proxies a GET request to an upstream URL, mirroring its status, content-type,
 * and body back to the client. Used by the tradfi/polymarket Vite proxy plugins
 * to avoid duplicating the fetch + timeout + mirror-success pattern.
 *
 * On a timeout (AbortError) or failure, the caller-supplied `onTimeout`/`onError`
 * handlers are invoked so the plugin can render its own error payload shape
 * (different surfaces use `{ ret_code, ret_msg }` vs `{ ok, error }`).
 *
 * Emits structured `proxy.upstream` / `proxy.upstream.failed` logs for
 * observability — previously these proxy calls had no logging at all, which
 * made "stale chart" symptoms hard to diagnose.
 */
export async function proxyUpstreamJson(
    res: ViteHttpResponse,
    url: string,
    timeoutMs: number,
    label: string,
    handlers: ProxyUpstreamJsonHandlers,
    logger: ViteHttpLogger = noopLogger
): Promise<void> {
    const startedAt = Date.now();
    const timeout = createFetchTimeoutSignal(undefined, timeoutMs);
    try {
        const upstream = await fetch(url, {
            headers: { Accept: "application/json" },
            signal: timeout.signal,
        });
        const body = await upstream.text();
        res.statusCode = upstream.status;
        res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(body);
        logger.info("proxy.upstream", {
            target: label,
            url,
            status: upstream.status,
            durationMs: Date.now() - startedAt,
            bytes: body.length,
        });
    } catch (error) {
        const timedOut = isAbortError(error);
        logger.warn("proxy.upstream.failed", {
            target: label,
            url,
            timedOut,
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
        });
        if (timedOut) {
            handlers.onTimeout();
        } else {
            handlers.onError(error);
        }
    } finally {
        timeout.cleanup();
    }
}

