import type { UTCTimestamp } from "lightweight-charts";
import assert from "node:assert/strict";
import { withLocalIbkrFixture } from "./helpers/local-ibkr-fixture";
import { describe, it } from "node:test";
import { executeBacktest } from "../lib/backtest-executor";
import { loadServerBatchDataset } from "../lib/batch-backtest/server-batch-data-loader";
import { body_direction_placement_coherence } from "../lib/strategies/lib/body_direction_placement_coherence";
import type { BacktestSettings } from "../lib/types/strategies";

const BULLET = String.fromCharCode(0x2022);
const PH_LIN = `PH${BULLET}+LIN${BULLET}`;

describe("PH+LIN TypeScript batch regression", () => {
    it("completes the F3 configuration with the VWAP exit override", async () => {
        // Alternating bodies place the close near the high/low and exercise F3 signals.
        const baseBars = Array.from({ length: 160 }, (_, index) => {
            const open = 100 + Math.sin(index / 8) * 10;
            const close = open + (index % 2 === 0 ? 2 : -2);
            return { time: (1_700_006_400 + index * 14_400) as UTCTimestamp, open, close,
                high: Math.max(open, close) + 0.1, low: Math.min(open, close) - 0.1,
                volume: 1_000 };
        });
        const quoteBars = baseBars.map(({ time }) => ({
            time, open: 50, high: 50, low: 50, close: 50, volume: 1_000,
        }));
        await withLocalIbkrFixture("4h", { PH: baseBars, LIN: quoteBars }, async () => {
            const data = await loadServerBatchDataset(PH_LIN, "4h");
            assert.equal(data.length, baseBars.length, "both fixture legs must align completely");
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
                    engineMode: "typescript",
                    useRustEnginePreference: false,
                    nowSec: baseBars.at(-1)!.time + 14_400,
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
            assert.ok(output.result.totalTrades > 0, "fixture must execute actual trades");
            assert.ok(Number.isFinite(output.result.netProfit));
        });
    });
});
