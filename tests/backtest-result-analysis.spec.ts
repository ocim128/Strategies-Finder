import { expect } from "chai";
import { describe, it } from "node:test";
import {
    buildExpectancyBreakdown,
    buildPolymarketFilterSuggestions,
    buildPolymarketSnapshotProfile,
    enrichPolymarketBacktestResult,
} from "../lib/backtest-result-analysis";
import type { BacktestResult, Trade } from "../lib/types/strategies";

function makeTrade(
    id: number,
    type: Trade["type"],
    pnl: number,
    marketEntryPrice?: number | null,
    options?: {
        entryTime?: number;
        priceRangePos?: number;
        volumeRatio?: number;
        polymarketIsWin?: boolean;
    }
): Trade {
    const isWin = pnl > 0;
    const polymarketIsWin = options?.polymarketIsWin ?? isWin;
    const prediction = type === "long" ? "yes" : "no";
    return {
        id,
        type,
        entryTime: options?.entryTime ?? (1_700_000_000 + id * 300),
        entryPrice: 100,
        exitTime: (options?.entryTime ?? (1_700_000_000 + id * 300)) + 300,
        exitPrice: 100 + pnl,
        pnl,
        pnlPercent: pnl,
        size: 1,
        exitReason: "signal",
        entrySnapshot: options?.priceRangePos === undefined
            ? undefined
            : {
                rsi: null,
                adx: null,
                atrPercent: null,
                emaDistance: null,
                volumeRatio: options?.volumeRatio ?? null,
                priceRangePos: options.priceRangePos,
                barsFromHigh: null,
                barsFromLow: null,
                trendEfficiency: null,
                atrRegimeRatio: null,
                bodyPercent: null,
                wickSkew: null,
                volumeTrend: null,
                volumeBurst: null,
                volumePriceDivergence: null,
                volumeConsistency: null,
            },
        polymarketOutcome: marketEntryPrice === undefined
            ? undefined
            : {
                eventStartTs: 1_700_000_000 + id * 300,
                eventEndTs: 1_700_000_300 + id * 300,
                eventSlug: `event-${id}`,
                marketSlug: `market-${id}`,
                prediction,
                actualOutcomeUp: prediction === "yes"
                    ? (polymarketIsWin ? 1 : 0)
                    : (polymarketIsWin ? 0 : 1),
                isWin: polymarketIsWin,
                marketEntryPrice,
            },
    };
}

function makeResult(trades: Trade[]): BacktestResult {
    const netProfit = trades.reduce((sum, trade) => sum + trade.pnl, 0);
    const winningTrades = trades.filter((trade) => trade.pnl > 0).length;
    return {
        trades,
        netProfit,
        netProfitPercent: 0,
        winRate: trades.length > 0 ? (winningTrades / trades.length) * 100 : 0,
        expectancy: trades.length > 0 ? netProfit / trades.length : 0,
        avgTrade: trades.length > 0 ? netProfit / trades.length : 0,
        profitFactor: 0,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: trades.length,
        winningTrades,
        losingTrades: trades.length - winningTrades,
        avgWin: 0,
        avgLoss: 0,
        sharpeRatio: 0,
        equityCurve: [],
        marketContext: {
            symbol: "BTCUSDT",
            interval: "1m",
            candleCount: 100,
            firstCandleTime: null,
            lastCandleTime: null,
        },
    };
}

