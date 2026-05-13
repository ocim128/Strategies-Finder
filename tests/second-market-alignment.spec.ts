import { describe, it } from "node:test";
import { expect } from "chai";
import {
    alignClobQuotesToCandles,
    alignGammaSnapshotsToCandles,
    alignReferencePricesToCandles,
} from "../lib/second-market/alignment";
import type {
    PolymarketClob1sQuoteRow,
    PolymarketGammaSnapshotRow,
    PolymarketReference1sPriceRow,
} from "../lib/second-market/types";
import type { OHLCVData } from "../lib/types/strategies";

function candle(ts: number): OHLCVData {
    return { time: ts as OHLCVData["time"], open: 1, high: 1, low: 1, close: 1, volume: 1 };
}

function quote(sampleTs: number, sourceTs: number): PolymarketClob1sQuoteRow {
    return {
        series_id: "10684",
        symbol: "BTCUSDT",
        outcome_interval: "5m",
        event_start_ts: 1_700_000_000,
        event_end_ts: 1_700_000_300,
        condition_id: "",
        market_slug: "btc-up-down",
        yes_token_id: "yes",
        no_token_id: "no",
        sample_ts: sampleTs,
        yes_bid: 0.49,
        yes_ask: 0.51,
        yes_mid: 0.5,
        yes_last: 0.5,
        no_bid: 0.48,
        no_ask: 0.52,
        no_mid: 0.5,
        no_last: 0.5,
        source: "polymarket_clob_1s",
        source_ts_ms: sourceTs * 1000,
        quote_age_ms: (sampleTs - sourceTs) * 1000,
        quality_flags: sampleTs === sourceTs ? "" : "carried_forward",
        updated_at: sampleTs,
    };
}

function reference(sourceTs: number): PolymarketReference1sPriceRow {
    return {
        symbol: "BTCUSDT",
        reference_source: "crypto_prices",
        source_symbol: "btcusdt",
        ts: sourceTs,
        source_ts_ms: sourceTs * 1000,
        received_ts_ms: sourceTs * 1000 + 5,
        reference_price: 100,
        full_accuracy_value: "",
        is_carried_forward: 0,
        quality_flags: "",
        updated_at: sourceTs,
    };
}

function gamma(snapshotTs: number): PolymarketGammaSnapshotRow {
    return {
        series_id: "10684",
        symbol: "BTCUSDT",
        outcome_interval: "5m",
        market_id: "m",
        condition_id: "",
        market_slug: "btc-up-down",
        event_start_ts: 1_700_000_000,
        event_end_ts: 1_700_000_300,
        snapshot_ts: snapshotTs,
        gamma_yes_price: 0.5,
        gamma_no_price: 0.5,
        last_trade_price: 0.5,
        liquidity: null,
        volume: null,
        open_interest: null,
        active: 1,
        closed: 0,
        remote_updated_at: null,
        raw_json_hash: "",
        raw_json: null,
        updated_at: snapshotTs,
    };
}

describe("second market alignment", () => {
    it("uses the observed sample second for strict CLOB alignment", () => {
        const aligned = alignClobQuotesToCandles(
            [candle(100), candle(101)],
            [quote(101, 100)],
            { mode: "strict" }
        );

        expect(aligned[0].quote).to.equal(null);
        expect(aligned[0].qualityFlags).to.include("missing_clob_quote");
        expect(aligned[1].hasExactClobQuote).to.equal(true);
        expect(aligned[1].quoteTs).to.equal(101);
    });

    it("allows causal relaxed CLOB alignment within max age", () => {
        const aligned = alignClobQuotesToCandles(
            [candle(101), candle(103)],
            [quote(100, 100)],
            { mode: "causal_relaxed", maxQuoteAgeSec: 2 }
        );

        expect(aligned[0].quoteAgeSec).to.equal(1);
        expect(aligned[1].quote).to.equal(null);
    });

    it("rejects future reference and Gamma data", () => {
        const references = alignReferencePricesToCandles([candle(100)], [reference(101)]);
        const gammas = alignGammaSnapshotsToCandles([candle(100)], [gamma(101)]);

        expect(references[0].reference).to.equal(null);
        expect(gammas[0].gamma).to.equal(null);
    });
});
