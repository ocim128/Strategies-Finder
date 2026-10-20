import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { afterEach, describe, it } from "node:test";
import {
    API_SLOW_REQUEST_WARN_MS,
    createDisconnectSafeStream,
    DEFAULT_MAX_BODY_BYTES,
    HttpStatusError,
    proxyUpstreamJson,
    readBodyBuffer,
    readJsonBody,
    registerLocalJsonRoute,
    sendJson,
    serializeJsonForTransport,
    type LocalRouteMiddlewareStack,
    type ViteHttpLogger,
    type ViteHttpResponse,
} from "../lib/vite-http-utils";
import type { IncomingMessage } from "node:http";

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

function makeRequest(chunks: readonly Buffer[], headers: Record<string, string> = {}): IncomingMessage {
    const request = Readable.from(chunks) as IncomingMessage;
    (request as IncomingMessage & { headers: Record<string, string> }).headers = headers;
    return request;
}

describe("Vite HTTP utilities", () => {
    it("preserves non-finite numeric results with explicit transport markers", () => {
        const serialized = serializeJsonForTransport({
            nan: Number.NaN,
            positive: Number.POSITIVE_INFINITY,
            negative: Number.NEGATIVE_INFINITY,
        });

        assert.deepEqual(JSON.parse(serialized), {
            nan: { __type: "non-finite-number", value: "NaN" },
            positive: { __type: "non-finite-number", value: "Infinity" },
            negative: { __type: "non-finite-number", value: "-Infinity" },
        });
    });

    it("uses the same non-finite representation for JSON responses", () => {
        let body = "";
        const res: ViteHttpResponse = {
            statusCode: 0,
            setHeader: () => undefined,
            end: (value) => { body = String(value); },
        };

        sendJson(res, 200, { profitFactor: Number.POSITIVE_INFINITY });

        assert.deepEqual(JSON.parse(body), {
            profitFactor: { __type: "non-finite-number", value: "Infinity" },
        });
    });

    it("rejects oversized bodies from content-length before reading", async () => {
        const request = makeRequest([], {
            "content-length": String(DEFAULT_MAX_BODY_BYTES + 1),
        });

        await assert.rejects(
            () => readBodyBuffer(request),
            (error) => error instanceof HttpStatusError && error.status === 413
        );
    });

    it("rejects streaming bodies that exceed the configured limit", async () => {
        const request = makeRequest([
            Buffer.from("1234"),
            Buffer.from("5678"),
        ]);

        await assert.rejects(
            () => readBodyBuffer(request, 4),
            (error) => error instanceof HttpStatusError && error.status === 413
        );
    });

    it("rejects malformed JSON as a client error", async () => {
        const request = makeRequest([Buffer.from("{not-json")]);

        await assert.rejects(
            () => readJsonBody(request),
            (error) => (
                error instanceof HttpStatusError
                && error.status === 400
                && error.message === "Invalid JSON body."
            )
        );
    });

    it("rejects non-JSON Content-Type with 415 when requireJsonContentType is set", async () => {
        // A CSRF text/plain body is CORS-simple (no preflight); the 415 gate
        // keeps it off destructive admin routes. See audit finding 3.
        const request = makeRequest(
            [Buffer.from(JSON.stringify({ key: "alpha_strategy" }))],
            { "content-type": "text/plain" }
        );

        await assert.rejects(
            () => readJsonBody(request, 1024 * 1024, { requireJsonContentType: true }),
            (error) => (
                error instanceof HttpStatusError
                && error.status === 415
                && /Content-Type must be application\/json/.test(error.message)
            )
        );
    });

    it("accepts application/json Content-Type when requireJsonContentType is set", async () => {
        const request = makeRequest(
            [Buffer.from(JSON.stringify({ ok: true }))],
            { "content-type": "application/json" }
        );

        const body = await readJsonBody(request, 1024 * 1024, { requireJsonContentType: true });
        assert.deepEqual(body, { ok: true });
    });

    it("does not enforce Content-Type by default (backward compatible)", async () => {
        const request = makeRequest(
            [Buffer.from(JSON.stringify({ ok: true }))],
            { "content-type": "text/plain" }
        );

        const body = await readJsonBody(request);
        assert.deepEqual(body, { ok: true });
    });
});

