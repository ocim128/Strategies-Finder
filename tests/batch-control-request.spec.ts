import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { requestBatchControl } from "../lib/batch-backtest/browser/batch-control-request";

describe("Batch control request lifetime", () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = originalFetch; });

    it("times out stalled headers even when the transport ignores abort", async () => {
        let signal: AbortSignal | undefined;
        globalThis.fetch = async (_url, init) => {
            signal = init?.signal ?? undefined;
            return new Promise<Response>(() => {});
        };
        await assert.rejects(
            requestBatchControl("/status", {}, (response) => response.text(), { timeoutMs: 10 }),
            { name: "TimeoutError" },
        );
        assert.equal(signal?.aborted, true);
    });

    it("keeps the deadline active while consuming a stalled body", async () => {
        globalThis.fetch = async () => ({
            text: () => new Promise<string>(() => {}),
        }) as Response;
        await assert.rejects(
            requestBatchControl("/status", {}, (response) => response.text(), { timeoutMs: 10 }),
            { name: "TimeoutError" },
        );
    });

    it("owner cancellation interrupts body consumption", async () => {
        const owner = new AbortController();
        let consuming!: () => void;
        const started = new Promise<void>((resolve) => { consuming = resolve; });
        globalThis.fetch = async () => ({
            text: () => { consuming(); return new Promise<string>(() => {}); },
        }) as Response;
        const request = requestBatchControl("/status", {}, (response) => response.text(), { signal: owner.signal });
        await started;
        owner.abort();
        await assert.rejects(request, { name: "AbortError" });
    });

    it("does not fetch for an already disposed owner", async () => {
        const owner = new AbortController();
        owner.abort();
        globalThis.fetch = async () => { throw new Error("must not fetch"); };
        await assert.rejects(
            requestBatchControl("/status", {}, (response) => response.text(), { signal: owner.signal }),
            { name: "AbortError" },
        );
    });

    it("successful consumption releases its owner listener", async () => {
        const owner = new AbortController();
        let signal: AbortSignal | undefined;
        globalThis.fetch = async (_url, init) => {
            signal = init?.signal ?? undefined;
            return new Response("ready");
        };
        assert.equal(await requestBatchControl("/status", {}, (response) => response.text(), {
            signal: owner.signal,
        }), "ready");
        owner.abort();
        assert.equal(signal?.aborted, false, "settled request no longer follows its owner");
    });
});
