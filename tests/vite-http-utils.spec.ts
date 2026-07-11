import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { afterEach, describe, it } from "node:test";
import {
    DEFAULT_MAX_BODY_BYTES,
    HttpStatusError,
    proxyUpstreamJson,
    readBodyBuffer,
    readJsonBody,
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
