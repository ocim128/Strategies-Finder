import { afterEach, describe, it } from "node:test";
import { expect } from "chai";
import { fetchBinance1sCandles } from "../lib/second-market/binance-1s-sync";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
});

describe("second market Binance 1s sync", () => {
    it("builds futures 1s candles from aggregate trades", async () => {
        const requestedUrls: string[] = [];
        const progressEvents: Array<{ fetched: number; cursorTs: number; requestCount: number }> = [];
        globalThis.fetch = (async (input) => {
            const url = new URL(
                typeof input === "string"
                    ? input
                    : input instanceof URL
                        ? input.toString()
                        : input.url
            );
            requestedUrls.push(url.toString());
            expect(url.pathname).to.equal("/fapi/v1/aggTrades");
            expect(url.searchParams.get("symbol")).to.equal("BTCUSDT");
            return new Response(JSON.stringify([
                { a: 10, p: "100", q: "1.5", f: 100, l: 101, T: 1_700_000_000_100 },
                { a: 11, p: "102", q: "2", f: 102, l: 102, T: 1_700_000_002_250 },
                { a: 12, p: "101", q: "0.5", f: 103, l: 103, T: 1_700_000_002_500 },
                { a: 13, p: "103", q: "0.25", f: 104, l: 104, T: 1_700_000_002_750 },
            ]), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }) as typeof fetch;

        const rows = await fetchBinance1sCandles({
            symbol: "BTCUSDT",
            marketType: "futures",
            startTs: 1_700_000_000,
            endTs: 1_700_000_002,
            onProgress: (progress) => progressEvents.push(progress),
        });

        expect(requestedUrls).to.have.length(1);
        expect(progressEvents.map((progress) => progress.fetched)).to.deep.equal([3]);
        expect(rows).to.have.length(3);
        expect(rows.map((row) => row.ts)).to.deep.equal([1_700_000_000, 1_700_000_001, 1_700_000_002]);
        expect(rows[0]).to.include({
            market_type: "futures",
            open: 100,
            high: 100,
            low: 100,
            close: 100,
            volume: 1.5,
            trade_count: 2,
        });
        expect(rows[1]).to.include({
            open: 100,
            high: 100,
            low: 100,
            close: 100,
            volume: 0,
            trade_count: 0,
        });
        expect(rows[2]).to.include({
            open: 102,
            high: 103,
            low: 101,
            close: 103,
            volume: 2.75,
            trade_count: 3,
        });
    });
});
