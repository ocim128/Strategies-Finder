import { describe, it } from "node:test";
import { expect } from "chai";
import { executeBacktest } from "../lib/backtest-executor";
import type { BacktestSettings, OHLCVData, Signal, Strategy, Time } from "../lib/types/strategies";
import type { CapitalSettings } from "../lib/types/backtest";

const baseTime = 1_700_000_000;

const settings: BacktestSettings = {
    executionModel: "signal_close",
    tradeDirection: "long",
    allowSameBarExit: true,
    slippageBps: 0,
    marketMode: "all",
};

const capitalSettings: CapitalSettings = {
    initialCapital: 10_000,
    positionSize: 100,
    commission: 0,
    sizingMode: "percent",
    fixedTradeAmount: 1_000,
};

function candle(offsetSec: number, close: number): OHLCVData {
    return {
        time: (baseTime + offsetSec) as Time,
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1_000,
    };
}

function lookbackSignalStrategy(): Strategy {
    return {
        name: "1s Gap Lookback Test",
        description: "Emits once the observed-bar lookback is available.",
        defaultParams: { lookback: 4 },
        paramLabels: { lookback: "Lookback" },
        execute: (data, params): Signal[] => {
            const lookback = Math.max(1, Math.floor(params.lookback ?? 4));
            const signals: Signal[] = [];
            for (let i = lookback - 1; i < data.length; i++) {
                signals.push({
                    time: data[i].time,
                    type: "buy",
                    price: data[i].close,
                    barIndex: i,
                });
            }
            return signals;
        },
    };
}

async function runGapBacktest(data: OHLCVData[]) {
    return executeBacktest({
        ohlcvData: data,
        interval: "1s",
        primarySymbol: "BTCUSDT",
        strategyKey: "__test_1s_gap_lookback__",
        strategy: lookbackSignalStrategy(),
        strategyParams: { lookback: 4 },
        backtestSettings: settings,
        capitalSettings,
        context: {
            nowSec: baseTime + 10_000,
            blockRange: null,
            annotatePolymarket: false,
            engineMode: "typescript",
        },
    });
}

describe("Polymarket 1s strategy gap guard", () => {
    it("does not count pre-gap bars toward a post-gap strategy lookback", async () => {
        const data = [
            candle(0, 100),
            candle(1, 101),
            candle(2, 102),
            candle(3600, 103),
            candle(3601, 104),
            candle(3602, 105),
        ];

        const run = await runGapBacktest(data);

        expect(run.signals).to.deep.equal([]);
        expect(run.result.totalTrades).to.equal(0);
    });

    it("remaps post-gap signals to the original chart bar index after a fresh warmup", async () => {
        const data = [
            candle(0, 100),
            candle(1, 101),
            candle(2, 102),
            candle(3600, 103),
            candle(3601, 104),
            candle(3602, 105),
            candle(3603, 106),
        ];

        const run = await runGapBacktest(data);

        expect(run.signals.map((signal) => [signal.time, signal.barIndex])).to.deep.equal([
            [(baseTime + 3603) as Time, 6],
        ]);
    });
});
