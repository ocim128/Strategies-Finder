import { expect } from "chai";
import { describe, it } from "node:test";
import type { BacktestSettings, OHLCVData, Strategy } from "../lib/types/strategies";
import type { CapitalSettings } from "../lib/types/backtest";
import type { FinderOptions } from "../lib/types/finder";
import {
    simulateFinderAssetOpportunityForwardOutcome,
    validateFreshWindowExecutionSettings,
} from "../lib/finder/finder-asset-opportunity-forward-contract";
import { runAssetCandidateBacktest } from "../lib/finder/finder-asset-candidate-execution";

function candle(time: number, open: number, high: number, low: number, close: number): OHLCVData {
    return { time, open, high, low, close, volume: 1_000 };
}

function contract(overrides: Partial<Parameters<typeof simulateFinderAssetOpportunityForwardOutcome>[0]> = {}) {
    return simulateFinderAssetOpportunityForwardOutcome({
        candles: [
            candle(1, 100, 100, 100, 100),
            candle(2, 100, 103, 99, 101),
            candle(3, 101, 104, 98, 102),
        ],
        direction: "long",
        entryPrice: 100,
        entryBarIndex: 0,
        takeProfitPrice: 102,
        stopLossPrice: 98,
        horizonBars: 2,
        executionModel: "signal_close",
        allowSameBarExit: false,
        slippageBps: 0,
        commissionPercent: 0,
        ...overrides,
    });
}