describe("backtest result expectancy breakdown", () => {
    it("shows side splits so high win-rate negative expectancy is visible", () => {
        const breakdown = buildExpectancyBreakdown(makeResult([
            makeTrade(1, "long", 10),
            makeTrade(2, "long", 10),
            makeTrade(3, "long", -30),
            makeTrade(4, "short", 5),
            makeTrade(5, "short", -2),
        ]));

        expect(breakdown?.sections.map((section) => section.id)).to.deep.equal(["side", "session_minute"]);

        const sideRows = breakdown?.sections[0]?.rows ?? [];
        expect(sideRows.map((row) => row.label)).to.deep.equal(["All Trades", "Long Only", "Short Only"]);

        expect(sideRows[0]?.winRate).to.equal(60);
        expect(sideRows[0]?.expectancy).to.equal(-1.4);
        expect(sideRows[1]?.winRate).to.be.closeTo(66.666, 0.01);
        expect(sideRows[1]?.expectancy).to.be.closeTo(-3.333, 0.01);
        expect(sideRows[2]?.expectancy).to.equal(1.5);
    });

    it("buckets 1m trades by minute inside the 5m session", () => {
        const baseFiveMinuteTs = 1_700_000_000 - (1_700_000_000 % 300);
        const breakdown = buildExpectancyBreakdown(makeResult([
            makeTrade(1, "long", 12, undefined, { entryTime: baseFiveMinuteTs + 0 * 60 }),
            makeTrade(2, "short", 8, undefined, { entryTime: baseFiveMinuteTs + 1 * 60 }),
            makeTrade(3, "long", 10, undefined, { entryTime: baseFiveMinuteTs + 1 * 60 + 300 }),
            makeTrade(4, "long", -40, undefined, { entryTime: baseFiveMinuteTs + 4 * 60 }),
        ]));

        const bucketSection = breakdown?.sections.find((section) => section.id === "session_minute");
        expect(bucketSection?.rows.map((row) => row.label)).to.deep.equal(["Minute 0", "Minute 1", "Minute 4"]);

        const minuteOne = bucketSection?.rows.find((row) => row.label === "Minute 1");
        expect(minuteOne?.tradeCount).to.equal(2);
        expect(minuteOne?.winRate).to.equal(100);
        expect(minuteOne?.expectancy).to.equal(9);

        const minuteFour = bucketSection?.rows.find((row) => row.label === "Minute 4");
        expect(minuteFour?.tradeCount).to.equal(1);
        expect(minuteFour?.winRate).to.equal(0);
        expect(minuteFour?.expectancy).to.equal(-40);
    });

    it("buckets trades by recent range position so late-chase behavior is visible", () => {
        const breakdown = buildExpectancyBreakdown(makeResult([
            makeTrade(1, "long", 12, undefined, { priceRangePos: 0.15 }),
            makeTrade(2, "short", 8, undefined, { priceRangePos: 0.35 }),
            makeTrade(3, "long", 10, undefined, { priceRangePos: 0.82 }),
            makeTrade(4, "long", -40, undefined, { priceRangePos: 0.91 }),
        ]));

        const rangeSection = breakdown?.sections.find((section) => section.id === "price_range_position");
        expect(rangeSection?.rows.map((row) => row.label)).to.deep.equal(["0-20%", "20-40%", "80-100%"]);

        const highBucket = rangeSection?.rows.find((row) => row.label === "80-100%");
        expect(highBucket?.tradeCount).to.equal(2);
        expect(highBucket?.winRate).to.equal(50);
        expect(highBucket?.expectancy).to.equal(-15);
    });

    it("builds a polymarket snapshot profile from scored trades with snapshots", () => {
        const trades = Array.from({ length: 12 }, (_, index) => {
            const isPmWin = index >= 6;
            return makeTrade(
                index + 1,
                "long",
                isPmWin ? 5 : -5,
                isPmWin ? 0.4 : 0.7,
                {
                    priceRangePos: isPmWin ? 0.2 : 0.85,
                    volumeRatio: isPmWin ? 1.8 : 0.7,
                }
            );
        });

        const profile = buildPolymarketSnapshotProfile(trades);
        const priceRangeRow = profile?.rows.find((row) => row.key === "priceRangePos");

        expect(profile).to.not.equal(undefined);
        expect(profile?.winSampleSize).to.equal(6);
        expect(profile?.loseSampleSize).to.equal(6);
        expect(priceRangeRow?.delta).to.be.lessThan(0);
        expect(priceRangeRow?.significance).to.be.greaterThan(0);
    });

    it("uses only priced polymarket trades for filter suggestions and reports sample counts", () => {
        const trades = [
            ...Array.from({ length: 10 }, (_, index) => {
                const isPmWin = index >= 5;
                return makeTrade(
                    index + 1,
                    "long",
                    isPmWin ? 4 : -4,
                    isPmWin ? 0.4 : 0.7,
                    {
                        priceRangePos: isPmWin ? 0.25 : 0.8,
                        volumeRatio: isPmWin ? 1.7 : 0.75,
                    }
                );
            }),
            makeTrade(99, "long", 3, null, {
                priceRangePos: 0.4,
                volumeRatio: 1.1,
                polymarketIsWin: true,
            }),
        ];

        const suggestions = buildPolymarketFilterSuggestions(trades);

        expect(suggestions).to.not.equal(undefined);
        expect(suggestions?.sampleCounts.scoredTrades).to.equal(11);
        expect(suggestions?.sampleCounts.pricedTrades).to.equal(10);
        expect(suggestions?.baselineExpectancy).to.be.closeTo(-0.05, 1e-12);
        expect(suggestions?.featureAnalyses.length).to.be.greaterThan(0);
    });

    it("enriches a backtest result with cached polymarket analysis fields", () => {
        const trades = Array.from({ length: 10 }, (_, index) => {
            const isPmWin = index >= 5;
            return makeTrade(
                index + 1,
                "long",
                isPmWin ? 5 : -5,
                isPmWin ? 0.42 : 0.68,
                {
                    priceRangePos: isPmWin ? 0.3 : 0.78,
                    volumeRatio: isPmWin ? 1.6 : 0.85,
                }
            );
        });

        const enriched = enrichPolymarketBacktestResult(makeResult(trades));

        expect(enriched.polymarketSnapshotProfile?.rows.length).to.be.greaterThan(0);
        expect(enriched.polymarketFilterSuggestions?.sampleCounts.pricedTrades).to.equal(10);
    });
});
