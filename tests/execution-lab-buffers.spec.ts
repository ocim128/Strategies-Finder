import { expect } from "chai";
import { describe, it } from "node:test";
import { mergeExecutionLabCandles, mergeExecutionLabQuotes, sortedMapValues } from "../lib/execution-lab/execution-lab-buffers";
import type { PolymarketClob1sQuoteRow } from "../lib/second-market/types";
import type { OHLCVData } from "../lib/types/strategies";

function candle(ts: number, close = ts): OHLCVData {
    return {
        time: ts as OHLCVData["time"],
        open: close,
        high: close,
        low: close,
        close,
        volume: 1,
    };
}

function quote(sampleTs: number, sourceTsMs: number, yesAsk: number): PolymarketClob1sQuoteRow {
    return {
        series_id: "10684",
        symbol: "BTCUSDT",
        outcome_interval: "5m",
        event_start_ts: 1_700_000_000,
        event_end_ts: 1_700_000_300,
        condition_id: "condition",
        market_slug: "btc-event",
        yes_token_id: "yes",
        no_token_id: "no",
        sample_ts: sampleTs,
        yes_bid: yesAsk - 0.02,
        yes_ask: yesAsk,
        yes_mid: yesAsk - 0.01,
        yes_last: null,
        no_bid: 1 - yesAsk,
        no_ask: 1 - yesAsk + 0.02,
        no_mid: 1 - yesAsk + 0.01,
        no_last: null,
        source: "polymarket_clob_1s",
        source_ts_ms: sourceTsMs,
        quote_age_ms: 0,
        quality_flags: "",
        updated_at: sampleTs,
    };
}

describe("Execution Lab buffers", () => {
    it("appends new candles without reordering the existing tail", () => {
        const merged = mergeExecutionLabCandles(
            [candle(100), candle(101)],
            [candle(102), candle(103)],
            10
        );

        expect(merged.map((item) => item.time)).to.deep.equal([100, 101, 102, 103]);
    });

    it("replaces same-timestamp tail candles", () => {
        const merged = mergeExecutionLabCandles(
            [candle(100), candle(101, 1)],
            [candle(101, 2)],
            10
        );

        expect(merged.map((item) => item.close)).to.deep.equal([100, 2]);
    });

    it("falls back to sorted merge for out-of-order batches", () => {
        const merged = mergeExecutionLabCandles(
            [candle(100), candle(103)],
            [candle(102), candle(101)],
            10
        );

        expect(merged.map((item) => item.time)).to.deep.equal([100, 101, 102, 103]);
    });

    it("trims to the newest max candle count", () => {
        const merged = mergeExecutionLabCandles(
            [candle(100), candle(101)],
            [candle(102), candle(103)],
            3
        );

        expect(merged.map((item) => item.time)).to.deep.equal([101, 102, 103]);
    });

    it("returns map values by ascending timestamp", () => {
        const values = sortedMapValues(new Map([
            [3, "c"],
            [1, "a"],
            [2, "b"],
        ]));

        expect(values).to.deep.equal(["a", "b", "c"]);
    });

    it("merges quote buffers by exact event second and keeps the newest quote", () => {
        const merged = mergeExecutionLabQuotes(
            [quote(101, 101_000, 0.5), quote(100, 100_000, 0.4)],
            [quote(101, 101_500, 0.55)]
        );

        expect(merged.map((item) => item.sample_ts)).to.deep.equal([100, 101]);
        expect(merged[1]?.yes_ask).to.equal(0.55);
    });
});
