import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executeBacktest } from "../lib/backtest-executor";
import { loadServerBatchDataset } from "../lib/batch-backtest/server-batch-data-loader";
import { body_direction_placement_coherence } from "../lib/strategies/lib/body_direction_placement_coherence";
import type { BacktestSettings } from "../lib/types/strategies";

const BULLET = String.fromCharCode(0x2022);
const PH_LIN = `PH${BULLET}+LIN${BULLET}`;

describe("PH+LIN TypeScript batch regression", () => {
    it("completes the F3 configuration with the VWAP exit override", async () => {
        const data = await loadServerBatchDataset(PH_LIN, "4h");
        assert.ok(data.length >= 30, `expected usable PH+LIN data, got ${data.length} bars`);
        assert.ok(data.every((bar) => [bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)));

        const settings: BacktestSettings = {
            atrPeriod: 2,
            stopLossAtr: 0,
            takeProfitAtr: 0,
            trailingAtr: 0,
            partialTakeProfitAtR: 0,
            partialTakeProfitPercent: 0,
            breakEvenAtR: 0,
            breakEvenPercent: 0,
            timeStopBars: 0,
            stopLossPercent: 0,
            takeProfitPercent: 0,
            riskMinHoldBars: 1,
            riskMaxHoldBars: 12,
            riskCooldownBars: 12,
            riskMaxHoldEnabled: true,
            riskMinHoldEnabled: false,
            riskCooldownEnabled: false,
            riskMode: "percentage",
            takeProfitMode: "fixed",
            stopLossEnabled: false,
            takeProfitEnabled: false,
            executionModel: "next_open",
            tradeDirection: "long",
            exitStrategyOverrideEnabled: true,
            exitStrategyKey: "vwap_deviation_reversion",
            exitStrategyParams: { period: 30 },
            disableSignalExits: false,
            allowSameBarExit: false,
            marketMode: "all",
            confirmationStrategies: [],
        };

        const output = await executeBacktest({
            ohlcvData: data,
            interval: "4h",
            primarySymbol: PH_LIN,
            strategyKey: "body_direction_placement_coherence",
            strategy: body_direction_placement_coherence,
            strategyParams: { coherenceThreshold: 0.7 },
            backtestSettings: settings,
            capitalSettings: {
                initialCapital: 10000,
                positionSize: 100,
                commission: 0.1,
                sizingMode: "fixed",
                fixedTradeAmount: 1000,
            },
            context: {
                blockRange: null,
                annotatePolymarket: false,
                engineMode: "typescript",
                useRustEnginePreference: false,
                nowSec: Math.floor(Date.now() / 1000),
            },
            backtestRunOptions: {
                includeAdvancedAnalytics: false,
                includeSharpeRatio: false,
                omitEquityCurve: true,
                useCompactBacktest: false,
                skipDrawdown: false,
                skipResultPostProcessing: true,
            },
        });

        assert.equal(output.engineUsed, "typescript");
        assert.ok(output.signals.length > 0);
        assert.ok(Number.isFinite(output.result.totalTrades));
        assert.ok(Number.isFinite(output.result.netProfit));
    });
});