describe("proxyUpstreamJson", () => {
    function makeResponse(): { res: ViteHttpResponse; capture: { status: number; headers: Record<string, string>; body: string } } {
        const capture: { status: number; headers: Record<string, string>; body: string } = { status: 0, headers: {}, body: "" };
        const res: ViteHttpResponse = {
            statusCode: 0,
            setHeader(name: string, value: string) {
                capture.headers[name] = value;
            },
            end(body: string | Buffer) {
                capture.body = typeof body === "string" ? body : body.toString("utf8");
            },
        };
        Object.defineProperty(res, "statusCode", {
            get: () => capture.status,
            set: (value: number) => { capture.status = value; },
            configurable: true,
        });
        return { res, capture };
    }

    it("mirrors upstream status, content-type, and body on success", async () => {
        globalThis.fetch = async () => new Response('{"ok":true}', {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
        });

        const { res, capture } = makeResponse();
        let timedOut = false;
        let errored = false;
        await proxyUpstreamJson(res, "https://example/up", 1000, "test", {
            onTimeout: () => { timedOut = true; },
            onError: () => { errored = true; },
        });

        assert.equal(capture.status, 200);
        assert.equal(capture.headers["Content-Type"], "application/json; charset=utf-8");
        assert.equal(capture.headers["Cache-Control"], "no-store");
        assert.equal(capture.body, '{"ok":true}');
        assert.equal(timedOut, false);
        assert.equal(errored, false);
    });

    it("dispatches onTimeout when the upstream fetch aborts", async () => {
        globalThis.fetch = async () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            throw error;
        };

        const { res, capture } = makeResponse();
        let timedOut = false;
        let errored = false;
        await proxyUpstreamJson(res, "https://example/up", 1000, "test", {
            onTimeout: () => { timedOut = true; },
            onError: () => { errored = true; },
        });

        assert.equal(timedOut, true);
        assert.equal(errored, false);
        assert.equal(capture.status, 0);
        assert.equal(capture.body, "");
    });

    it("dispatches onError for non-abort failures", async () => {
        globalThis.fetch = async () => {
            throw new TypeError("fetch failed");
        };

        const { res, capture } = makeResponse();
        let timedOut = false;
        let errored = false;
        await proxyUpstreamJson(res, "https://example/up", 1000, "test", {
            onTimeout: () => { timedOut = true; },
            onError: () => { errored = true; },
        });

        assert.equal(timedOut, false);
        assert.equal(errored, true);
        assert.equal(capture.status, 0);
        assert.equal(capture.body, "");
    });
});

