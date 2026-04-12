import { expect } from "chai";
import { describe, it } from "node:test";
import {
    countDistinctPolymarketOutcomeRows,
    computePolymarketBestBaselineWinRate,
    getQuickViewDiagnosticSections,
    quickViewManager,
    summarizePolymarketExecutionGap,
    summarizePolymarketExpectancyAfterTakeProfit,
    summarizePolymarketExitReasonWinRates,
    summarizePolymarketPayoutDiagnostics,
    summarizePolymarketStreaks,
    summarizeRecentPolymarketForm,
} from "../lib/quick-view";
import type { BacktestResult, Trade } from "../lib/strategies/index";

function makeTrade(id: number, isWin: boolean | null, overrides: Partial<Trade> = {}): Trade {
    return {
        id,
        type: "long",
        entryTime: 1_700_000_000 + id * 300,
        entryPrice: 30_000,
        exitTime: 1_700_000_300 + id * 300,
        exitPrice: 30_100,
        pnl: isWin === false ? -10 : 10,
        pnlPercent: isWin === false ? -0.3 : 0.3,
        size: 1,
        exitReason: "signal",
        polymarketOutcome: isWin === null ? null : {
            eventStartTs: 1_700_000_000 + id * 300,
            eventEndTs: 1_700_000_300 + id * 300,
            eventSlug: `event-${id}`,
            marketSlug: `market-${id}`,
            prediction: "yes",
            actualOutcomeUp: isWin ? 1 : 0,
            isWin,
            marketEntryPrice: 0.5,
        },
        ...overrides,
    };
}

