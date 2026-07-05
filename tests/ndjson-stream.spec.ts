import { expect } from "chai";
import { describe, it } from "node:test";
import { consumeNdjsonStream } from "../lib/ndjson-stream";

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
});
