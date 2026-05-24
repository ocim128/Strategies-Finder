import { describe, it } from "node:test";
import { expect } from "chai";
import {
    evaluateSecondMarketTrades,
    SECOND_MARKET_UNRESOLVED_OUTCOME_SOURCE,
} from "../lib/second-market/backtest";
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

function unresolvedOutcome(): PolymarketOutcomeRow {
    return {
        ...outcome(),
        resolved_outcome_up: 0,
        resolution_source: SECOND_MARKET_UNRESOLVED_OUTCOME_SOURCE,
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
            evaluationMode: "signal_exit_same_event",
            mode: "strict",
        });

        expect(evaluated.results[0].entryPrice).to.equal(0.55);
        expect(evaluated.results[0].exitPrice).to.equal(0.58);
        expect(evaluated.results[0].pnl).to.be.closeTo(0.03, 1e-9);
        expect(evaluated.summary.scoredTrades).to.equal(1);
    });

    it("exits at Polymarket take-profit before the chart signal exit", () => {
        const evaluated = evaluateSecondMarketTrades({
            trades: [trade(1_700_000_010, 1_700_000_040)],
            outcomes: [outcome()],
            quotes: [
                quote(1_700_000_010, 0.50, 0.49),
                quote(1_700_000_020, 0.58, 0.56),
                quote(1_700_000_040, 0.60, 0.59),
            ],
            evaluationMode: "signal_exit_same_event",
            mode: "strict",
            protection: {
                polymarketProtectionTakeProfitEnabled: true,
                polymarketProtectionTakeProfitCents: 5,
            },
        });

        expect(evaluated.results[0].exitSource).to.equal("protection_take_profit");
        expect(evaluated.results[0].exitPrice).to.equal(0.55);
        expect(evaluated.summary.protectionTakeProfitExitedTrades).to.equal(1);
        expect(evaluated.summary.signalExitedTrades).to.equal(0);
    });

    it("does not count Polymarket protection exits after the chart trade already closed", () => {
        const closedBeforeProtection = trade(1_700_000_010, 1_700_000_020);
        closedBeforeProtection.exitReason = "take_profit";
        const evaluated = evaluateSecondMarketTrades({
            trades: [closedBeforeProtection],
            outcomes: [outcome()],
            quotes: [
                quote(1_700_000_010, 0.50, 0.49),
                quote(1_700_000_020, 0.53, 0.52),
                quote(1_700_000_030, 0.58, 0.56),
            ],
            evaluationMode: "signal_exit_same_event",
            mode: "strict",
            protection: {
                polymarketProtectionTakeProfitEnabled: true,
                polymarketProtectionTakeProfitCents: 5,
            },
        });

        expect(evaluated.results[0].exitSource).to.equal("resolution");
        expect(evaluated.summary.protectionTakeProfitExitedTrades).to.equal(0);
    });

    it("exits at Polymarket stop-loss using the sell-side quote", () => {
        const evaluated = evaluateSecondMarketTrades({
            trades: [trade(1_700_000_010, 1_700_000_040)],
            outcomes: [outcome()],
            quotes: [
                quote(1_700_000_010, 0.50, 0.49),
                quote(1_700_000_020, 0.45, 0.43),
                quote(1_700_000_040, 0.60, 0.59),
            ],
            evaluationMode: "signal_exit_same_event",
            mode: "strict",
            protection: {
                polymarketProtectionStopLossEnabled: true,
                polymarketProtectionStopLossCents: 5,
            },
        });

        expect(evaluated.results[0].exitSource).to.equal("protection_stop_loss");
        expect(evaluated.results[0].exitPrice).to.equal(0.43);
        expect(evaluated.summary.protectionStopLossExitedTrades).to.equal(1);
    });

    it("matches quotes by YES token when legacy outcome rows do not carry a NO token", () => {
        const legacyOutcome = {
            ...outcome(),
            no_token_id: "",
        };
        const evaluated = evaluateSecondMarketTrades({
            trades: [trade(1_700_000_010, 1_700_000_020)],
            outcomes: [legacyOutcome],
            quotes: [
                quote(1_700_000_010, 0.55, 0.53),
                quote(1_700_000_020, 0.60, 0.58),
            ],
            evaluationMode: "signal_exit_same_event",
            mode: "strict",
        });

        expect(evaluated.results[0].entryPrice).to.equal(0.55);
        expect(evaluated.results[0].exitPrice).to.equal(0.58);
        expect(evaluated.summary.scoredTrades).to.equal(1);
    });

    it("filters edge-priced CLOB entries before same-event dedupe", () => {
        const secondTrade = trade(1_700_000_030, 1_700_000_040);
        secondTrade.id = 2;

        const evaluated = evaluateSecondMarketTrades({
            trades: [
                trade(1_700_000_010, 1_700_000_020),
                secondTrade,
            ],
            outcomes: [outcome()],
            quotes: [
                quote(1_700_000_010, 0.20, 0.18),
                quote(1_700_000_020, 0.30, 0.28),
                quote(1_700_000_030, 0.55, 0.53),
                quote(1_700_000_040, 0.65, 0.63),
            ],
            evaluationMode: "signal_exit_same_event",
            entryPriceFilterCents: 20,
            mode: "strict",
        });

        expect(evaluated.results.map((result) => result.exitSource)).to.deep.equal(["entry_price_filtered", "signal"]);
        expect(evaluated.summary.entryPriceFilteredTrades).to.equal(1);
        expect(evaluated.summary.scoredTrades).to.equal(1);
        expect(evaluated.summary.duplicateTradesIgnored).to.equal(0);
    });

    it("filters entries inside the event-close cutoff before scoring", () => {
        const evaluated = evaluateSecondMarketTrades({
            trades: [trade(1_700_000_290, 1_700_000_295)],
            outcomes: [outcome()],
            quotes: [
                quote(1_700_000_290, 0.55, 0.53),
                quote(1_700_000_295, 0.60, 0.58),
            ],
            evaluationMode: "signal_exit_same_event",
            entryCutoffEnabled: true,
            entryCutoffSeconds: 15,
            mode: "strict",
        });

        expect(evaluated.results[0].exitSource).to.equal("entry_time_filtered");
        expect(evaluated.summary.entryTimeFilteredTrades).to.equal(1);
        expect(evaluated.summary.scoredTrades).to.equal(0);
    });

    it("waits for a 1s CLOB post-signal limit entry before scoring", () => {
        const evaluated = evaluateSecondMarketTrades({
            trades: [trade(1_700_000_010, 1_700_000_040)],
            outcomes: [outcome()],
            quotes: [
                quote(1_700_000_010, 0.62, 0.60),
                quote(1_700_000_020, 0.50, 0.48),
                quote(1_700_000_040, 0.60, 0.58),
            ],
            evaluationMode: "signal_exit_same_event",
            mode: "strict",
            limitEntry: {
                enabled: true,
                priceCents: 50,
            },
        });

        expect(evaluated.results[0].entrySource).to.equal("limit");
        expect(evaluated.results[0].entryStatus).to.equal("filled");
        expect(evaluated.results[0].entryPrice).to.equal(0.50);
        expect(evaluated.results[0].entryQuoteTs).to.equal(1_700_000_020);
        expect(evaluated.results[0].exitPrice).to.equal(0.58);
        expect(evaluated.results[0].pnl).to.be.closeTo(0.08, 1e-9);
        expect(evaluated.summary.limitEntryEnabled).to.equal(true);
        expect(evaluated.summary.limitEntryAttempts).to.equal(1);
        expect(evaluated.summary.limitEntryFilledTrades).to.equal(1);
        expect(evaluated.summary.avgLimitEntryWaitSec).to.equal(10);
    });

    it("skips 1s CLOB limit entries that only touch after the chart signal exit", () => {
        const evaluated = evaluateSecondMarketTrades({
            trades: [trade(1_700_000_010, 1_700_000_020)],
            outcomes: [outcome()],
            quotes: [
                quote(1_700_000_010, 0.62, 0.60),
                quote(1_700_000_030, 0.50, 0.48),
            ],
            evaluationMode: "signal_exit_same_event",
            mode: "strict",
            limitEntry: {
                enabled: true,
                priceCents: 50,
            },
        });

        expect(evaluated.results[0].entryStatus).to.equal("invalid_window");
        expect(evaluated.results[0].entryPrice).to.equal(null);
        expect(evaluated.summary.scoredTrades).to.equal(0);
        expect(evaluated.summary.limitEntryAttempts).to.equal(1);
        expect(evaluated.summary.limitEntryMissedTrades).to.equal(1);
        expect(evaluated.summary.limitEntryInvalidWindowTrades).to.equal(1);
    });

    it("can still compute final event resolution fills at the evaluator layer", () => {
        const position = trade(1_700_000_010, 1_700_000_020);
        position.exitReason = "take_profit";

        const evaluated = evaluateSecondMarketTrades({
            trades: [position],
            outcomes: [outcome()],
            quotes: [
                quote(1_700_000_010, 0.55, 0.53),
                quote(1_700_000_020, 0.60, 0.58),
            ],
            evaluationMode: "resolve_hold",
            mode: "strict",
        });

        expect(evaluated.results[0].exitSource).to.equal("resolution");
        expect(evaluated.results[0].exitPrice).to.equal(1);
        expect(evaluated.results[0].pnl).to.be.closeTo(0.45, 1e-9);
    });

    it("only exits early on actual signal exits in 1s signal-exit mode", () => {
        const position = trade(1_700_000_010, 1_700_000_020);
        position.exitReason = "take_profit";

        const evaluated = evaluateSecondMarketTrades({
            trades: [position],
            outcomes: [outcome()],
            quotes: [
                quote(1_700_000_010, 0.55, 0.53),
                quote(1_700_000_020, 0.60, 0.58),
            ],
            evaluationMode: "signal_exit_same_event",
            mode: "strict",
        });

        expect(evaluated.results[0].exitSource).to.equal("resolution");
        expect(evaluated.results[0].exitPrice).to.equal(1);
    });

    it("uses the chart close quote for non-signal exits in 1s chart-exit mode", () => {
        const position = trade(1_700_000_010, 1_700_000_020);
        position.exitReason = "time_stop";
        const losingOutcome = { ...outcome(), resolved_outcome_up: 0 as const };

        const evaluated = evaluateSecondMarketTrades({
            trades: [position],
            outcomes: [losingOutcome],
            quotes: [
                quote(1_700_000_010, 0.55, 0.53),
                quote(1_700_000_020, 0.60, 0.58),
            ],
            evaluationMode: "chart_exit_same_event",
            mode: "strict",
        });

        expect(evaluated.results[0].exitSource).to.equal("signal");
        expect(evaluated.results[0].exitPrice).to.equal(0.58);
        expect(evaluated.results[0].pnl).to.be.closeTo(0.03, 1e-9);
        expect(evaluated.summary.evaluationMode).to.equal("chart_exit_same_event");
        expect(evaluated.summary.resolvedTrades).to.equal(0);
        expect(evaluated.summary.signalExitedTrades).to.equal(1);
    });

    it("can score multiple signal-exit trades in one event when enabled", () => {
        const secondTrade = trade(1_700_000_030, 1_700_000_040);
        secondTrade.id = 2;

        const evaluated = evaluateSecondMarketTrades({
            trades: [
                trade(1_700_000_010, 1_700_000_020),
                secondTrade,
            ],
            outcomes: [outcome()],
            quotes: [
                quote(1_700_000_010, 0.55, 0.53),
                quote(1_700_000_020, 0.60, 0.58),
                quote(1_700_000_030, 0.50, 0.48),
                quote(1_700_000_040, 0.57, 0.55),
            ],
            evaluationMode: "signal_exit_same_event",
            allowMultipleTradesPerEvent: true,
            mode: "strict",
        });

        expect(evaluated.results.map((result) => result.exitSource)).to.deep.equal(["signal", "signal"]);
        expect(evaluated.summary.scoredTrades).to.equal(2);
        expect(evaluated.summary.duplicateTradesIgnored).to.equal(0);
        expect(evaluated.summary.allowMultipleTradesPerEvent).to.equal(true);
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

    it("does not invent resolution exits for unresolved CLOB-only events", () => {
        const position = trade(1_700_000_010, 1_700_000_400);
        position.exitReason = "end_of_data";
        const evaluated = evaluateSecondMarketTrades({
            trades: [position],
            outcomes: [unresolvedOutcome()],
            quotes: [quote(1_700_000_010, 0.40, 0.38)],
            mode: "strict",
        });

        expect(evaluated.results[0].exitSource).to.equal("missing");
        expect(evaluated.results[0].exitPrice).to.equal(null);
        expect(evaluated.results[0].pnl).to.equal(null);
        expect(evaluated.summary.scoredTrades).to.equal(0);
        expect(evaluated.summary.missingQuoteTrades).to.equal(1);
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
