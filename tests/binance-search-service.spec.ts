import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { binanceSearchService } from "../lib/binance-search-service";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("Binance exchange-info body deadlines", () => {
    it("retries a stalled body, shares the load, and caches a successful response", async t => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        let calls = 0;
        globalThis.fetch = async (_input, init) => {
            if (++calls === 1) return new Response(new ReadableStream({
                start(controller) {
                    init!.signal!.addEventListener("abort", () => controller.error(init!.signal!.reason), { once: true });
                },
            }), { headers: { "content-type": "application/json" } });
            return Response.json({ symbols: [
                { symbol: "BTCUSDT", status: "TRADING", baseAsset: "BTC", quoteAsset: "USDT" },
                { symbol: "OLDUSDT", status: "BREAK", baseAsset: "OLD", quoteAsset: "USDT" },
            ] });
        };
        const first = binanceSearchService.getAllSymbols("spot");
        const shared = binanceSearchService.getAllSymbols("spot");
        await new Promise<void>(resolve => setImmediate(resolve));
        t.mock.timers.tick(8000);
        await new Promise<void>(resolve => setImmediate(resolve));
        t.mock.timers.tick(250);
        const symbols = await first;
        assert.deepEqual(symbols.map(symbol => symbol.symbol), ["BTCUSDT"]);
        assert.strictEqual(await shared, symbols);
        assert.strictEqual(await binanceSearchService.getAllSymbols("spot"), symbols);
        assert.equal(calls, 2);
    });

    it("releases a failed load so a later search can retry", async t => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        let calls = 0;
        globalThis.fetch = async (_input, init) => {
            calls++;
            return new Response(new ReadableStream({
                start(controller) {
                    init!.signal!.addEventListener("abort", () => controller.error(init!.signal!.reason), { once: true });
                },
            }));
        };
        const failed = binanceSearchService.getAllSymbols("futures");
        await new Promise<void>(resolve => setImmediate(resolve));
        t.mock.timers.tick(8000);
        await new Promise<void>(resolve => setImmediate(resolve));
        t.mock.timers.tick(250);
        await new Promise<void>(resolve => setImmediate(resolve));
        t.mock.timers.tick(8000);
        assert.deepEqual(await failed, []);
        assert.equal(calls, 2);
        globalThis.fetch = async () => { calls++; return Response.json({ symbols: [] }); };
        assert.deepEqual(await binanceSearchService.getAllSymbols("futures"), []);
        assert.equal(calls, 3);
    });
});
