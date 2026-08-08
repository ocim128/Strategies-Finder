import type { BacktestExecutorRequest } from "./backtest-executor";
import {
    BACKTEST_ENDPOINT_CAPITAL_SETTINGS,
    type EngineMode,
} from "./backtest-endpoint-contract";
import {
    cloneBlockRange,
    resolveEndpointCopyEngineMode,
    resolveEndpointPolymarketAnnotation,
    type UiBacktestEndpointSnapshot,
} from "./backtest-endpoint-copy";
import { stripEndpointIgnoredBacktestSettings } from "./backtest-endpoint-settings";
import type { OHLCVData, StrategyParams } from "./types/strategies";

function stripSignalExitMode(
    settings: Record<string, unknown>
): Record<string, unknown> {
    const { polymarketExitMode, ...rest } = settings;
    return rest;
}

export function buildBacktestEndpointExecutorRequest(
    strategyKey: string,
    candles: OHLCVData[],
    interval: string,
    strategyParams: StrategyParams,
    backtestSettings: Record<string, unknown>,
    engineMode: EngineMode,
    nowSec: number,
    blockRange: { from: number; to: number } | null,
    annotatePolymarket: boolean,
    crossSymbolInput?: {
        secondarySymbol: string;
        secondaryData: OHLCVData[];
    },
): BacktestExecutorRequest {
    return {
        ohlcvData: candles,
        interval,
        primarySymbol: String(backtestSettings.symbol ?? ""),
        strategyKey,
        strategyParams,
        backtestSettings: stripSignalExitMode(stripEndpointIgnoredBacktestSettings(backtestSettings)),
        capitalSettings: { ...BACKTEST_ENDPOINT_CAPITAL_SETTINGS },
        crossSymbolInput: crossSymbolInput
            ? {
                secondarySymbol: crossSymbolInput.secondarySymbol,
                secondaryData: crossSymbolInput.secondaryData.map((candle) => ({ ...candle })),
            }
            : undefined,
        context: {
            nowSec,
            blockRange: cloneBlockRange(blockRange),
            annotatePolymarket,
            engineMode,
        },
    };
}

export function buildBacktestEndpointExecutorRequestFromSnapshot(
    snapshot: UiBacktestEndpointSnapshot,
    candles: OHLCVData[],
    crossSymbolInput?: {
        secondarySymbol: string;
        secondaryData: OHLCVData[];
    }
): BacktestExecutorRequest {
    const annotatePolymarket = resolveEndpointPolymarketAnnotation(snapshot);
    return buildBacktestEndpointExecutorRequest(
        snapshot.strategyKey,
        candles,
        snapshot.interval,
        snapshot.strategyParams,
        {
            ...snapshot.backtestSettings,
            polymarketAnnotationEnabled: annotatePolymarket,
            symbol: snapshot.symbol,
            interval: snapshot.interval,
        },
        resolveEndpointCopyEngineMode(snapshot.engineUsed),
        snapshot.nowSec,
        snapshot.blockRange,
        annotatePolymarket,
        crossSymbolInput
    );
}
