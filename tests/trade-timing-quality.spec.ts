import { expect } from "chai";
import { describe, it } from "node:test";
import type { Time } from "lightweight-charts";
import { computeTradeTimingQuality } from "../lib/trade-timing-quality";
import type { BacktestResult, OHLCVData, Trade } from "../lib/types/strategies";

function candle(index: number, high: number, low: number, close: number): OHLCVData {
    return {
        time: index as Time,
        open: close,
        high,
        low,
        close,
        volume: 1000,
    };
}

function makeResult(trades: Trade[]): BacktestResult {
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
        winningTrades: trades.filter((trade) => trade.pnl > 0).length,
        losingTrades: trades.filter((trade) => trade.pnl <= 0).length,
        avgWin: 0,
        avgLoss: 0,
        sharpeRatio: 0,
        equityCurve: [],
    };
}

function makeTrade(overrides: Partial<Trade>): Trade {
    return {
        id: 1,
        type: "long",
        entryTime: 1 as Time,
        entryPrice: 100,
        exitTime: 10 as Time,
        exitPrice: 108,
        pnl: 8,
        pnlPercent: 8,
        size: 1,
        exitReason: "signal",
        ...overrides,
    };
}

describe("trade timing quality", () => {
    it("scores favorable long entries and protective long exits", () => {
        const data = Array.from({ length: 40 }, (_, index) => {
            if (index <= 1) return candle(index, 100.5, 99.5, 100);
            if (index <= 10) return candle(index, 100 + index, 99.5, 100 + index);
            return candle(index, 108.5, 90 - ((index - 10) * 0.2), 108 - (index - 10));
        });
        const result = makeResult([makeTrade({})]);

        const quality = computeTradeTimingQuality(result, data);

        expect(quality.entryScore).to.be.greaterThan(70);
        expect(quality.exitScore).to.be.greaterThan(55);
        expect(quality.exit.captureScore).to.be.greaterThan(70);
        expect(quality.exit.averageGivebackPct).to.be.greaterThan(0);
    });

    it("normalizes short trade movement in the short direction", () => {
        const data = Array.from({ length: 40 }, (_, index) => {
            if (index <= 1) return candle(index, 100.5, 99.5, 100);
            if (index <= 10) return candle(index, 100.5, 100 - index, 100 - index);
            return candle(index, 90 + ((index - 10) * 0.5), 89.5, 90 + (index - 10));
        });
        const result = makeResult([
            makeTrade({
                type: "short",
                entryPrice: 100,
                exitPrice: 92,
                pnl: 8,
                pnlPercent: 8,
            }),
        ]);

        const quality = computeTradeTimingQuality(result, data);

        expect(quality.entryScore).to.be.greaterThan(70);
        expect(quality.exitScore).to.be.greaterThan(55);
    });

    it("uses end-of-data trades for entry quality but not exit quality", () => {
        const data = Array.from({ length: 40 }, (_, index) => candle(index, 100 + index, 99, 100 + index));
        const result = makeResult([
            makeTrade({
                exitReason: "end_of_data",
                exitTime: 39 as Time,
                exitPrice: 139,
            }),
        ]);

        const quality = computeTradeTimingQuality(result, data);

        expect(quality.entryScore).to.be.a("number");
        expect(quality.exitScore).to.equal(null);
        expect(quality.exit.captureSampleSize).to.equal(0);
    });

    it("returns null scores when no horizon samples are available", () => {
        const data = Array.from({ length: 5 }, (_, index) => candle(index, 101, 99, 100));
        const result = makeResult([makeTrade({ entryTime: 4 as Time, exitTime: 4 as Time })]);

        const quality = computeTradeTimingQuality(result, data);

        expect(quality.entryScore).to.equal(null);
        expect(quality.entry.horizons.every((horizon) => horizon.score === null)).to.equal(true);
    });

    it("shrinks tiny movement back toward neutral", () => {
        const data = Array.from({ length: 40 }, (_, index) => candle(index, 100 + index * 5, 99 + index * 5, 100 + index * 5));
        data[1] = candle(1, 100, 100, 100);
        data[2] = candle(2, 100.01, 100, 100.01);
        data[3] = candle(3, 100.01, 100, 100.01);
        data[4] = candle(4, 100.01, 100, 100.01);
        const result = makeResult([makeTrade({ exitTime: 4 as Time, exitPrice: 100.01, pnl: 0.01, pnlPercent: 0.01 })]);

        const quality = computeTradeTimingQuality(result, data);
        const horizon3 = quality.entry.horizons.find((horizon) => horizon.bars === 3);

        expect(horizon3?.score).to.be.lessThan(55);
        expect(horizon3?.movementConfidencePct).to.be.lessThan(5);
    });

    it("measures excursions from the entry or exit reference price", () => {
        const data = Array.from({ length: 12 }, (_, index) => candle(index, 100, 100, 100));
        data[2] = candle(2, 110, 90, 100);
        data[3] = candle(3, 110, 90, 100);

        const longQuality = computeTradeTimingQuality(
            makeResult([makeTrade({ entryTime: 1 as Time, exitTime: 2 as Time, exitPrice: 100 })]),
            data,
        );
        const longEntry = longQuality.entry.horizons.find((horizon) => horizon.bars === 3)!;
        const longExit = longQuality.exit.horizons.find((horizon) => horizon.bars === 3)!;
        expect(longEntry.avgMfePct).to.be.closeTo(10, 1e-9);
        expect(longEntry.avgMaePct).to.be.closeTo(10, 1e-9);
        expect(longExit.avgAvoidedAdversePct).to.be.closeTo(10, 1e-9);
        expect(longExit.avgMissedContinuationPct).to.be.closeTo(10, 1e-9);

        const shortQuality = computeTradeTimingQuality(
            makeResult([makeTrade({
                type: "short",
                entryTime: 1 as Time,
                exitTime: 4 as Time,
                exitPrice: 95,
                pnl: 5,
                pnlPercent: 5,
            })]),
            data,
        );
        expect(shortQuality.exit.captureScore).to.be.closeTo(50, 1e-9);
        expect(shortQuality.exit.averageGivebackPct).to.be.closeTo(5, 1e-9);
    });
});
