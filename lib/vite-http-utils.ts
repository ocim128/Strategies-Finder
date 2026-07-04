import type { IncomingMessage } from "node:http";
import { debugLogger } from "./debug-logger";
import { createFetchTimeoutSignal, isAbortError } from "./dataProviders/fetch-helpers";

export const DEFAULT_MAX_BODY_BYTES = 80 * 1024 * 1024;

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

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const buffer = await readBodyBuffer(req);
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
    handlers: ProxyUpstreamJsonHandlers
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
        debugLogger.info("proxy.upstream", {
            target: label,
            url,
            status: upstream.status,
            durationMs: Date.now() - startedAt,
            bytes: body.length,
        });
    } catch (error) {
        const timedOut = isAbortError(error);
        debugLogger.warn("proxy.upstream.failed", {
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

