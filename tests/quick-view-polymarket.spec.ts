import { expect } from "chai";
import { describe, it } from "node:test";
import {
    countDistinctPolymarketOutcomeRows,
    computePolymarketBestBaselineWinRate,
    getQuickViewDiagnosticSections,
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
});
