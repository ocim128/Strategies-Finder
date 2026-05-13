import { describe, it } from "node:test";
import { expect } from "chai";
import { evaluateSecondMarketBacktest, type SecondMarketEvaluationContext } from "../lib/second-market/evaluation";
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
        outcomes: [outcome()],
        quotes,
    };
}

describe("second market shared evaluation", () => {
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
});
