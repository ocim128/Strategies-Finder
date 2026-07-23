/**
 * Focused unit tests for the shared Batch NDJSON POST helper (audit
 * NDJSON-POST-helper finding). The helper consolidates the four transport
 * mechanics (JSON POST, response validation, JSON error extraction,
 * `consumeNdjsonStream({ requireTerminal: true })`) that the five Batch
 * server-side call sites used to duplicate. These tests lock the transport
 * contract independently of any one endpoint's typed handler shape.
 */
import { expect } from "chai";
import { describe, it, before, after } from "node:test";
import { postBatchNdjson, extractBatchServerError } from "../lib/batch-backtest/batch-ndjson-post";

type FetchResponse = {
    ok: boolean;
    status: number;
    body?: ReadableStream<Uint8Array> | null;
    text?: string;
};

function ndjsonStream(lines: object[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const content = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoder.encode(content));
            controller.close();
        },
    });
}

let savedFetch: any;

before(() => {
    savedFetch = (globalThis as any).fetch;
});

after(() => {
    (globalThis as any).fetch = savedFetch;
});

function mockFetch(responder: (url: string, init?: any) => FetchResponse | Promise<FetchResponse>): void {
    (globalThis as any).fetch = async (url: string, init?: any) => {
        const r = await responder(url, init);
        return {
            ok: r.ok,
            status: r.status,
            body: r.body ?? null,
            text: async () => r.text ?? "",
        };
    };
}

describe("postBatchNdjson (audit NDJSON-POST-helper finding)", () => {
    it("dispatches stream events to typed handlers and resolves after `done`", async () => {
        const events: string[] = [];
        const observed: string[] = [];
        mockFetch(() => ({
            ok: true,
            status: 200,
            body: ndjsonStream([
                { type: "start", total: 2 },
                { type: "progress", pct: 50 },
                { type: "done", ok: true },
            ]),
        }));
        await postBatchNdjson<{ type: string }>({
            endpoint: "/x",
            body: { foo: 1 },
            onEvent: (event) => observed.push(event.type),
            handlers: {
                onStart: () => events.push("start"),
                onProgress: () => events.push("progress"),
                onDone: () => events.push("done"),
            },
        });
        expect(events).to.deep.equal(["start", "progress", "done"]);
        expect(observed).to.deep.equal(["start", "progress", "done"]);
    });

    it("supports a domain-specific terminal event for stability runs", async () => {
        const events: string[] = [];
        mockFetch(() => ({
            ok: true,
            status: 200,
            body: ndjsonStream([{ type: "stability_done", gate: "BLOCKED" }]),
        }));
        await postBatchNdjson<{ type: string }>({
            endpoint: "/x",
            body: {},
            terminalTypes: ["stability_done", "done", "fatal"],
            handlers: {
                onStabilityDone: (event) => events.push(event.gate),
            },
        });
        expect(events).to.deep.equal(["BLOCKED"]);
    });

    it("throws a server-supplied message on a non-2xx response (extracted from JSON)", async () => {
        mockFetch(() => ({
            ok: false,
            status: 400,
            text: JSON.stringify({ error: "bad request body" }),
        }));
        let caught: Error | null = null;
        try {
            await postBatchNdjson<{ type: string }>({
                endpoint: "/x",
                body: {},
                handlers: {},
            });
        } catch (e) {
            caught = e as Error;
        }
        expect(caught?.message).to.equal("bad request body");
    });

    it("falls back to raw text when the error body is not JSON", async () => {
        mockFetch(() => ({
            ok: false,
            status: 500,
            text: "internal server error plain text",
        }));
        let caught: Error | null = null;
        try {
            await postBatchNdjson<{ type: string }>({
                endpoint: "/x",
                body: {},
                handlers: {},
            });
        } catch (e) {
            caught = e as Error;
        }
        expect(caught?.message).to.equal("internal server error plain text");
    });

    it("throws on a clean EOF before `done` (requireTerminal)", async () => {
        // Intent being locked (AGENTS.md rule 8): the helper always uses
        // requireTerminal so a truncated stream cannot resolve normally and
        // present a partial result as complete. This is the same invariant
        // every call site had individually before consolidation.
        mockFetch(() => ({
            ok: true,
            status: 200,
            body: ndjsonStream([{ type: "start", total: 2 }]), // no terminal event
        }));
        let caught: unknown = null;
        try {
            await postBatchNdjson<{ type: string }>({
                endpoint: "/x",
                body: {},
                handlers: {},
            });
        } catch (e) {
            caught = e;
        }
        expect(caught, "truncated stream must throw").to.not.equal(null);
        expect((caught as Error).message.toLowerCase()).to.include("terminal");
    });

    it("onResponse fires after validation but before the stream is consumed", async () => {
        // Intent being locked: the analysis paths' reissue-Stop ordering
        // depends on onResponse firing AFTER the server has established
        // ownership (response validated) but BEFORE stream consumption starts.
        const order: string[] = [];
        mockFetch(() => ({
            ok: true,
            status: 200,
            body: ndjsonStream([
                { type: "start" },
                { type: "done", ok: true },
            ]),
        }));
        await postBatchNdjson<{ type: string }>({
            endpoint: "/x",
            body: {},
            onResponse: () => { order.push("onResponse"); },
            handlers: {
                onStart: () => { order.push("start"); },
                onDone: () => { order.push("done"); },
            },
        });
        expect(order).to.deep.equal(["onResponse", "start", "done"]);
    });

    it("onNonOkResponse fires before the error is thrown and receives the parsed payload", async () => {
        // Intent being locked: Stability and Portfolio Fit flip
        // serverHasArtifacts=false on a 400 "no artifacts" so the next click
        // short-circuits. The hook receives the parsed error payload so they
        // can match structurally without re-reading the body.
        let hookStatus: number | null = null;
        let hookPayload: Record<string, unknown> | null = null;
        mockFetch(() => ({
            ok: false,
            status: 400,
            text: JSON.stringify({ error: "no artifacts on server" }),
        }));
        let caught: Error | null = null;
        try {
            await postBatchNdjson<{ type: string }>({
                endpoint: "/x",
                body: {},
                onNonOkResponse: (status, payload) => {
                    hookStatus = status;
                    hookPayload = payload;
                },
                handlers: {},
            });
        } catch (e) {
            caught = e as Error;
        }
        expect(hookStatus).to.equal(400);
        expect((hookPayload as Record<string, unknown> | null)?.error).to.equal("no artifacts on server");
        expect(caught?.message).to.equal("no artifacts on server");
    });
});

describe("extractBatchServerError (audit NDJSON-POST-helper finding)", () => {
    it("returns the JSON error and payload when the body is JSON", async () => {
        const response = {
            status: 400,
            text: async () => JSON.stringify({ error: "boom", extra: 7 }),
        } as Response;
        const { message, payload } = await extractBatchServerError(response);
        expect(message).to.equal("boom");
        expect(payload?.extra).to.equal(7);
    });

    it("falls back to HTTP status when the body is empty", async () => {
        const response = {
            status: 502,
            text: async () => "",
        } as Response;
        const { message, payload } = await extractBatchServerError(response);
        expect(message).to.equal("HTTP 502");
        expect(payload).to.equal(null);
    });
});