describe("Quick View Polymarket streak summary", () => {
    it("counts longest win and loss streaks and breaks on missing outcomes", () => {
        const trades = [
            makeTrade(1, true),
            makeTrade(2, true),
            makeTrade(3, false),
            makeTrade(4, false),
            makeTrade(5, false),
            makeTrade(6, null),
            makeTrade(7, true),
            makeTrade(8, true),
            makeTrade(9, true),
            makeTrade(10, false),
        ];

        const summary = summarizePolymarketStreaks(trades);

        expect(summary.longestWinStreak).to.equal(3);
        expect(summary.longestLossStreak).to.equal(3);
    });

    it("summarizes recent form from the latest scored trades only", () => {
        const trades = [
            makeTrade(1, true),
            makeTrade(2, null),
            makeTrade(3, false),
            makeTrade(4, true),
            makeTrade(5, true),
            makeTrade(6, false),
        ];

        const summary = summarizeRecentPolymarketForm(trades, 4);

        expect(summary.recentFormTrades).to.equal(4);
        expect(summary.recentFormWins).to.equal(2);
        expect(summary.recentFormLosses).to.equal(2);
        expect(summary.recentFormWinRate).to.equal(0.5);
    });

    it("summarizes entry win rate by the previous closed trade exit reason", () => {
        const summary = summarizePolymarketExitReasonWinRates([
            makeTrade(1, true, { exitReason: "time_stop" }),
            makeTrade(2, false, { exitReason: "take_profit" }),
            makeTrade(3, true, { exitReason: "signal" }),
            makeTrade(4, false, { exitReason: "time_stop" }),
            makeTrade(5, true, { exitReason: "time_stop" }),
            makeTrade(6, null, { exitReason: "signal" }),
            makeTrade(7, true, { exitReason: "end_of_data" }),
        ]);

        expect(summary.maxHold.trades).to.equal(2);
        expect(summary.maxHold.wins).to.equal(1);
        expect(summary.maxHold.losses).to.equal(1);
        expect(summary.maxHold.winRate).to.equal(0.5);

        expect(summary.takeProfit.trades).to.equal(1);
        expect(summary.takeProfit.wins).to.equal(1);
        expect(summary.takeProfit.losses).to.equal(0);
        expect(summary.takeProfit.winRate).to.equal(1);

        expect(summary.signal.trades).to.equal(2);
        expect(summary.signal.wins).to.equal(1);
        expect(summary.signal.losses).to.equal(1);
        expect(summary.signal.winRate).to.equal(0.5);
    });

    it("summarizes entry expectancy after the previous trade exited by tp", () => {
        const summary = summarizePolymarketExpectancyAfterTakeProfit([
            makeTrade(1, true, {
                exitReason: "take_profit",
                polymarketOutcome: {
                    ...makeTrade(1, true).polymarketOutcome!,
                    marketEntryPrice: 0.45,
                },
            }),
            makeTrade(2, true, {
                exitReason: "signal",
                polymarketOutcome: {
                    ...makeTrade(2, true).polymarketOutcome!,
                    marketEntryPrice: 0.30,
                },
            }),
            makeTrade(3, false, {
                exitReason: "take_profit",
                polymarketOutcome: {
                    ...makeTrade(3, false).polymarketOutcome!,
                    marketEntryPrice: 0.60,
                },
            }),
            makeTrade(4, false, {
                exitReason: "signal",
                polymarketOutcome: {
                    ...makeTrade(4, false).polymarketOutcome!,
                    marketEntryPrice: 0.70,
                },
            }),
            makeTrade(5, true, {
                exitReason: "signal",
                polymarketOutcome: {
                    ...makeTrade(5, true).polymarketOutcome!,
                    marketEntryPrice: null,
                },
            }),
        ]);

        expect(summary.pricedTrades).to.equal(2);
        expect(summary.expectancy).to.be.closeTo(0, 1e-12);
    });

    it("computes the best naive baseline from scored trade outcomes", () => {
        const trades = [
            makeTrade(1, true),
            makeTrade(2, true),
            makeTrade(3, false),
            makeTrade(4, true),
            makeTrade(5, null),
        ];

        const baseline = computePolymarketBestBaselineWinRate(trades);

        expect(baseline).to.equal(0.75);
    });

    it("computes best win streak on the last 100 trades slice", () => {
        const trades: Trade[] = [];
        for (let i = 1; i <= 110; i++) {
            trades.push(makeTrade(i, i <= 10 ? true : false));
        }
        for (let i = 106; i <= 110; i++) {
            trades[i - 1] = makeTrade(i, true);
        }

        const summary = summarizePolymarketStreaks(trades.slice(-100));

        expect(summary.longestWinStreak).to.equal(5);
    });

    it("counts distinct annotated outcome rows instead of defaulting to zero", () => {
        const trades = [
            makeTrade(1, true),
            makeTrade(2, false),
            {
                ...makeTrade(3, true),
                polymarketOutcome: {
                    ...makeTrade(1, true).polymarketOutcome!,
                    isWin: true,
                },
            },
            makeTrade(4, null),
        ];

        expect(countDistinctPolymarketOutcomeRows(trades)).to.equal(2);
    });

    it("keeps only execution diagnostics in Quick View", () => {
        const result = {
            trades: [],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
            expectancyBreakdown: {
                sections: [
                    { id: "side", title: "By Side", hint: "", rows: [] },
                    { id: "session_minute", title: "By 5m Session Minute", hint: "", rows: [] },
                    { id: "price_range_position", title: "By Entry Range Position", hint: "", rows: [] },
                ],
            },
        } satisfies BacktestResult;

        expect(getQuickViewDiagnosticSections(result).map((section) => section.id)).to.deep.equal([
            "session_minute",
            "price_range_position",
        ]);
    });

    it("summarizes polymarket payout expectancy from entry prices", () => {
        const summary = summarizePolymarketPayoutDiagnostics([
            makeTrade(1, true, {
                polymarketOutcome: {
                    ...makeTrade(1, true).polymarketOutcome!,
                    marketEntryPrice: 0.4,
                },
            }),
            makeTrade(2, false, {
                polymarketOutcome: {
                    ...makeTrade(2, false).polymarketOutcome!,
                    marketEntryPrice: 0.6,
                },
            }),
        ]);

        expect(summary).to.not.equal(null);
        expect(summary?.pricedTrades).to.equal(2);
        expect(summary?.unpricedScoredTrades).to.equal(0);
        expect(summary?.avgEntryPrice).to.equal(0.5);
        expect(summary?.breakEvenWinRate).to.equal(0.5);
        expect(summary?.winRate).to.equal(0.5);
        expect(summary?.expectancy).to.equal(0);
        expect(summary?.profitFactor).to.equal(1);
        expect(summary?.edgeVsBreakEven).to.equal(0);
    });

    it("keeps unpriced scored trades out of payout maths but reports the exclusion", () => {
        const summary = summarizePolymarketPayoutDiagnostics([
            makeTrade(1, true, {
                polymarketOutcome: {
                    ...makeTrade(1, true).polymarketOutcome!,
                    marketEntryPrice: 0.4,
                },
            }),
            makeTrade(2, false, {
                polymarketOutcome: {
                    ...makeTrade(2, false).polymarketOutcome!,
                    marketEntryPrice: null,
                },
            }),
        ]);

        expect(summary).to.not.equal(null);
        expect(summary?.pricedTrades).to.equal(1);
        expect(summary?.unpricedScoredTrades).to.equal(1);
        expect(summary?.winRate).to.equal(1);
        expect(summary?.expectancy).to.equal(0.6);
        expect(summary?.profitFactor).to.equal(Infinity);
    });

    it("keeps short NO entries at the paid NO price in payout summaries", () => {
        const summary = summarizePolymarketPayoutDiagnostics([
            makeTrade(1, true, {
                type: "short",
                polymarketOutcome: {
                    eventStartTs: 1_700_000_300,
                    eventEndTs: 1_700_000_600,
                    eventSlug: "event-1",
                    marketSlug: "market-1",
                    prediction: "no",
                    actualOutcomeUp: 0,
                    isWin: true,
                    marketEntryPrice: 0.9,
                },
            }),
        ]);

        expect(summary).to.not.equal(null);
        expect(summary?.pricedTrades).to.equal(1);
        expect(summary?.avgEntryPrice).to.equal(0.9);
        expect(summary?.breakEvenWinRate).to.equal(0.9);
        expect(summary?.winRate).to.equal(1);
        expect(summary?.expectancy).to.be.closeTo(0.1, 1e-12);
        expect(summary?.profitFactor).to.equal(Infinity);
        expect(summary?.edgeVsBreakEven).to.be.closeTo(0.1, 1e-12);
    });

    it("builds quick view sections from polymarket payout instead of binance pnl when priced trades exist", () => {
        const result = {
            trades: [
                makeTrade(1, true, {
                    entryTime: 1_699_999_800,
                    pnl: -100,
                    polymarketOutcome: {
                        ...makeTrade(1, true).polymarketOutcome!,
                        marketEntryPrice: 0.4,
                    },
                    entrySnapshot: { priceRangePos: 0.9 },
                }),
                makeTrade(2, false, {
                    entryTime: 1_699_999_860,
                    pnl: 100,
                    polymarketOutcome: {
                        ...makeTrade(2, false).polymarketOutcome!,
                        marketEntryPrice: 0.2,
                    },
                    entrySnapshot: { priceRangePos: 0.1 },
                }),
            ],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 2,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
            expectancyBreakdown: {
                sections: [
                    { id: "session_minute", title: "By 5m Session Minute", hint: "", rows: [] },
                    { id: "price_range_position", title: "By Entry Range Position", hint: "", rows: [] },
                ],
            },
        } satisfies BacktestResult;

        const sections = getQuickViewDiagnosticSections(result);
        const minute0 = sections[0]?.rows.find((row) => row.label === "Minute 0");
        const minute1 = sections[0]?.rows.find((row) => row.label === "Minute 1");

        expect(sections.map((section) => section.id)).to.deep.equal(["session_minute"]);
        expect(minute0?.expectancy).to.equal(0.6);
        expect(minute1?.expectancy).to.equal(-0.2);
    });

    it("labels native 5m runs as observed minute buckets instead of selected offsets", () => {
        const result = {
            trades: [
                makeTrade(1, true, {
                    entryTime: 1_700_000_000,
                    polymarketOutcome: {
                        ...makeTrade(1, true).polymarketOutcome!,
                        marketEntryPrice: 0.45,
                    },
                }),
            ],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 1,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
            expectancyBreakdown: {
                sections: [
                    { id: "session_minute", title: "By 5m Session Minute", hint: "", rows: [] },
                    { id: "price_range_position", title: "By Entry Range Position", hint: "", rows: [] },
                ],
            },
            polymarketTradeSummary: {
                seriesId: "btc-5m",
                outcomeRowsLoaded: 1,
                scoredTrades: 1,
                missingOutcomeTrades: 0,
                unscoredTrades: 0,
            },
        } satisfies BacktestResult;

        const [minuteSection] = getQuickViewDiagnosticSections(result);

        expect(minuteSection?.title).to.equal("Observed 5m Session Minute");
        expect(minuteSection?.hint).to.contain("native 5m chart");
    });

    it("compares polymarket payout against realized binance execution", () => {
        const summary = summarizePolymarketExecutionGap([
            makeTrade(1, true, {
                pnl: 5,
                polymarketOutcome: {
                    ...makeTrade(1, true).polymarketOutcome!,
                    marketEntryPrice: 0.4,
                },
            }),
            makeTrade(2, true, {
                pnl: -3,
                polymarketOutcome: {
                    ...makeTrade(2, true).polymarketOutcome!,
                    marketEntryPrice: 0.7,
                },
            }),
            makeTrade(3, false, {
                pnl: -4,
                polymarketOutcome: {
                    ...makeTrade(3, false).polymarketOutcome!,
                    marketEntryPrice: 0.2,
                },
            }),
            makeTrade(4, null, { pnl: 9 }),
        ]);

        expect(summary).to.not.equal(null);
        expect(summary?.pricedTrades).to.equal(3);
        expect(summary?.unpricedScoredTrades).to.equal(0);
        expect(summary?.polymarketWinRate).to.be.closeTo(2 / 3, 1e-12);
        expect(summary?.avgEntryPrice).to.be.closeTo((0.4 + 0.7 + 0.2) / 3, 1e-12);
        expect(summary?.breakEvenWinRate).to.be.closeTo((0.4 + 0.7 + 0.2) / 3, 1e-12);
        expect(summary?.polymarketExpectancy).to.be.closeTo(0.7 / 3, 1e-12);
        expect(summary?.realizedWinRate).to.equal(1 / 3);
        expect(summary?.realizedExpectancy).to.equal(-2 / 3);
    });

    it("keeps unpriced scored trades out of the execution-gap subset but reports them", () => {
        const summary = summarizePolymarketExecutionGap([
            makeTrade(1, true, {
                pnl: 5,
                polymarketOutcome: {
                    ...makeTrade(1, true).polymarketOutcome!,
                    marketEntryPrice: 0.4,
                },
            }),
            makeTrade(2, false, {
                pnl: -9,
                polymarketOutcome: {
                    ...makeTrade(2, false).polymarketOutcome!,
                    marketEntryPrice: null,
                },
            }),
        ]);

        expect(summary).to.not.equal(null);
        expect(summary?.pricedTrades).to.equal(1);
        expect(summary?.unpricedScoredTrades).to.equal(1);
        expect(summary?.polymarketWinRate).to.equal(1);
        expect(summary?.realizedWinRate).to.equal(1);
        expect(summary?.realizedExpectancy).to.equal(5);
    });

    it("renders a Quick View handoff to the Polymarket tab instead of selected offset n/a", () => {
        const html = (quickViewManager as any).buildPolymarketSection({
            trades: [
                makeTrade(1, true, {
                    polymarketOutcome: {
                        ...makeTrade(1, true).polymarketOutcome!,
                        marketEntryPrice: 0.48,
                    },
                }),
            ],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 1,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
            polymarketTradeSummary: {
                seriesId: "btc-5m",
                outcomeRowsLoaded: 1,
                scoredTrades: 1,
                missingOutcomeTrades: 0,
                unscoredTrades: 0,
            },
        } satisfies BacktestResult);

        expect(html).to.contain("Run Mode: Native 5m scoring");
        expect(html).to.contain("Polymarket tab");
        expect(html).to.not.contain("Selected Offset: n/a");
    });

    it("renders the new quick-view polymarket summary cards", () => {
        const html = (quickViewManager as any).buildPolymarketSection({
            trades: [
                makeTrade(1, true, {
                    exitReason: "signal",
                    polymarketOutcome: {
                        ...makeTrade(1, true).polymarketOutcome!,
                        marketEntryPrice: 0.3,
                    },
                }),
                makeTrade(2, true, {
                    exitReason: "take_profit",
                    polymarketOutcome: {
                        ...makeTrade(2, true).polymarketOutcome!,
                        marketEntryPrice: 0.3,
                    },
                }),
                makeTrade(3, false, {
                    exitReason: "time_stop",
                    polymarketOutcome: {
                        ...makeTrade(3, false).polymarketOutcome!,
                        marketEntryPrice: 0.6,
                    },
                }),
                makeTrade(4, true, {
                    exitReason: "time_stop",
                    polymarketOutcome: {
                        ...makeTrade(4, true).polymarketOutcome!,
                        marketEntryPrice: 0.4,
                    },
                }),
                makeTrade(5, false, {
                    exitReason: "signal",
                    polymarketOutcome: {
                        ...makeTrade(5, false).polymarketOutcome!,
                        marketEntryPrice: 0.4,
                    },
                }),
            ],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 4,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
            polymarketTradeSummary: {
                seriesId: "btc-5m",
                outcomeRowsLoaded: 5,
                scoredTrades: 5,
                missingOutcomeTrades: 0,
                unscoredTrades: 0,
            },
        } satisfies BacktestResult);

        expect(html).to.contain("Poly Exp / Trade");
        expect(html).to.contain("+20.0c");
        expect(html).to.contain("Poly Profit Factor");
        expect(html).to.contain("2.00");
        expect(html).to.contain("Max Win Streak");
        expect(html).to.contain("Max Loss Streak");
        expect(html).to.contain("Last 50 W/L");
        expect(html).to.contain("3 win - 2 lose");
        expect(html).to.contain("Entry Win % | After Max Hold");
        expect(html).to.contain("50.0% | 2t");
        expect(html).to.contain("Entry Win % | After TP");
        expect(html).to.contain("0.0% | 1t");
        expect(html).to.contain("Entry Exp / Trade | After TP");
        expect(html).to.contain("-60.0c | 1t");
        expect(html).to.contain("Entry Win % | After Signal");
        expect(html).to.contain("100.0% | 1t");
    });

    it("renders signal-exit same-event summaries from stored polymarket pricing", () => {
        const html = (quickViewManager as any).buildPolymarketSection({
            trades: [
                makeTrade(1, true, {
                    polymarketOutcome: {
                        ...makeTrade(1, true).polymarketOutcome!,
                        evaluationMode: "signal_exit_same_event",
                        isProfitable: true,
                        marketEntryPrice: 0.42,
                        marketExitPrice: 0.60,
                        marketPnl: 0.18,
                        marketExitSource: "signal",
                    },
                }),
                makeTrade(2, false, {
                    polymarketOutcome: {
                        ...makeTrade(2, false).polymarketOutcome!,
                        evaluationMode: "signal_exit_same_event",
                        isProfitable: false,
                        marketEntryPrice: 0.58,
                        marketExitPrice: 0.48,
                        marketPnl: -0.10,
                        marketExitSource: "resolution",
                    },
                }),
            ],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 2,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
            polymarketTradeSummary: {
                seriesId: "btc-5m",
                outcomeRowsLoaded: 2,
                scoredTrades: 2,
                missingOutcomeTrades: 0,
                unscoredTrades: 0,
                evaluationMode: "signal_exit_same_event",
                profitableTrades: 1,
                losingTrades: 1,
                signalExitedTrades: 1,
                resolvedTrades: 1,
                expectancy: 0.04,
                profitFactor: 1.8,
            },
        } satisfies BacktestResult);

        expect(html).to.contain("Signal Exit (same event)");
        expect(html).to.contain("Poly Profitable");
        expect(html).to.contain("+4.0c");
        expect(html).to.contain("1.80");
        expect(html).to.contain("Signal Exited");
        expect(html).to.contain("Resolved (Held)");
    });

    it("does not render an empty signal-exit section when no trades were actually priced", () => {
        const html = (quickViewManager as any).buildPolymarketSection({
            trades: [
                makeTrade(1, null),
            ],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 1,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
            polymarketTradeSummary: {
                seriesId: "btc-5m",
                outcomeRowsLoaded: 1,
                scoredTrades: 0,
                missingOutcomeTrades: 0,
                unscoredTrades: 1,
                evaluationMode: "signal_exit_same_event",
                missingPriceTrades: 1,
            },
        } satisfies BacktestResult);

        expect(html).to.equal("");
    });
});
