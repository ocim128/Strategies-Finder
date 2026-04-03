import { expect } from "chai";
import { describe, it } from "node:test";
import {
    countDistinctPolymarketOutcomeRows,
    computePolymarketBestBaselineWinRate,
    getQuickViewDiagnosticSections,
    quickViewManager,
    summarizePolymarketExecutionGap,
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

        expect(sections.map((section) => section.id)).to.deep.equal(["session_minute", "price_range_position"]);
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

    it("renders the snapshot profile section from cached result fields", () => {
        const html = (quickViewManager as any).buildPolymarketSnapshotSection({
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
            polymarketSnapshotProfile: {
                winSampleSize: 7,
                loseSampleSize: 5,
                rows: [{
                    key: "rsi",
                    label: "RSI",
                    winAvg: 62,
                    loseAvg: 48,
                    allAvg: 56,
                    delta: 14,
                    significance: 0.9,
                }],
            },
        } satisfies BacktestResult);

        expect(html).to.contain("PM Snapshot Profile");
        expect(html).to.contain("RSI");
        expect(html).to.contain("7 wins, 5 losses");
    });

    it("renders filter suggestions from cached result fields with actionable setting keys", () => {
        const html = (quickViewManager as any).buildPolymarketFilterSection({
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
            polymarketFilterSuggestions: {
                baselineWinRate: 0.48,
                baselineExpectancy: -0.03,
                scoredWinRate: 0.5,
                scoredBestBaselineWinRate: 0.38,
                scoredBaselineDelta: 0.12,
                sampleCounts: {
                    scoredTrades: 14,
                    pricedTrades: 12,
                },
                featureAnalyses: [{
                    feature: "rsi",
                    label: "RSI (14)",
                    winStats: { mean: 60, median: 60, stddev: 5, count: 6 },
                    lossStats: { mean: 45, median: 45, stddev: 5, count: 6 },
                    separationScore: 0.95,
                    suggestedFilter: { direction: "above", threshold: 55.5 },
                    winRateIfFiltered: 61.2,
                    expectancyIfFiltered: 0.03,
                    tradesRemovedPercent: 25,
                    scoredProjection: {
                        originalTrades: 14,
                        filteredTrades: 10,
                        removedPercent: 28.5714285714,
                        filteredWinRate: 0.6,
                        bestBaselineWinRate: 0.45,
                        baselineDelta: 0.15,
                    },
                }, {
                    feature: "volumeRatio",
                    label: "Volume Ratio",
                    winStats: { mean: 1.8, median: 1.8, stddev: 0.2, count: 6 },
                    lossStats: { mean: 0.8, median: 0.8, stddev: 0.2, count: 6 },
                    separationScore: 0.4,
                    suggestedFilter: { direction: "above", threshold: 1.25 },
                    winRateIfFiltered: 66.7,
                    expectancyIfFiltered: 0.08,
                    tradesRemovedPercent: 18,
                    scoredProjection: {
                        originalTrades: 14,
                        filteredTrades: 11,
                        removedPercent: 21.4285714286,
                        filteredWinRate: 0.698,
                        bestBaselineWinRate: 0.568,
                        baselineDelta: 0.13,
                    },
                }],
                finderResult: {
                    featureRanges: [],
                    attemptedCount: 4,
                    feasibleCount: 1,
                    rejectedByConstraints: 3,
                    bestCandidate: null,
                    topCandidates: [],
                },
            },
        } satisfies BacktestResult);

        expect(html).to.contain("PM Filter Suggestions");
        expect(html).to.contain("snapshotRsiMin = 55.500");
        expect(html).to.contain("snapshotVolumeRatioMin = 1.250");
        expect(html).to.contain("Current scored baseline delta: +12.0pp");
        expect(html).to.contain("69.8%");
        expect(html).to.contain("Base Delta");
        expect(html).to.contain("+13.0pp");
        expect(html.indexOf("Volume Ratio")).to.be.lessThan(html.indexOf("RSI (14)"));
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
});
