import { describe, it } from "node:test";
import { expect } from "chai";
import { evaluateSecondMarketTrades } from "../lib/second-market/backtest";
import type { PolymarketClob1sQuoteRow } from "../lib/second-market/types";
import type { PolymarketOutcomeRow } from "../lib/types/polymarket-outcomes";
import type { Trade } from "../lib/types/strategies";

function outcome(): PolymarketOutcomeRow {
    return {
        series_id: "10684",
        event_slug: "btc-event",
        market_slug: "btc-event",
        interval: "5m",
        event_start_ts: 1_700_000_000,
        event_end_ts: 1_700_000_300,
        yes_token_id: "yes",
        no_token_id: "no",
        yes_open_price: null,
        yes_entry_minute_1_price: null,
        yes_entry_minute_2_price: null,
        yes_entry_minute_3_price: null,
        yes_entry_minute_4_price: null,
        resolved_outcome_up: 1,
        resolution_source: "test",
        updated_at: 1_700_000_301,
    };
}

function trade(entryTs: number, exitTs: number): Trade {
    return {
        id: 1,
        type: "long",
        entryTime: entryTs as Trade["entryTime"],
        entryPrice: 100,
        exitTime: exitTs as Trade["exitTime"],
        exitPrice: 101,
        pnl: 1,
        pnlPercent: 1,
        size: 1,
        exitReason: "signal",
    };
}

function quote(ts: number, yesAsk: number, yesBid: number): PolymarketClob1sQuoteRow {
    return {
        series_id: "10684",
        symbol: "BTCUSDT",
        outcome_interval: "5m",
        event_start_ts: 1_700_000_000,
        event_end_ts: 1_700_000_300,
        condition_id: "",
        market_slug: "btc-event",
        yes_token_id: "yes",
        no_token_id: "no",
        sample_ts: ts,
        yes_bid: yesBid,
        yes_ask: yesAsk,
        yes_mid: (yesAsk + yesBid) / 2,
        yes_last: null,
        no_bid: 1 - yesAsk,
        no_ask: 1 - yesBid,
        no_mid: 0.5,
        no_last: null,
        source: "polymarket_clob_1s",
        source_ts_ms: ts * 1000,
        quote_age_ms: 0,
        quality_flags: "",
        updated_at: ts,
    };
}

function quoteForSeries(
    seriesId: string,
    yesTokenId: string,
    noTokenId: string,
    ts: number,
    yesAsk: number,
    yesBid: number
): PolymarketClob1sQuoteRow {
    return {
        ...quote(ts, yesAsk, yesBid),
        series_id: seriesId,
        yes_token_id: yesTokenId,
        no_token_id: noTokenId,
    };
}

describe("second market backtest evaluator", () => {
    it("uses CLOB ask for entry and bid for signal exit", () => {
        const evaluated = evaluateSecondMarketTrades({
            trades: [trade(1_700_000_010, 1_700_000_020)],
            outcomes: [outcome()],
            quotes: [
                quote(1_700_000_010, 0.55, 0.53),
                quote(1_700_000_020, 0.60, 0.58),
            ],
            mode: "strict",
        });

        expect(evaluated.results[0].entryPrice).to.equal(0.55);
        expect(evaluated.results[0].exitPrice).to.equal(0.58);
        expect(evaluated.results[0].pnl).to.be.closeTo(0.03, 1e-9);
        expect(evaluated.summary.scoredTrades).to.equal(1);
    });

    it("does not use future quotes to fill missing strict entries", () => {
        const evaluated = evaluateSecondMarketTrades({
            trades: [trade(1_700_000_010, 1_700_000_020)],
            outcomes: [outcome()],
            quotes: [
                quote(1_700_000_011, 0.55, 0.53),
                quote(1_700_000_020, 0.60, 0.58),
            ],
            mode: "strict",
        });

        expect(evaluated.results[0].entryPrice).to.equal(null);
        expect(evaluated.results[0].exitSource).to.equal("missing");
        expect(evaluated.summary.missingQuoteTrades).to.equal(1);
    });

    it("scores resolution exits without using Gamma or reference prices", () => {
        const position = trade(1_700_000_010, 1_700_000_400);
        position.exitReason = "end_of_data";
        const evaluated = evaluateSecondMarketTrades({
            trades: [position],
            outcomes: [outcome()],
            quotes: [quote(1_700_000_010, 0.40, 0.38)],
            mode: "strict",
        });

        expect(evaluated.results[0].exitSource).to.equal("resolution");
        expect(evaluated.results[0].exitPrice).to.equal(1);
        expect(evaluated.results[0].pnl).to.equal(0.6);
    });

    it("does not fill from another symbol series at the same second", () => {
        const evaluated = evaluateSecondMarketTrades({
            trades: [trade(1_700_000_010, 1_700_000_020)],
            outcomes: [outcome()],
            quotes: [
                quoteForSeries("10685", "xrp-yes", "xrp-no", 1_700_000_010, 0.20, 0.18),
                quoteForSeries("10685", "xrp-yes", "xrp-no", 1_700_000_020, 0.30, 0.28),
            ],
            mode: "strict",
        });

        expect(evaluated.results[0].entryPrice).to.equal(null);
        expect(evaluated.results[0].exitSource).to.equal("missing");
    });
});
