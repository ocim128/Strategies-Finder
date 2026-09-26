import type { BacktestExecutorRequest } from "./backtest-executor";
import {
    BACKTEST_ENDPOINT_CAPITAL_SETTINGS,
    type EngineMode,
} from "./backtest-endpoint-contract";
import {
    cloneBlockRange,
    resolveEndpointCopyEngineMode,
    type UiBacktestEndpointSnapshot,
} from "./backtest-endpoint-copy";
import { stripEndpointIgnoredBacktestSettings } from "./backtest-endpoint-settings";
import type { OHLCVData, StrategyParams } from "./types/strategies";

export function buildBacktestEndpointExecutorRequest(
    strategyKey: string,
    candles: OHLCVData[],
    interval: string,
    strategyParams: StrategyParams,
    backtestSettings: Record<string, unknown>,
    engineMode: EngineMode,
    nowSec: number,
    blockRange: { from: number; to: number } | null,
): BacktestExecutorRequest {
    return {
        ohlcvData: candles,
        interval,
        primarySymbol: String(backtestSettings.symbol ?? ""),
        strategyKey,
        strategyParams,
backtestSettings: stripEndpointIgnoredBacktestSettings(backtestSettings),
        capitalSettings: { ...BACKTEST_ENDPOINT_CAPITAL_SETTINGS },
        context: {
            nowSec,
            blockRange: cloneBlockRange(blockRange),
            engineMode,
        },
    };
}

export function buildBacktestEndpointExecutorRequestFromSnapshot(
    snapshot: UiBacktestEndpointSnapshot,
    candles: OHLCVData[],
): BacktestExecutorRequest {
    return buildBacktestEndpointExecutorRequest(
        snapshot.strategyKey,
        candles,
        snapshot.interval,
        snapshot.strategyParams,
        {
            ...snapshot.backtestSettings,
            symbol: snapshot.symbol,
            interval: snapshot.interval,
        },
        resolveEndpointCopyEngineMode(snapshot.engineUsed),
        snapshot.nowSec,
        snapshot.blockRange,
    );
}
