import { expect } from "chai";
import { describe, it } from "node:test";
import { consumeNdjsonStream, StreamEndedBeforeTerminalError, MalformedNdjsonLineError } from "../lib/ndjson-stream";

describe("consumeNdjsonStream", () => {
    const streamFromChunks = (...chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
        new ReadableStream<Uint8Array>({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(chunk);
                controller.close();
            },
        });

    for (const terminalType of ["done", "fatal", "asset_batch_done"]) {
        it(`dispatches an unterminated ${terminalType} event at EOF`, async () => {
            const events: string[] = [];
            const observed: string[] = [];
            const encoded = new TextEncoder().encode(`{"type":"progress"}\r\n\r\n{"type":"${terminalType}","text":"完成"}`);
            // Split within a multibyte character as a network stream can.
            const split = encoded.length - 4;
            await consumeNdjsonStream(
                streamFromChunks(encoded.slice(0, split), encoded.slice(split)),
                {
                    onProgress: () => events.push("progress"),
                    onDone: (event) => events.push(event.text),
                    onFatal: (event) => events.push(event.text),
                    onAssetBatchDone: (event) => events.push(event.text),
                },
                { requireTerminal: true, terminalTypes: [terminalType], onEvent: (event) => observed.push(event.type) },
            );
            expect(events).to.deep.equal(["progress", "完成"]);
            expect(observed).to.deep.equal(["progress", terminalType]);
        });
    }

    it("dispatches a final nonterminal event before enforcing the terminal requirement", async () => {
        for (const requireTerminal of [false, true]) {
            const events: string[] = [];
            let caught: unknown;
            try {
                await consumeNdjsonStream(
                    streamFromChunks(new TextEncoder().encode('{"type":"progress","text":"last"}')),
                    { onProgress: (event) => events.push(event.text) },
                    { requireTerminal },
                );
            } catch (error) {
                caught = error;
            }
            expect(events).to.deep.equal(["last"]);
            if (requireTerminal) expect(caught).to.be.instanceOf(StreamEndedBeforeTerminalError);
            else expect(caught).to.equal(undefined);
        }
    });

    it("reports a malformed unterminated final line instead of dropping it", async () => {
        for (const requireTerminal of [false, true]) {
            let caught: unknown;
            try {
                await consumeNdjsonStream(
                    streamFromChunks(new TextEncoder().encode('{"type":"progress"}\n\n{broken final record')),
                    {},
                    { requireTerminal },
                );
            } catch (error) {
                caught = error;
            }
            expect(caught).to.be.instanceOf(MalformedNdjsonLineError);
            expect((caught as MalformedNdjsonLineError).lineNumber).to.equal(3);
            expect((caught as Error).message).not.to.include("broken final record");
        }
    });

    it("propagates final-event handler errors and releases the reader lock", async () => {
        const stream = streamFromChunks(new TextEncoder().encode('{"type":"fatal"}'));
        const failure = new Error("server failed");
        let caught: unknown;
        try {
            await consumeNdjsonStream(stream, { onFatal: () => { throw failure; } }, { requireTerminal: true });
        } catch (error) {
            caught = error;
        }
        expect(caught).to.equal(failure);
        expect(stream.locked).to.equal(false);
    });

    it("does not treat a buffered terminal record as complete when the stream read fails", async () => {
        const failure = new Error("network interrupted");
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('{"type":"done"}'));
            },
            pull(controller) {
                controller.error(failure);
            },
        });
        let completed = false;
        let caught: unknown;
        try {
            await consumeNdjsonStream(stream, { onDone: () => { completed = true; } }, { requireTerminal: true });
        } catch (error) {
            caught = error;
        }
        expect(caught).to.equal(failure);
        expect(completed).to.equal(false);
        expect(stream.locked).to.equal(false);
    });

    it("ignores a whitespace-only final record", async () => {
        const events: string[] = [];
        await consumeNdjsonStream(
            streamFromChunks(new TextEncoder().encode('{"type":"progress"}\r\n \t\r')),
            { onProgress: (event) => events.push(event.type) },
        );
        expect(events).to.deep.equal(["progress"]);
    });

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

    it("revives transported non-finite numeric metrics before dispatch", async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('{"type":"symbol","row":{"profitFactor":{"__type":"non-finite-number","value":"Infinity"}}}\n'));
                controller.enqueue(encoder.encode('{"type":"done"}\n'));
                controller.close();
            },
        });

        let profitFactor: unknown;
        await consumeNdjsonStream<{ type: string; row?: { profitFactor?: unknown } }>(stream, {
            onSymbol: (event) => { profitFactor = event.row?.profitFactor; },
        });

        expect(profitFactor).to.equal(Infinity);
    });

    it("accepts a domain-specific terminal event", async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('{"type":"stability_done"}\n'));
                controller.close();
            },
        });

        await consumeNdjsonStream<{ type: string }>(
            stream,
            { onStabilityDone: () => {} },
            { requireTerminal: true, terminalTypes: ["stability_done", "fatal"] },
        );
    });

    it("throws MalformedNdjsonLineError on a malformed middle line", async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('{"type":"progress","text":"a"}\n'));
                controller.enqueue(encoder.encode('{bogus payload\n'));
                controller.enqueue(encoder.encode('{"type":"done","summary":"ok"}\n'));
                controller.close();
            },
        });

        let caught: unknown = null;
        try {
            await consumeNdjsonStream<{ type: string; text?: string; summary?: string }>(
                stream,
                {
                    onProgress: () => {},
                    onDone: () => {},
                },
            );
        } catch (error) {
            caught = error;
        }
        expect(caught).to.be.instanceOf(MalformedNdjsonLineError);
        expect((caught as MalformedNdjsonLineError).lineNumber).to.equal(2);
        expect((caught as Error).message).to.not.include("bogus payload");
    });

    it("throws MalformedNdjsonLineError on a malformed terminal line", async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('{"type":"progress","text":"a"}\n'));
                controller.enqueue(encoder.encode('{broken done line\n'));
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
        expect(caught).to.be.instanceOf(MalformedNdjsonLineError);
        expect((caught as MalformedNdjsonLineError).lineNumber).to.equal(2);
    });
});