describe("registerLocalJsonRoute telemetry", () => {
    type Captured = { level: "info" | "warn"; message: string; data: Record<string, unknown> };

    function setup(options: {
        method?: string;
        remoteAddress?: string;
        handler?: (ctx: { res: ViteHttpResponse }) => Promise<void> | void;
        extraEnv?: Record<string, string | undefined>;
    } = {}) {
        const captured: Captured[] = [];
        const logger: ViteHttpLogger = {
            info: (message, data) => captured.push({ level: "info", message, data: (data ?? {}) as Record<string, unknown> }),
            warn: (message, data) => captured.push({ level: "warn", message, data: (data ?? {}) as Record<string, unknown> }),
        };
        let registered: ((req: IncomingMessage, res: ViteHttpResponse) => void | Promise<void>) | null = null;
        const middlewares: LocalRouteMiddlewareStack = {
            use(_path, handler) { registered = handler; },
        };

        const restore: Array<() => void> = [];
        for (const [key, value] of Object.entries(options.extraEnv ?? {})) {
            const previous = process.env[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
            restore.push(() => {
                if (previous === undefined) delete process.env[key];
                else process.env[key] = previous;
            });
        }

        registerLocalJsonRoute(middlewares, "/api/test-telemetry", {
            methods: ["GET", "POST"],
            logger,
            onAuthorized: options.handler ?? (async ({ res }) => { sendJson(res, 200, { ok: true }); }),
        });
        assert.ok(registered, "route must register");

        const response = {
            statusCode: 200,
            setHeader: () => undefined,
            end: () => undefined,
        };
        const request = {
            method: options.method ?? "POST",
            url: "/api/test-telemetry",
            headers: { host: "127.0.0.1:5173" },
            socket: { remoteAddress: options.remoteAddress ?? "127.0.0.1" },
        } as unknown as IncomingMessage;

        return {
            captured,
            response,
            restore: () => { for (const undo of restore) undo(); },
            invoke: async () => {
                await registered!(request, response);
                return response;
            },        };
    }

    it("emits one structured line per mutating request", async () => {
        const ctx = setup();
        try {
            await ctx.invoke();
            assert.equal(ctx.captured.length, 1);
            const [entry] = ctx.captured;
            assert.equal(entry!.level, "info");
            assert.equal(entry!.message, "api.request");
            assert.equal(entry!.data.route, "/api/test-telemetry");
            assert.equal(entry!.data.method, "POST");
            assert.equal(entry!.data.status, 200);
            assert.equal(typeof entry!.data.durationMs, "number");
        } finally {
            ctx.restore();
        }
    });

    it("keeps silent for a fast GET poll unless verbose logging is enabled", async () => {
        const quiet = setup({ method: "GET" });
        try {
            await quiet.invoke();
            assert.equal(quiet.captured.length, 0, "a fast GET must not flood the terminal");
        } finally {
            quiet.restore();
        }

        const verbose = setup({ method: "GET", extraEnv: { API_REQUEST_LOG: "1" } });
        try {
            await verbose.invoke();
            assert.equal(verbose.captured.length, 1);
            assert.equal(verbose.captured[0]!.data.method, "GET");
        } finally {
            verbose.restore();
        }
    });

    it("reports a slow request as a warning", async () => {
        const ctx = setup({
            method: "GET",
            extraEnv: { API_SLOW_REQUEST_MS: "1" },
            handler: async ({ res }) => {
                await new Promise((resolve) => setTimeout(resolve, 5));
                sendJson(res, 200, { ok: true });
            },
        });
        try {
            await ctx.invoke();
            assert.equal(ctx.captured.length, 1);
            assert.equal(ctx.captured[0]!.level, "warn");
            assert.equal(ctx.captured[0]!.message, "api.request.slow");
            // `Date.now()` granularity means a 5 ms sleep can round to 4; the
            // invariant under test is "crossed the configured threshold".
            assert.ok(Number(ctx.captured[0]!.data.durationMs) >= 1);
        } finally {
            ctx.restore();
        }
    });

    it("can be switched off entirely", async () => {
        const ctx = setup({ extraEnv: { API_REQUEST_LOG: "0" } });
        try {
            await ctx.invoke();
            assert.equal(ctx.captured.length, 0);
        } finally {
            ctx.restore();
        }
    });

    it("still records the rejection status of an unauthorized request", async () => {
        const ctx = setup({ remoteAddress: "203.0.113.9" });
        try {
            const response = await ctx.invoke();
            assert.equal(response.statusCode, 401);
            assert.equal(ctx.captured.length, 1);
            assert.equal(ctx.captured[0]!.data.status, 401);
        } finally {
            ctx.restore();
        }
    });

    it("defaults the slow threshold to a documented value", () => {
        assert.equal(API_SLOW_REQUEST_WARN_MS, 2_000);
    });
});

describe("createDisconnectSafeStream (audit Finding 4)", () => {
    // Intent being locked: after the client disconnects (close/error on the
    // response), further write/end calls MUST silently no-op instead of
    // throwing into a long-running batch/finder loop. A reload mid-run must
    // not be treated as fatal — the server-owned job keeps running and a
    // reloaded tab reattaches via /status. The wrapper also flips `writable`
    // when an in-flight write throws, defending against a socket that died
    // between the close event and the next write attempt.

    type EventEmitter = { on?: (event: string, listener: () => void) => void };

    function makeStreamingResponse(): { res: ViteHttpResponse & EventEmitter; writes: string[]; ended: boolean; emit: (event: "close" | "error") => void } {
        const listeners: Record<string, Array<() => void>> = {};
        const writes: string[] = [];
        const state: { ended: boolean } = { ended: false };
        const res = {
            statusCode: 0,
            setHeader: () => {},
            write(chunk: string) { writes.push(chunk); },
            end() { state.ended = true; },
            on(event: string, listener: () => void) {
                (listeners[event] ??= []).push(listener);
            },
        } as unknown as ViteHttpResponse & EventEmitter;
        return {
            res,
            writes,
            get ended() { return state.ended; },
            emit(event: "close" | "error") {
                for (const l of listeners[event] ?? []) l();
            },
        };
    }

    it("passes writes through while the socket is alive", () => {
        const { res, writes, ended } = makeStreamingResponse();
        const stream = createDisconnectSafeStream(res);
        stream.write({ type: "progress", percent: 50 });
        stream.write({ type: "symbol", index: 0 });
        assert.equal(writes.length, 2);
        assert.equal(ended, false);
        assert.equal(stream.isWritable(), true);
    });

    it("drops writes after 'close' and does not end twice", () => {
        const { res, writes, ended, emit } = makeStreamingResponse();
        const stream = createDisconnectSafeStream(res);
        stream.write({ type: "progress", percent: 10 });
        emit("close");
        assert.equal(stream.isWritable(), false);
        // After disconnect, writes are silently dropped...
        stream.write({ type: "symbol", index: 1 });
        stream.write({ type: "symbol", index: 2 });
        assert.equal(writes.length, 1);
        // ...and end is a no-op (socket already gone).
        stream.end({ type: "done", ok: true });
        assert.equal(ended, false);
    });

    it("drops writes after 'error'", () => {
        const { res, writes, emit } = makeStreamingResponse();
        const stream = createDisconnectSafeStream(res);
        stream.write({ type: "progress", percent: 10 });
        emit("error");
        stream.write({ type: "symbol", index: 1 });
        assert.equal(writes.length, 1);
        assert.equal(stream.isWritable(), false);
    });

    it("flips writable false when an underlying write throws mid-stream", () => {
        const listeners: Record<string, Array<() => void>> = {};
        const state: { ended: boolean; failNext: boolean } = { ended: false, failNext: false };
        const res = {
            statusCode: 0,
            setHeader: () => {},
            write() {
                if (state.failNext) throw new Error("socket gone");
            },
            end() { state.ended = true; },
            on(event: string, listener: () => void) {
                (listeners[event] ??= []).push(listener);
            },
        } as unknown as ViteHttpResponse;
        const stream = createDisconnectSafeStream(res);
        stream.write({ type: "progress", percent: 10 });
        assert.equal(stream.isWritable(), true);
        // Simulate a socket that died between the close event and the next
        // write: the underlying write throws, the wrapper must catch + flip.
        state.failNext = true;
        stream.write({ type: "symbol", index: 1 });
        assert.equal(stream.isWritable(), false);
        // Subsequent writes no-op without throwing.
        stream.write({ type: "symbol", index: 2 });
    });

    it("notifies the owner exactly once when the stream disconnects", () => {
        const { res, emit } = makeStreamingResponse();
        let disconnects = 0;
        const stream = createDisconnectSafeStream(res, {
            onDisconnect: () => { disconnects += 1; },
        });

        emit("close");
        emit("error");
        stream.write({ type: "symbol", index: 1 });

        assert.equal(disconnects, 1);
        assert.equal(stream.isWritable(), false);
    });
});
