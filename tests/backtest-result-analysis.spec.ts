import { expect } from "chai";
import { describe, it } from "node:test";
import {
    buildExpectancyBreakdown,
} from "../lib/backtest-result-analysis";
import type { BacktestResult, Time, Trade } from "../lib/types/strategies";

function makeTrade(
    id: number,
    type: Trade["type"],
    pnl: number,
    marketEntryPrice?: number | null,
    options?: {
        entryTime?: number;
        priceRangePos?: number;
        volumeRatio?: number;
        rangeAtrMultiple?: number;
        polymarketIsWin?: boolean;
    }
): Trade {
    const isWin = pnl > 0;
    const polymarketIsWin = options?.polymarketIsWin ?? isWin;
    const prediction = type === "long" ? "yes" : "no";
    return {
        id,
        type,
        entryTime: (options?.entryTime ?? (1_700_000_000 + id * 300)) as Time,
        entryPrice: 100,
        exitTime: ((options?.entryTime ?? (1_700_000_000 + id * 300)) + 300) as Time,
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
                closeLocation: null,
                oppositeWickPercent: null,
                rangeAtrMultiple: options?.rangeAtrMultiple ?? null,
                momentumConsistency: null,
                breakQuality: null,
                entryQualityScore: null,
                volumeTrend: null,
                volumeBurst: null,
                volumePriceDivergence: null,
                volumeConsistency: null,
                tf60Perf: null,
                tf90Perf: null,
                tf120Perf: null,
                tf480Perf: null,
                tfConfluencePerf: null,
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
    } as unknown as Trade;
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
});
