import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { alertService } from "../lib/alert-service";

const originalFetch = globalThis.fetch;
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: { getItem: (key: string) => key === "alert_worker_url" ? "https://worker.example.test" : null },
    });
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("alert response body deadlines", () => {
    it("bounds a stalled health response body and preserves the timeout message", async t => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        globalThis.fetch = async (_input, init) => new Response(new ReadableStream({
            start(controller) {
                init!.signal!.addEventListener("abort", () => controller.error(init!.signal!.reason), { once: true });
            },
        }), { headers: { "content-type": "application/json" } });
        const result = alertService.healthCheck();
        await new Promise<void>(resolve => setImmediate(resolve));
        t.mock.timers.tick(10000);
        assert.deepEqual(await result, { ok: false, error: "Request timed out after 10000ms." });
    });

    it("never retries a mutation whose response body times out", async t => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        let calls = 0;
        globalThis.fetch = async (_input, init) => {
            calls++;
            assert.equal(init?.method, "POST");
            return new Response(new ReadableStream({
                start(controller) {
                    init!.signal!.addEventListener("abort", () => controller.error(init!.signal!.reason), { once: true });
                },
            }), { headers: { "content-type": "text/plain" } });
        };
        const result = assert.rejects(alertService.upsertSubscription({ symbol: "BTCUSDT" }), /Request timed out after 10000ms/);
        await new Promise<void>(resolve => setImmediate(resolve));
        t.mock.timers.tick(10000);
        await result;
        assert.equal(calls, 1);
    });

    it("preserves successful health metadata and API error messages", async () => {
        globalThis.fetch = async () => Response.json({ ok: true, service: "alerts", supportedStrategyKeys: ["test", ""] });
        const health = await alertService.healthCheck();
        assert.equal(health.ok, true);
        assert.equal(health.service, "alerts");
        assert.deepEqual(health.supportedStrategyKeys, ["test"]);
        globalThis.fetch = async () => Response.json({ error: "Subscription rejected" }, { status: 400 });
        await assert.rejects(alertService.upsertSubscription({}), /Subscription rejected/);
    });
});
