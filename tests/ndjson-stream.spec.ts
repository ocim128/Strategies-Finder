import { expect } from "chai";
import { describe, it } from "node:test";
import { consumeNdjsonStream, StreamEndedBeforeTerminalError } from "../lib/ndjson-stream";

describe("consumeNdjsonStream", () => {
    it("stops after a done event so trailing stream errors do not fail completed work", async () => {
        const events: string[] = [];
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('{"type":"progress","text":"running"}\n'));
                controller.enqueue(encoder.encode('{"type":"done","summary":"Done"}\n'));
            },
            pull(controller) {
                controller.error(new Error("network error"));
            },
        });

        await consumeNdjsonStream<{ type: string; text?: string; summary?: string }>(stream, {
            onProgress: (event) => events.push(event.text ?? ""),
            onDone: (event) => events.push(event.summary ?? ""),
        });

        expect(events).to.deep.equal(["running", "Done"]);
    });

    it("resolves at EOF without a done event when requireTerminal is not set (legacy callers)", async () => {
        // Crypto / IBKR / Stability rely on this: they track terminal state
        // themselves and must keep seeing a normal resolve on a clean EOF.
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('{"type":"progress","text":"running"}\n'));
                controller.close();
            },
        });

        let progressed = false;
        await consumeNdjsonStream<{ type: string; text?: string }>(stream, {
            onProgress: () => { progressed = true; },
        });
        expect(progressed).to.equal(true);
    });

    it("throws StreamEndedBeforeTerminalError on EOF without done when requireTerminal is true", async () => {
        // Audit finding 1/2 root cause: a truncated stream must not look like
        // a successful completed run. The terminal event is the protocol
        // invariant; without it the caller must enter its recovery/error path.
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('{"type":"progress","text":"running"}\n'));
                controller.close();
            },
        });

        let caught: unknown = null;
        try {
            await consumeNdjsonStream<{ type: string; text?: string }>(
                stream,
                { onProgress: () => {} },
                { requireTerminal: true },
            );
        } catch (error) {
            caught = error;
        }
        expect(caught).to.be.instanceOf(StreamEndedBeforeTerminalError);
    });

    it("does not throw the EOF error when a done event was processed (requireTerminal true)", async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('{"type":"done","summary":"ok"}\n'));
                controller.close();
            },
        });

        await consumeNdjsonStream<{ type: string; summary?: string }>(
            stream,
            { onDone: () => {} },
            { requireTerminal: true },
        );
        // No throw => pass.
    });

    it("does not throw the EOF error when a fatal event was processed (requireTerminal true)", async () => {
        // fatal is also a terminal event: it throws via the caller's onFatal
        // handler (or simply resolves here if onFatal doesn't throw), but it
        // must NOT additionally throw the EOF error.
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('{"type":"fatal","error":"boom"}\n'));
                controller.close();
            },
        });

        await consumeNdjsonStream<{ type: string; error?: string }>(
            stream,
            { onFatal: () => {} },
            { requireTerminal: true },
        );
        // No throw => pass.
    });
});
