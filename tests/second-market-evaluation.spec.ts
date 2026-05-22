import { afterEach, describe, it } from "node:test";
import { expect } from "chai";
import {
    annotateBacktestResultWithSecondMarketClob,
    evaluateSecondMarketBacktest,
    isSecondMarketPolymarketSupported,
    isSecondMarketPolymarketScoringSupported,
    loadSecondMarketEvaluationContext,
    type SecondMarketEvaluationContext,
} from "../lib/second-market/evaluation";
import { resetLocalSqlitePolymarketApiAvailabilityForTests } from "../lib/local-sqlite-polymarket-api";
import type { PolymarketClob1sQuoteRow } from "../lib/second-market/types";
import type { BacktestResult, Trade } from "../lib/types/strategies";
import type { PolymarketOutcomeRow } from "../lib/types/polymarket-outcomes";

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
    resetLocalSqlitePolymarketApiAvailabilityForTests();
});

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
    it("supports futures-scoped Binance storage symbols on 1s CLOB runs", () => {
        expect(isSecondMarketPolymarketSupported("BINANCE-FUTURES:BTCUSDT", "1s")).to.equal(true);
        expect(isSecondMarketPolymarketScoringSupported({
            symbol: "BINANCE-FUTURES:BTCUSDT",
            interval: "1s",
            executionModel: "next_open",
        })).to.equal(true);
    });

    it("supports 1s CLOB scoring for signal-close, next-open, and next-close chart execution", () => {
        expect(isSecondMarketPolymarketScoringSupported({
            symbol: "BTCUSDT",
            interval: "1s",
            executionModel: "signal_close",
        })).to.equal(true);
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
            executionModel: "same_bar_open",
        })).to.equal(false);
    });

    it("can skip gamma snapshot loading for annotation-only context", async () => {
        let gammaRequests = 0;
        globalThis.fetch = (async (input) => {
            const url = new URL(String(input), "http://localhost");
            if (url.pathname === "/api/sqlite/status") {
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
            if (url.pathname === "/api/sqlite/load-polymarket-outcomes") {
                return new Response(JSON.stringify({ ok: true, rows: [outcome()] }), { status: 200 });
            }
            if (url.pathname === "/api/second-market/clob-quotes") {
                return new Response(JSON.stringify({
                    ok: true,
                    quotes: [quote(1_700_000_010, 0.55, 0.53)],
                    stats: { truncated: true, limit: 250000 },
                }), { status: 200 });
            }
            if (url.pathname === "/api/second-market/gamma-snapshots") {
                gammaRequests++;
                return new Response(JSON.stringify({ ok: true, gammaSnapshots: [] }), { status: 200 });
            }
            throw new Error(`Unexpected fetch ${url.pathname}`);
        }) as typeof fetch;

        const loaded = await loadSecondMarketEvaluationContext({
            symbol: "BTCUSDT",
            startTs: 1_700_000_000,
            endTs: 1_700_000_020,
            includeGammaSnapshots: false,
        });

        expect(loaded?.quotes).to.have.length(1);
        expect(loaded?.quoteStats?.truncated).to.equal(true);
        expect(gammaRequests).to.equal(0);
    });

    it("infers missing 1s resolve-hold outcomes from the final exact CLOB quote", async () => {
        globalThis.fetch = (async (input) => {
            const url = new URL(String(input), "http://localhost");
            if (url.pathname === "/api/sqlite/status") {
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
            if (url.pathname === "/api/sqlite/load-polymarket-outcomes") {
                return new Response(JSON.stringify({ ok: true, rows: [] }), { status: 200 });
            }
            if (url.pathname === "/api/second-market/clob-quotes") {
                return new Response(JSON.stringify({
                    ok: true,
                    quotes: [
                        quote(1_700_000_010, 0.55, 0.53),
                        quote(1_700_000_299, 0.99, 0.98),
                    ],
                }), { status: 200 });
            }
            throw new Error(`Unexpected fetch ${url.pathname}`);
        }) as typeof fetch;

        const loaded = await loadSecondMarketEvaluationContext({
            symbol: "BTCUSDT",
            startTs: 1_700_000_000,
            endTs: 1_700_000_300,
            includeGammaSnapshots: false,
        });

        expect(loaded?.outcomes[0]?.resolution_source).to.equal("second_market_clob_final_quote");

        const evaluated = evaluateSecondMarketBacktest({
            result: result([trade(1, 1_700_000_010, 1_700_000_020)]),
            context: loaded!,
            polymarketExitMode: "resolve_hold",
        });

        expect(evaluated.polymarketSummary.evaluationMode).to.equal("resolve_hold");
        expect(evaluated.polymarketSummary.scoredTrades).to.equal(1);
        expect(evaluated.polymarketSummary.netPnl).to.be.closeTo(0.45, 1e-9);
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketExitSource).to.equal("resolution");
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.isWin).to.equal(true);
    });

    it("does not infer a final outcome from an ambiguous latest final CLOB quote", async () => {
        globalThis.fetch = (async (input) => {
            const url = new URL(String(input), "http://localhost");
            if (url.pathname === "/api/sqlite/status") {
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
            if (url.pathname === "/api/sqlite/load-polymarket-outcomes") {
                return new Response(JSON.stringify({ ok: true, rows: [] }), { status: 200 });
            }
            if (url.pathname === "/api/second-market/clob-quotes") {
                return new Response(JSON.stringify({
                    ok: true,
                    quotes: [
                        quote(1_700_000_299, 0.99, 0.97),
                        quote(1_700_000_300, 0.51, 0.49),
                    ],
                }), { status: 200 });
            }
            throw new Error(`Unexpected fetch ${url.pathname}`);
        }) as typeof fetch;

        const loaded = await loadSecondMarketEvaluationContext({
            symbol: "BTCUSDT",
            startTs: 1_700_000_000,
            endTs: 1_700_000_300,
            includeGammaSnapshots: false,
        });

        expect(loaded?.outcomes[0]?.resolution_source).to.equal("second_market_clob_unresolved");

        const evaluated = evaluateSecondMarketBacktest({
            result: result([trade(1, 1_700_000_010, 1_700_000_020)]),
            context: loaded!,
            polymarketExitMode: "resolve_hold",
        });

        expect(evaluated.polymarketSummary.scoredTrades).to.equal(0);
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketExitSource).to.equal("missing");
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

    it("holds supported 1s CLOB trades to resolution when resolve-hold mode is selected", () => {
        const signalTrade = trade(1, 1_700_000_010, 1_700_000_020);
        signalTrade.exitReason = "signal";

        const evaluated = evaluateSecondMarketBacktest({
            result: result([signalTrade]),
            context: context([
                quote(1_700_000_010, 0.55, 0.53),
                quote(1_700_000_020, 0.60, 0.58),
            ]),
            polymarketExitMode: "resolve_hold",
        });

        expect(evaluated.polymarketSummary.evaluationMode).to.equal("resolve_hold");
        expect(evaluated.polymarketSummary.netPnl).to.be.closeTo(0.45, 1e-9);
        expect(evaluated.polymarketEval.evaluationMode).to.equal("resolve_hold");
        expect(evaluated.polymarketEval.breakEvenWinRate).to.equal(0.55);
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketExitSource).to.equal("resolution");
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketExitPrice).to.equal(1);
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.isWin).to.equal(true);
    });

    it("ignores Polymarket take-profit protection in 1s resolve-hold mode", () => {
        const downOutcome = outcome();
        downOutcome.resolved_outcome_up = 0;

        const evaluated = evaluateSecondMarketBacktest({
            result: result([trade(1, 1_700_000_010, 1_700_000_020)]),
            context: {
                ...context([
                    quote(1_700_000_010, 0.55, 0.53),
                    quote(1_700_000_020, 0.82, 0.80),
                ]),
                outcomes: [downOutcome],
            },
            polymarketExitMode: "resolve_hold",
            protection: {
                polymarketProtectionTakeProfitEnabled: true,
                polymarketProtectionTakeProfitCents: 20,
            },
        });

        expect(evaluated.polymarketSummary.evaluationMode).to.equal("resolve_hold");
        expect(evaluated.polymarketSummary.protectionTakeProfitEnabled).to.equal(undefined);
        expect(evaluated.polymarketSummary.protectionTakeProfitExitedTrades).to.equal(0);
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketExitSource).to.equal("resolution");
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketExitPrice).to.equal(0);
        expect(evaluated.polymarketSummary.netPnl).to.be.closeTo(-0.55, 1e-9);
    });

    it("keeps Polymarket stop-loss protection active in 1s resolve-hold mode", () => {
        const evaluated = evaluateSecondMarketBacktest({
            result: result([trade(1, 1_700_000_010, 1_700_000_020)]),
            context: context([
                quote(1_700_000_010, 0.55, 0.53),
                quote(1_700_000_020, 0.32, 0.30),
            ]),
            polymarketExitMode: "resolve_hold",
            protection: {
                polymarketProtectionStopLossEnabled: true,
                polymarketProtectionStopLossCents: 20,
            },
        });

        expect(evaluated.polymarketSummary.evaluationMode).to.equal("resolve_hold");
        expect(evaluated.polymarketSummary.protectionStopLossEnabled).to.equal(true);
        expect(evaluated.polymarketSummary.protectionStopLossExitedTrades).to.equal(1);
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketExitSource).to.equal("protection_stop_loss");
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketExitPrice).to.equal(0.30);
        expect(evaluated.polymarketSummary.netPnl).to.be.closeTo(-0.25, 1e-9);
    });

    it("applies backtest-only Polymarket slippage against quote entry and signal exit fills", () => {
        const signalTrade = trade(1, 1_700_000_010, 1_700_000_020);
        signalTrade.exitReason = "signal";

        const evaluated = evaluateSecondMarketBacktest({
            result: result([signalTrade]),
            context: context([
                quote(1_700_000_010, 0.55, 0.53),
                quote(1_700_000_020, 0.60, 0.58),
            ]),
            polymarketExitMode: "signal_exit_same_event",
            backtestSlippageCents: 5,
        });

        expect(evaluated.summary.backtestSlippageCents).to.equal(5);
        expect(evaluated.polymarketSummary.backtestSlippageCents).to.equal(5);
        expect(evaluated.polymarketEval.backtestSlippageCents).to.equal(5);
        expect(evaluated.tradeResults[0]?.entryPrice).to.equal(0.60);
        expect(evaluated.tradeResults[0]?.exitPrice).to.equal(0.53);
        expect(evaluated.polymarketSummary.netPnl).to.be.closeTo(-0.07, 1e-9);
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketEntryPrice).to.equal(0.60);
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketExitPrice).to.equal(0.53);
    });

    it("prices close-based 1s executions at the candle close second", () => {
        for (const executionModel of ["signal_close", "next_close"] as const) {
            const signalTrade = trade(1, 1_700_000_010, 1_700_000_020);
            signalTrade.exitReason = "signal";

            const evaluated = evaluateSecondMarketBacktest({
                result: result([signalTrade]),
                context: context([
                    quote(1_700_000_010, 0.20, 0.18),
                    quote(1_700_000_011, 0.55, 0.53),
                    quote(1_700_000_020, 0.30, 0.28),
                    quote(1_700_000_021, 0.60, 0.58),
                ]),
                executionModel,
                polymarketExitMode: "signal_exit_same_event",
            });

            expect(evaluated.tradeResults[0]?.entryQuoteTs).to.equal(1_700_000_011);
            expect(evaluated.tradeResults[0]?.exitQuoteTs).to.equal(1_700_000_021);
            expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketEntryFillTs).to.equal(1_700_000_011);
            expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketEntryPrice).to.equal(0.55);
            expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketExitPrice).to.equal(0.58);
            expect(evaluated.polymarketSummary.netPnl).to.be.closeTo(0.03, 1e-9);
        }
    });

    it("delays 1s CLOB entry pricing without moving the chart trade", () => {
        const evaluated = evaluateSecondMarketBacktest({
            result: result([trade(1, 1_700_000_010, 1_700_000_020)]),
            context: context([
                quote(1_700_000_010, 0.20, 0.18),
                quote(1_700_000_013, 0.70, 0.68),
            ]),
            entryDelayBars: 3,
        });

        expect(evaluated.summary.entryDelayBars).to.equal(3);
        expect(evaluated.polymarketSummary.entryDelayBars).to.equal(3);
        expect(evaluated.polymarketEval.entryDelayBars).to.equal(3);
        expect(evaluated.tradeResults[0]?.trade.entryTime).to.equal(1_700_000_010);
        expect(evaluated.tradeResults[0]?.entryQuoteTs).to.equal(1_700_000_013);
        expect(evaluated.annotatedTrades[0]?.entryTime).to.equal(1_700_000_010);
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketEntryFillTs).to.equal(1_700_000_013);
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketEntryPrice).to.equal(0.70);
        expect(evaluated.polymarketSummary.netPnl).to.be.closeTo(0.30, 1e-9);
    });

    it("adds the entry delay after close-based 1s execution alignment", () => {
        const evaluated = evaluateSecondMarketBacktest({
            result: result([trade(1, 1_700_000_010, 1_700_000_020)]),
            context: context([
                quote(1_700_000_011, 0.40, 0.38),
                quote(1_700_000_014, 0.65, 0.63),
            ]),
            executionModel: "signal_close",
            entryDelayBars: 3,
        });

        expect(evaluated.tradeResults[0]?.entryQuoteTs).to.equal(1_700_000_014);
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketEntryFillTs).to.equal(1_700_000_014);
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketEntryPrice).to.equal(0.65);
    });

    it("marks delayed entries after the signal exit as unscored", () => {
        const signalTrade = trade(1, 1_700_000_010, 1_700_000_012);
        signalTrade.exitReason = "signal";

        const evaluated = evaluateSecondMarketBacktest({
            result: result([signalTrade]),
            context: context([
                quote(1_700_000_013, 0.55, 0.53),
            ]),
            polymarketExitMode: "signal_exit_same_event",
            entryDelayBars: 3,
        });

        expect(evaluated.polymarketSummary.scoredTrades).to.equal(0);
        expect(evaluated.polymarketSummary.entryTimeFilteredTrades).to.equal(1);
        expect(evaluated.polymarketEval.scoredPredictions).to.equal(0);
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketExitSource).to.equal("entry_time_filtered");
    });

    it("marks delayed entries outside the original Polymarket event as unscored", () => {
        const evaluated = evaluateSecondMarketBacktest({
            result: result([trade(1, 1_700_000_298, 1_700_000_299)]),
            context: context([
                quote(1_700_000_301, 0.55, 0.53),
            ]),
            entryDelayBars: 3,
        });

        expect(evaluated.polymarketSummary.scoredTrades).to.equal(0);
        expect(evaluated.polymarketSummary.entryTimeFilteredTrades).to.equal(1);
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketExitSource).to.equal("entry_time_filtered");
    });

    it("keeps delayed entries missing when the exact delayed CLOB quote is absent", () => {
        const evaluated = evaluateSecondMarketBacktest({
            result: result([trade(1, 1_700_000_010, 1_700_000_020)]),
            context: context([
                quote(1_700_000_014, 0.55, 0.53),
            ]),
            entryDelayBars: 3,
        });

        expect(evaluated.polymarketSummary.scoredTrades).to.equal(0);
        expect(evaluated.polymarketSummary.missingPriceTrades).to.equal(1);
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketExitSource).to.equal("missing");
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

    it("uses the original signal quote as a stale delayed limit for 1s CLOB entries", () => {
        const signalTrade = trade(1, 1_700_000_010, 1_700_000_040);
        signalTrade.exitReason = "signal";

        const evaluated = evaluateSecondMarketBacktest({
            result: result([signalTrade]),
            context: context([
                quote(1_700_000_010, 0.50, 0.48),
                quote(1_700_000_013, 0.70, 0.68),
                quote(1_700_000_020, 0.49, 0.47),
                quote(1_700_000_040, 0.62, 0.60),
            ]),
            polymarketExitMode: "signal_exit_same_event",
            entryDelayBars: 3,
            limitEntry: {
                enabled: true,
                priceCents: 50,
                priceMode: "stale_signal_price",
            },
        });

        expect(evaluated.polymarketSummary.limitEntryMode).to.equal("stale_signal_price");
        expect(evaluated.polymarketSummary.limitEntryFilledTrades).to.equal(1);
        expect(evaluated.polymarketSummary.avgLimitEntryWaitSec).to.equal(10);
        expect(evaluated.tradeResults[0]?.entryLimitPrice).to.equal(0.50);
        expect(evaluated.tradeResults[0]?.entryQuoteTs).to.equal(1_700_000_020);
        expect(evaluated.tradeResults[0]?.entryPrice).to.equal(0.50);
        expect(evaluated.tradeResults[0]?.exitPrice).to.equal(0.60);
        expect(evaluated.polymarketSummary.netPnl).to.be.closeTo(0.10, 1e-9);
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketEntrySource).to.equal("limit");
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketEntryStatus).to.equal("filled");
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketEntryFillTs).to.equal(1_700_000_020);
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketEntryLimitPrice).to.equal(0.50);
    });

    it("marks stale delayed limit entries as missed when the old signal price is never reachable", () => {
        const signalTrade = trade(1, 1_700_000_010, 1_700_000_040);
        signalTrade.exitReason = "signal";

        const evaluated = evaluateSecondMarketBacktest({
            result: result([signalTrade]),
            context: context([
                quote(1_700_000_010, 0.50, 0.48),
                quote(1_700_000_013, 0.70, 0.68),
                quote(1_700_000_020, 0.69, 0.67),
                quote(1_700_000_040, 0.80, 0.78),
            ]),
            polymarketExitMode: "signal_exit_same_event",
            entryDelayBars: 3,
            limitEntry: {
                enabled: true,
                priceCents: 50,
                priceMode: "stale_signal_price",
            },
        });

        expect(evaluated.polymarketSummary.scoredTrades).to.equal(0);
        expect(evaluated.polymarketSummary.limitEntryAttempts).to.equal(1);
        expect(evaluated.polymarketSummary.limitEntryFilledTrades).to.equal(0);
        expect(evaluated.polymarketSummary.limitEntryMissedTrades).to.equal(1);
        expect(evaluated.polymarketSummary.limitEntryNotTouchedTrades).to.equal(1);
        expect(evaluated.tradeResults[0]?.entryStatus).to.equal("not_touched");
        expect(evaluated.tradeResults[0]?.entryLimitPrice).to.equal(0.50);
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketEntryStatus).to.equal("not_touched");
        expect(evaluated.annotatedTrades[0]?.polymarketOutcome?.marketEntryPrice).to.equal(null);
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

    it("does not annotate unsupported 1s symbols with CLOB scoring", async () => {
        const base = result([trade(1, 1_700_000_010, 1_700_000_020)]);
        const annotated = await annotateBacktestResultWithSecondMarketClob({
            result: base,
            symbol: "ETHUSDT",
            interval: "1s",
            executionModel: "signal_close",
        });

        expect(annotated).to.equal(base);
        expect(annotated.polymarketTradeSummary).to.equal(undefined);
    });
});
