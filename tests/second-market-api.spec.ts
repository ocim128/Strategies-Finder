import { describe, it } from "node:test";
import { expect } from "chai";
import { loadSecondMarketCandles } from "../lib/second-market/api";

describe("second-market API client", () => {
    it("refetches JSON when a binary candle response is malformed", async () => {
        const originalFetch = globalThis.fetch;
        const acceptHeaders: string[] = [];

        globalThis.fetch = (async (_input, init) => {
            const headers = init?.headers as Record<string, string> | undefined;
            acceptHeaders.push(String(headers?.Accept ?? ""));
            if (acceptHeaders.length === 1) {
                return new Response(new ArrayBuffer(4), {
                    status: 200,
                    headers: { "content-type": "application/octet-stream" },
                });
            }
            return new Response(JSON.stringify({
                ok: true,
                candles: [{
                    ts: 1_700_000_000,
                    open: 100,
                    high: 101,
                    low: 99,
                    close: 100.5,
                    volume: 12,
                }],
            }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }) as typeof fetch;

        try {
            const candles = await loadSecondMarketCandles({ symbol: "BTCUSDT", limit: 1 });

            expect(candles).to.deep.equal([{
                time: 1_700_000_000,
                open: 100,
                high: 101,
                low: 99,
                close: 100.5,
                volume: 12,
            }]);
            expect(acceptHeaders).to.deep.equal(["application/octet-stream", "application/json"]);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
