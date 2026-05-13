import assert from "node:assert";
import { describe, it } from "node:test";
import { BACKTEST_ENDPOINT_CAPITAL_SETTINGS } from "../lib/backtest-endpoint-contract";
import { computeBacktestEndpointDatasetFingerprint, type UiBacktestEndpointSnapshot } from "../lib/backtest-endpoint-copy";
import { buildBacktestEndpointExecutorRequestFromSnapshot } from "../lib/backtest-endpoint-execution";
import type { OHLCVData, Time } from "../lib/types/strategies";
import { strategyManifest } from "../lib/strategies/manifest";

const defaultStrategyEntry = strategyManifest.find((entry) => !entry.strategy.crossSymbolConfig);
assert.ok(defaultStrategyEntry, "Expected at least one non-cross-symbol strategy in manifest");
const defaultStrategyKey = defaultStrategyEntry!.key;
const defaultStrategyParams = { ...defaultStrategyEntry!.strategy.defaultParams };

function buildCandles(): OHLCVData[] {
    return [
        { time: 1700000000 as Time, open: 100, high: 101, low: 99, close: 100.5, volume: 10 },
        { time: 1700000300 as Time, open: 100.5, high: 102, low: 100, close: 101.5, volume: 12 },
    ];
}

function buildSnapshot(): UiBacktestEndpointSnapshot {
    const candles = buildCandles();
    return {
        symbol: "BTCUSDT",
        interval: "5m",
        strategyKey: defaultStrategyKey,
        strategyParams: defaultStrategyParams,
        backtestSettings: {
            executionModel: "next_open",
            tradeDirection: "short",
            allowSameBarExit: true,
            slippageBps: 0,
            marketMode: "all",
            polymarketPostSignalLimitEntryEnabled: true,
            polymarketPostSignalLimitEntryMode: "signal_offset",
            polymarketPostSignalLimitEntryPriceCents: 45,
            polymarketPostSignalLimitEntryOffsetCents: 20,
            polymarketPostSignalLimitExitEnabled: true,
            polymarketPostSignalLimitExitMode: "entry_offset",
            polymarketPostSignalLimitExitPriceCents: 80,
            polymarketPostSignalLimitExitOffsetCents: 20,
        },
        capitalSettings: {
            ...BACKTEST_ENDPOINT_CAPITAL_SETTINGS,
            fixedTradeAmount: 500,
        },
        nowSec: 1775400000,
        blockRange: { from: 1775390000, to: 1775400000 },
        annotatePolymarket: false,
        engineUsed: "rust",
        datasetFingerprint: computeBacktestEndpointDatasetFingerprint(candles),
    };
}

describe("backtest endpoint execution helpers", () => {
    it("builds the exact shared executor request shape for endpoint preview runs", () => {
        const candles = buildCandles();
        const snapshot = buildSnapshot();
        const request = buildBacktestEndpointExecutorRequestFromSnapshot(snapshot, candles);

        assert.strictEqual(request.strategyKey, snapshot.strategyKey);
        assert.strictEqual(request.interval, snapshot.interval);
        assert.deepStrictEqual(request.ohlcvData, candles);
        assert.deepStrictEqual(request.strategyParams, snapshot.strategyParams);
        assert.deepStrictEqual(request.capitalSettings, BACKTEST_ENDPOINT_CAPITAL_SETTINGS);
        assert.strictEqual(request.context.engineMode, "rust_preferred");
        assert.deepStrictEqual(request.context.blockRange, snapshot.blockRange);
        assert.strictEqual(request.context.nowSec, snapshot.nowSec);
        assert.strictEqual(request.context.annotatePolymarket, true);
        assert.strictEqual(request.backtestSettings.symbol, snapshot.symbol);
        assert.strictEqual(request.backtestSettings.interval, snapshot.interval);
        assert.strictEqual(request.backtestSettings.polymarketAnnotationEnabled, true);
        assert.ok(!("allowSameBarExit" in request.backtestSettings));
        assert.ok(!("marketMode" in request.backtestSettings));
        assert.ok(!("snapshotRsiMin" in request.backtestSettings));
        assert.ok(!("snapshotRsiMax" in request.backtestSettings));
        assert.ok(!("polymarketExitMode" in request.backtestSettings));
        assert.ok(!("polymarketPostSignalLimitEntryEnabled" in request.backtestSettings));
        assert.ok(!("polymarketPostSignalLimitEntryMode" in request.backtestSettings));
        assert.ok(!("polymarketPostSignalLimitEntryPriceCents" in request.backtestSettings));
        assert.ok(!("polymarketPostSignalLimitEntryOffsetCents" in request.backtestSettings));
        assert.ok(!("polymarketPostSignalLimitExitEnabled" in request.backtestSettings));
        assert.ok(!("polymarketPostSignalLimitExitMode" in request.backtestSettings));
        assert.ok(!("polymarketPostSignalLimitExitPriceCents" in request.backtestSettings));
        assert.ok(!("polymarketPostSignalLimitExitOffsetCents" in request.backtestSettings));
        assert.strictEqual(request.primarySymbol, snapshot.symbol);
    });

    it("strips signal-exit mode from endpoint executor settings", () => {
        const candles = buildCandles();
        const snapshot = {
            ...buildSnapshot(),
            interval: "1m",
            backtestSettings: {
                ...buildSnapshot().backtestSettings,
                polymarketExitMode: "signal_exit_same_event" as const,
            },
        } satisfies UiBacktestEndpointSnapshot;

        const request = buildBacktestEndpointExecutorRequestFromSnapshot(snapshot, candles);

        assert.ok(!("polymarketExitMode" in request.backtestSettings));
    });

    it("forwards explicit cross-symbol snapshot input into the executor request", () => {
        const candles = buildCandles();
        const snapshot = {
            ...buildSnapshot(),
            strategyKey: "relative_strength_mean_reversion",
            backtestSettings: {
                ...buildSnapshot().backtestSettings,
                crossSymbolSecondary: "DOGEUSDT",
            },
        } satisfies UiBacktestEndpointSnapshot;

        const request = buildBacktestEndpointExecutorRequestFromSnapshot(snapshot, candles, {
            secondarySymbol: "DOGEUSDT",
            secondaryData: buildCandles(),
        });

        assert.deepStrictEqual(request.crossSymbolInput?.secondarySymbol, "DOGEUSDT");
        assert.strictEqual(request.crossSymbolInput?.secondaryData.length, 2);
    });
});
