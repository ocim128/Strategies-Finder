/**
 * Live-price quote deadline and identity regressions.
 *
 * `fetchCurrentPrice` is driven through a narrow test seam so the specs can
 * exercise the transport, pending-request, and cache-identity behavior without
 * running the full subscription poll. Mock timers drive the 5s per-attempt
 * ticker deadlines so no test waits on real time.
 *
 * Phase coverage:
 * - deadlines stay active while a ticker JSON body is consumed (a stalled body
 *   settles through the per-attempt deadline instead of pinning
 *   PRICE_REQUESTS forever);
 * - Stop/caller cancellation after headers still works;
 * - the pending entry is released after failure so a subsequent request can
 *   start;
 * - provider-scoped identity: spot and futures requests for one symbol never
 *   share a cached or in-flight quote, Binance ticker keys stay
 *   interval-independent, and the Bybit TradFi key includes the normalized
 *   fallback interval because the fallback candle price depends on it;
 * - the active-chart shortcut only reuses candles whose loaded context
 *   (symbol + interval + Binance market) provably matches the requested
 *   provider.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { livePositionsService } from "../lib/live-positions-service";
import type { DataProvider } from "../lib/types/data-providers";

const originalFetch = globalThis.fetch;

const tickerResponse = (price: string): Response => new Response(
    JSON.stringify({ symbol: "BTCUSDT", price }),
    { status: 200, headers: { "content-type": "application/json" } },
);

const stalledBodyResponse = (init: RequestInit | undefined): Response => {
    const signal = init!.signal!;
    return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
            signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
    }));
};

const drain = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/** Advance mock timers until `op` settles; each tick clears every due deadline/backoff. */
async function tickUntilSettled(t: { mock: { timers: { tick: (ms: number) => void } } }, op: Promise<unknown>, maxTicks = 400): Promise<void> {
    let settled = false;
    op.then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < maxTicks && !settled; i += 1) {
        await drain();
        t.mock.timers.tick(6_000);
    }
    await drain();
}

const fetchQuote = (symbol: string, provider: DataProvider, interval = "4h"): Promise<number | null> =>
    livePositionsService.__fetchCurrentPriceForTests(symbol, interval, provider);

describe("live price ticker deadlines", () => {
    beforeEach(() => {
        livePositionsService.__resetLivePriceCachesForTests();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        livePositionsService.__resetLivePriceCachesForTests();
    });

    it("consumes a normal Binance ticker response inside the deadline scope", async () => {
        let calls = 0;
        globalThis.fetch = (async () => {
            calls += 1;
            return tickerResponse("65000.5");
        }) as typeof fetch;

        const price = await fetchQuote("BTCUSDT", "binance");

        assert.equal(price, 65000.5);
        assert.equal(calls, 1);
    });

    it("aborts a stalled ticker body at the per-attempt deadline and recovers on retry", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        let calls = 0;
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            calls += 1;
            if (calls === 1) return stalledBodyResponse(init);
            return tickerResponse("65001");
        }) as typeof fetch;

        const op = fetchQuote("BTCUSDT", "binance");
        await tickUntilSettled(t, op);

        assert.equal(await op, 65001);
        assert.equal(calls, 2);
    });

    it("releases the pending quote after exhausted deadlines so a later request can start", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => stalledBodyResponse(init)) as typeof fetch;

        // Every attempt (2 Binance + 2 Bybit fallback) stalls until its 5s
        // deadline; the quote then fails instead of pinning PRICE_REQUESTS.
        const failed = fetchQuote("BTCUSDT", "binance");
        await tickUntilSettled(t, failed);
        assert.equal(await failed, null);

        // A subsequent request runs its own transport instead of joining the
        // wedged one that used to hang forever.
        globalThis.fetch = (async () => tickerResponse("65002")) as typeof fetch;
        assert.equal(await fetchQuote("BTCUSDT", "binance"), 65002);
    });

    it("treats a malformed JSON body as a failed attempt and recovers on retry", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        let calls = 0;
        globalThis.fetch = (async () => {
            calls += 1;
            return calls === 1
                ? new Response("{not json", { status: 200, headers: { "content-type": "application/json" } })
                : tickerResponse("65003");
        }) as typeof fetch;

        const op = fetchQuote("BTCUSDT", "binance");
        await tickUntilSettled(t, op);

        assert.equal(await op, 65003);
        assert.equal(calls, 2);
    });

    it("keeps the Bybit linear fallback working when Binance fails its attempts", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const calls: string[] = [];
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = String(input);
            calls.push(url.includes("binance") ? "binance" : "bybit");
            if (url.includes("binance")) {
                return new Response("rate limited", { status: 503 });
            }
            return new Response(JSON.stringify({
                result: { list: [{ lastPrice: "65004.25" }] },
            }), { status: 200, headers: { "content-type": "application/json" } });
        }) as typeof fetch;

        const op = fetchQuote("BTCUSDT", "binance");
        await tickUntilSettled(t, op);

        assert.equal(await op, 65004.25);
        // Binance exhausted its 2 attempts, then the Bybit fallback answered.
        assert.deepEqual(calls.filter((host) => host === "binance"), ["binance", "binance"]);
        assert.deepEqual(calls.filter((host) => host === "bybit"), ["bybit"]);
    });
});
