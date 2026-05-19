import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import {
    DEFAULT_MAX_BODY_BYTES,
    HttpStatusError,
    readBodyBuffer,
    readJsonBody,
} from "../lib/vite-http-utils";
import type { IncomingMessage } from "node:http";

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
});
