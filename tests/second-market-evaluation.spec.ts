import { describe, it } from "node:test";
import { expect } from "chai";
import {
    annotateBacktestResultWithSecondMarketClob,
    evaluateSecondMarketBacktest,
    isSecondMarketPolymarketScoringSupported,
    type SecondMarketEvaluationContext,
} from "../lib/second-market/evaluation";
import type { PolymarketClob1sQuoteRow } from "../lib/second-market/types";
import type { BacktestResult, Trade } from "../lib/types/strategies";
import type { PolymarketOutcomeRow } from "../lib/types/polymarket-outcomes";

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

function trade(id: number, entryTs: number, exitTs: number, type: Trade["type"] = "long"): Trade {
    return {
        id,
        type,
        entryTime: entryTs as Trade["entryTime"],
        entryPrice: 100,
        exitTime: exitTs as Trade["exitTime"],
        exitPrice: 101,
        pnl: 1,
        pnlPercent: 1,
        size: 1,
        exitReason: "take_profit",
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

function result(trades: Trade[]): BacktestResult {
    return {
        trades,
        netProfit: 0,
        netProfitPercent: 0,
        winRate: 0,
        expectancy: 0,
        avgTrade: 0,
        profitFactor: 0,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: trades.length,
        winningTrades: 0,
        losingTrades: 0,
        avgWin: 0,
        avgLoss: 0,
        sharpeRatio: 0,
        equityCurve: [],
    };
}

function context(quotes: PolymarketClob1sQuoteRow[]): SecondMarketEvaluationContext {
    return {
        symbol: "BTCUSDT",
        outcomeSymbol: "BTCUSDT",
        seriesId: "10684",
        outcomeInterval: "5m",
        outcomes: [outcome()],
        quotes,
        gammaSnapshots: [],
    };
}

describe("second market shared evaluation", () => {
    it("supports 1s CLOB scoring for next-open and next-close chart execution", () => {
        expect(isSecondMarketPolymarketScoringSupported({
            symbol: "BTCUSDT",
            interval: "1s",
            executionModel: "next_open",
        })).to.equal(true);
        expect(isSecondMarketPolymarketScoringSupported({
            symbol: "BTCUSDT",
            interval: "1s",
            executionModel: "next_close",
        })).to.equal(true);
        expect(isSecondMarketPolymarketScoringSupported({
            symbol: "BTCUSDT",
            interval: "1s",
            executionModel: "signal_close",
        })).to.equal(false);
    });

    it("defaults reusable 1s annotations to signal-exit mode", () => {
        const evaluated = evaluateSecondMarketBacktest({
            result: result([trade(1, 1_700_000_010, 1_700_000_020)]),
            context: context([
                quote(1_700_000_010, 0.55, 0.53),
                quote(1_700_000_020, 0.60, 0.58),
            ]),
        });

        expect(evaluated.polymarketSummary.evaluationMode).to.equal("signal_exit_same_event");
        expect(evaluated.polymarketSummary.scoredTrades).to.equal(1);
        expect(evaluated.polymarketSummary.netPnl).to.be.closeTo(0.45, 1e-9);
        expect(evaluated.polymarketEval.evaluationMode).to.equal("signal_exit_same_event");
        expect(evaluated.polymarketEval.scoredPredictions).to.equal(1);
        expect(evaluated.polymarketEval.coverage).to.equal(1);
        expect(evaluated.polymarketEval.breakEvenWinRate).to.equal(0);
        expect(evaluated.polymarketEval.edgeVsBreakEven).to.equal(0);
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketEntryPrice).to.equal(0.55);
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketExitSource).to.equal("resolution");
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketExitPrice).to.equal(1);
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.isWin).to.equal(true);
    });

    it("uses exact 1s CLOB exit fills when signal-exit mode is selected", () => {
        const signalTrade = trade(1, 1_700_000_010, 1_700_000_020);
        signalTrade.exitReason = "signal";

        const evaluated = evaluateSecondMarketBacktest({
            result: result([signalTrade]),
            context: context([
                quote(1_700_000_010, 0.55, 0.53),
                quote(1_700_000_020, 0.60, 0.58),
            ]),
            polymarketExitMode: "signal_exit_same_event",
        });

        expect(evaluated.polymarketSummary.evaluationMode).to.equal("signal_exit_same_event");
        expect(evaluated.polymarketSummary.netPnl).to.be.closeTo(0.03, 1e-9);
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketExitSource).to.equal("signal");
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketExitPrice).to.equal(0.58);
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.isWin).to.equal(null);
    });

    it("carries entry price filter counts through 1s CLOB summaries and annotations", () => {
        const evaluated = evaluateSecondMarketBacktest({
            result: result([trade(1, 1_700_000_010, 1_700_000_020)]),
            context: context([
                quote(1_700_000_010, 0.20, 0.18),
                quote(1_700_000_020, 0.30, 0.28),
            ]),
            polymarketExitMode: "signal_exit_same_event",
            entryPriceFilterCents: 20,
        });

        expect(evaluated.summary.entryPriceFilteredTrades).to.equal(1);
        expect(evaluated.polymarketSummary.entryPriceFilteredTrades).to.equal(1);
        expect(evaluated.polymarketSummary.scoredTrades).to.equal(0);
        expect(evaluated.polymarketEval.entryPriceFilteredPredictions).to.equal(1);
        expect(evaluated.polymarketEval.scoredPredictions).to.equal(0);
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketExitSource).to.equal("entry_price_filtered");
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketEntryPrice).to.equal(0.20);
    });

    it("carries post-signal limit entry counts through 1s CLOB summaries and annotations", () => {
        const signalTrade = trade(1, 1_700_000_010, 1_700_000_040);
        signalTrade.exitReason = "signal";
        const evaluated = evaluateSecondMarketBacktest({
            result: result([signalTrade]),
            context: context([
                quote(1_700_000_010, 0.62, 0.60),
                quote(1_700_000_020, 0.50, 0.48),
                quote(1_700_000_040, 0.60, 0.58),
            ]),
            polymarketExitMode: "signal_exit_same_event",
            limitEntry: {
                enabled: true,
                priceCents: 50,
            },
        });

        expect(evaluated.polymarketSummary.limitEntryEnabled).to.equal(true);
        expect(evaluated.polymarketSummary.limitEntryFilledTrades).to.equal(1);
        expect(evaluated.polymarketEval.limitEntryEnabled).to.equal(true);
        expect(evaluated.polymarketEval.limitEntryAttempts).to.equal(1);
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketEntrySource).to.equal("limit");
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketEntryStatus).to.equal("filled");
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketEntryFillTs).to.equal(1_700_000_020);
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketEntryLimitPrice).to.equal(0.50);
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketEntryPrice).to.equal(0.50);
    });

    it("marks missing exact CLOB quotes as unscored instead of forward filling", () => {
        const evaluated = evaluateSecondMarketBacktest({
            result: result([trade(1, 1_700_000_010, 1_700_000_020)]),
            context: context([
                quote(1_700_000_011, 0.55, 0.53),
                quote(1_700_000_020, 0.60, 0.58),
            ]),
        });

        expect(evaluated.polymarketSummary.scoredTrades).to.equal(0);
        expect(evaluated.polymarketSummary.missingPriceTrades).to.equal(1);
        expect(evaluated.polymarketEval.coverage).to.equal(0);
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketExitSource).to.equal("missing");
    });

    it("preserves the selected native outcome interval in summaries", () => {
        const baseOutcome = outcome();
        const evaluated = evaluateSecondMarketBacktest({
            result: result([trade(1, 1_700_000_010, 1_700_000_020)]),
            context: {
                symbol: "BTCUSDT",
                outcomeSymbol: "BTCUSDT",
                seriesId: "10192",
                outcomeInterval: "15m",
                outcomes: [{
                    ...baseOutcome,
                    series_id: "10192",
                    interval: "15m",
                    event_end_ts: 1_700_000_900,
                }],
                quotes: [
                    {
                        ...quote(1_700_000_010, 0.55, 0.53),
                        series_id: "10192",
                        outcome_interval: "15m",
                        event_end_ts: 1_700_000_900,
                    },
                ],
                gammaSnapshots: [],
            },
        });

        expect(evaluated.polymarketSummary.outcomeInterval).to.equal("15m");
    });

    it("does not annotate 1s CLOB results with signal-close execution", async () => {
        const base = result([trade(1, 1_700_000_010, 1_700_000_020)]);
        const annotated = await annotateBacktestResultWithSecondMarketClob({
            result: base,
            symbol: "BTCUSDT",
            interval: "1s",
            executionModel: "signal_close",
        });

        expect(annotated).to.equal(base);
        expect(annotated.polymarketTradeSummary).to.equal(undefined);
    });
});