describe("Asset Opportunity execution-unit forward contract", () => {
    it("uses next-open entry and excludes TP/SL from the disallowed entry bar", () => {
        const result = contract({
            executionModel: "next_open",
            candles: [
                candle(1, 99, 105, 95, 100),
                candle(2, 101, 101, 101, 101),
                candle(3, 101, 103, 101, 102),
            ],
            stopLossPrice: 90,
            horizonBars: 3,
        });
        expect(result?.exitReason).to.equal("take_profit");
        expect(result?.barsHeld).to.equal(2);
    });

    it("takes TP or SL on the first touched separate bar", () => {
        expect(contract({
            candles: [candle(1, 100, 100, 100, 100), candle(2, 100, 103, 99, 101)],
            horizonBars: 1,
        })?.exitReason).to.equal("take_profit");
        expect(contract({
            candles: [candle(1, 100, 100, 100, 100), candle(2, 100, 101, 97, 99)],
            horizonBars: 1,
        })?.exitReason).to.equal("stop_loss");
    });

    it("locks same-bar TP+SL ordering to stop-first", () => {
        const result = contract({
            candles: [candle(1, 100, 100, 100, 100), candle(2, 100, 103, 97, 100)],
            horizonBars: 1,
        });
        expect(result?.exitReason).to.equal("stop_loss");
        expect(result?.exitPrice).to.equal(98);
    });

    it("fills a stop gap at the open and charges slippage/commission once", () => {
        const result = contract({
            candles: [candle(1, 100, 100, 100, 100), candle(2, 95, 100, 90, 94)],
            horizonBars: 1,
            slippageBps: 100,
            commissionPercent: 0.1,
        });
        expect(result?.exitReason).to.equal("stop_loss");
        expect(result?.exitPrice).to.equal(95 * 0.99);
        // Long entry slips up to 101; exit slips down from the 95 open to
        // 94.05. The 0.1% commission is applied to both sides once.
        expect(result?.entryPrice).to.be.closeTo(101, 1e-9);
        expect(result?.grossReturnPercent).to.equal(-5);
        expect(result?.slippagePercent).to.be.greaterThan(0);
        expect(result?.commissionPercent).to.be.closeTo(0.193118811881188, 1e-12);
        expect(result?.netReturnPercent).to.be.closeTo(
            (((94.05 - 101) / 101) - (0.001 * (1 + 94.05 / 101))) * 100,
            1e-9,
        );
    });

    it("censors at the horizon and remains usable with missing timestamp bars", () => {
        const result = contract({
            candles: [
                candle(1, 100, 100, 100, 100),
                candle(5, 100, 101, 99, 100),
                candle(9, 100, 101, 99, 100),
            ],
            takeProfitPrice: 200,
            stopLossPrice: 1,
            horizonBars: 2,
        });
        expect(result?.exitReason).to.equal("end_of_data");
        expect(result?.barsHeld).to.equal(2);
    });

    it("has long/short directional parity", () => {
        const long = contract({
            takeProfitPrice: 102,
            stopLossPrice: 98,
            candles: [candle(1, 100, 100, 100, 100), candle(2, 100, 103, 99, 101)],
        });
        const short = contract({
            direction: "short",
            takeProfitPrice: 98,
            stopLossPrice: 102,
            candles: [candle(1, 100, 100, 100, 100), candle(2, 100, 101, 97, 99)],
        });
        expect(long?.exitReason).to.equal("take_profit");
        expect(short?.exitReason).to.equal("take_profit");
        expect(long?.netReturnPercent).to.equal(short?.netReturnPercent);
    });

    it("keeps signal-close TP gaps on the same first-touch path as the engine", () => {
        const result = contract({
            executionModel: "signal_close",
            allowSameBarExit: true,
            candles: [
                candle(1, 100, 100, 100, 100),
                candle(2, 105, 106, 104, 105),
            ],
            horizonBars: 1,
        });
        expect(result?.exitReason).to.equal("take_profit");
        expect(result?.exitPrice).to.equal(102);
    });

    it("keeps signal-close SL gaps on the same first-touch path as the engine", () => {
        const result = contract({
            executionModel: "signal_close",
            allowSameBarExit: true,
            candles: [
                candle(1, 100, 100, 100, 100),
                candle(2, 95, 96, 94, 95),
            ],
            horizonBars: 1,
        });
        expect(result?.exitReason).to.equal("stop_loss");
        expect(result?.exitPrice).to.equal(95);
    });

    it("allows only a protective stop on the next-open entry bar", () => {
        const result = contract({
            executionModel: "next_open",
            allowSameBarExit: false,
            candles: [
                candle(1, 100, 103, 97, 100),
                candle(2, 100, 100, 100, 100),
            ],
            horizonBars: 2,
        });
        expect(result?.exitReason).to.equal("stop_loss");
        expect(result?.barsHeld).to.equal(0);
    });

    it("rejects next-close for the fresh-window execution contract", () => {
        const errors = validateFreshWindowExecutionSettings({
            executionModel: "next_close",
            tradeDirection: "long",
            allowSameBarExit: false,
            riskMode: "percentage",
            stopLossEnabled: true,
            stopLossPercent: 2,
            takeProfitEnabled: true,
            takeProfitPercent: 2,
        });
        expect(errors.some((error) => error.includes("executionModel"))).to.equal(true);
    });

    it("rejects a short fresh-window judgment", () => {
        const errors = validateFreshWindowExecutionSettings({
            executionModel: "next_open",
            tradeDirection: "short",
            allowSameBarExit: false,
            riskMode: "percentage",
            stopLossEnabled: true,
            stopLossPercent: 2,
            takeProfitEnabled: true,
            takeProfitPercent: 2,
        });
        expect(errors.some((error) => error.includes("tradeDirection"))).to.equal(true);
    });

    it("uses a relative threshold at a TP/SL boundary", () => {
        const result = contract({
            candles: [
                candle(1, 100, 100, 100, 100),
                candle(2, 100, 102 + (102 * 5e-11), 100, 102),
            ],
            horizonBars: 1,
        });
        expect(result?.exitReason).to.equal("take_profit");
    });

    it("matches the TypeScript engine on a fixed percentage TP/SL fixture", async () => {
        const data = [
            candle(1, 100, 100, 100, 100),
            candle(2, 100, 103, 97, 100),
            candle(3, 100, 100, 100, 100),
        ];
        const strategy: Strategy = {
            name: "contract-parity",
            description: "fixture",
            defaultParams: {},
            paramLabels: {},
            execute(candles) {
                return [{ time: candles[0]!.time, type: "buy", price: candles[0]!.close }];
            },
        };
        const settings: BacktestSettings = {
            executionModel: "signal_close",
            allowSameBarExit: false,
            tradeDirection: "long",
            riskMode: "percentage",
            stopLossEnabled: true,
            stopLossPercent: 2,
            takeProfitEnabled: true,
            takeProfitPercent: 2,
            slippageBps: 0,
        };
        const capitalSettings: CapitalSettings = {
            initialCapital: 10_000,
            positionSize: 100,
            commission: 0,
            sizingMode: "percent",
            fixedTradeAmount: 1_000,
        };
        const options = {
            mode: "random",
            scope: "asset_opportunity",
            sortPriority: ["netProfit"],
            dataSlice: "all",
            freezeRiskManagement: false,
        } as unknown as FinderOptions;
        const engine = await runAssetCandidateBacktest({
            data,
            symbol: "PARITY",
            interval: "5m",
            strategy,
            strategyKey: "contract-parity",
            strategyParams: {},
            riskOverrideParams: {},
            settings,
            capitalSettings,
            options,
            closedCandleDataOverride: data,
            needs: { compact: false, trades: true, fullAnalytics: false, endpointSelection: false },
        });
        const simulated = contract({
            candles: data,
            takeProfitPrice: 102,
            stopLossPrice: 98,
            horizonBars: 2,
        });
        expect(engine.result.trades[0]!.exitReason).to.equal(simulated?.exitReason);
        expect(engine.result.trades[0]!.exitPrice).to.equal(simulated?.exitPrice);
        expect(engine.result.trades[0]!.pnlPercent).to.equal(simulated?.netReturnPercent);
    });
});
