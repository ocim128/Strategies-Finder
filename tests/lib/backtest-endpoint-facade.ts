import { state } from "./state";
import { dataManager } from "./data-manager";
import { strategyRegistry } from "../strategyRegistry";
import type { OHLCVData } from "./strategies/index";
import type { BacktestResult, StrategyParams, BacktestSettings } from "./strategies/index";
import type { CapitalSettings } from "./types/backtest";
import {
    buildBacktestEndpointCopyBundleFromSnapshot,
    computeBacktestEndpointDatasetFingerprint,
    getCurrentUiBacktestEndpointCandles,
    getCurrentUiBacktestEndpointSnapshot,
    hasCurrentUiBacktestEndpointCandles,
    hasCurrentUiBacktestEndpointSnapshot,
    matchesEndpointCapitalProfile,
    prepareBacktestEndpointCopyBundleFromSnapshot,
    type UiBacktestEndpointSnapshot,
} from "./backtest-endpoint-copy";
import { buildBacktestEndpointExecutorRequestFromSnapshot } from "./backtest-endpoint-execution";
import { toCompactMetrics } from "./backtest-endpoint-contract";
import { executeBacktest } from "./backtest-executor";
import { commitBacktestResult } from "./state-actions";
import { resolveCrossSymbolSecondaryForStrategy } from "./cross-symbol-runtime";

export function createEndpointCopySnapshot(
    strategyParams: StrategyParams,
    backtestSettings: BacktestSettings,
    capitalSettings: CapitalSettings,
    engineUsed: 'rust' | 'typescript',
    nowSec: number,
    blockRange: { from: number; to: number } | null,
    annotatePolymarket: boolean
): UiBacktestEndpointSnapshot {
    return {
        symbol: state.currentSymbol,
        interval: state.currentInterval,
        strategyKey: state.currentStrategyKey,
        strategyParams: { ...strategyParams },
        backtestSettings: { ...backtestSettings },
        capitalSettings: {
            ...capitalSettings,
            advancedSizing: capitalSettings.advancedSizing ? { ...capitalSettings.advancedSizing } : undefined,
        },
        nowSec,
        blockRange: blockRange ? { ...blockRange } : null,
        annotatePolymarket,
        engineUsed,
        datasetFingerprint: computeBacktestEndpointDatasetFingerprint(state.ohlcvData),
    };
}

function canUseCurrentChartForEndpointCopy(snapshot: UiBacktestEndpointSnapshot): boolean {
    return hasCurrentUiBacktestEndpointCandles()
        && snapshot.symbol === state.currentSymbol
        && snapshot.interval === state.currentInterval;
}

function compactMetricResultsMatch(left: BacktestResult, right: BacktestResult): boolean {
    const leftMetrics = toCompactMetrics(left);
    const rightMetrics = toCompactMetrics(right);
    const epsilon = 1e-9;
    const metricKeys = Object.keys(leftMetrics) as Array<keyof typeof leftMetrics>;

    return metricKeys.every((key) => {
        const leftValue = leftMetrics[key];
        const rightValue = rightMetrics[key];
        if (typeof leftValue === "number" && typeof rightValue === "number") {
            if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
                return leftValue === rightValue;
            }
            return Math.abs(leftValue - rightValue) <= epsilon;
        }
        return leftValue === rightValue;
    });
}

async function resolveEndpointCrossSymbolDataset(
    snapshot: UiBacktestEndpointSnapshot
): Promise<{ secondarySymbol: string; candles: OHLCVData[] } | undefined> {
    const strategy = strategyRegistry.get(snapshot.strategyKey);
    if (!strategy?.crossSymbolConfig) {
        return undefined;
    }

    const secondarySymbol = resolveCrossSymbolSecondaryForStrategy(strategy, snapshot.backtestSettings);
    if (!secondarySymbol) {
        throw new Error(`Unable to resolve secondary symbol for cross-symbol strategy "${snapshot.strategyKey}".`);
    }

    const candles = await dataManager.fetchDataDetached(secondarySymbol, snapshot.interval);
    if (!Array.isArray(candles) || candles.length === 0) {
        throw new Error(`No data available for secondary symbol "${secondarySymbol}" on interval "${snapshot.interval}".`);
    }

    return {
        secondarySymbol,
        candles,
    };
}

export function canCopyLatestUiBacktestEndpointRequest(): boolean {
    const snapshot = getCurrentUiBacktestEndpointSnapshot();
    if (!hasCurrentUiBacktestEndpointSnapshot() || !snapshot || !state.currentBacktestResult) {
        return false;
    }

    return canUseCurrentChartForEndpointCopy(snapshot);
}

export function canRunLatestUiBacktestEndpointPreview(): boolean {
    return canCopyLatestUiBacktestEndpointRequest();
}

export async function runLatestUiBacktestEndpointPreview(): Promise<{
    strategyKey: string;
    result: BacktestResult;
    engineUsed: "rust" | "typescript";
    matchesCurrentUiResult: boolean;
    previousUiMetrics: ReturnType<typeof toCompactMetrics>;
    endpointMetrics: ReturnType<typeof toCompactMetrics>;
} | null> {
    const snapshot = getCurrentUiBacktestEndpointSnapshot();
    const candles = getCurrentUiBacktestEndpointCandles();
    const currentResult = state.currentBacktestResult;
    if (!snapshot || !candles || !currentResult || !canUseCurrentChartForEndpointCopy(snapshot)) {
        return null;
    }

    const crossSymbolDataset = await resolveEndpointCrossSymbolDataset(snapshot);
    const endpointRun = await executeBacktest({
        ...buildBacktestEndpointExecutorRequestFromSnapshot(snapshot, candles, crossSymbolDataset ? {
            secondarySymbol: crossSymbolDataset.secondarySymbol,
            secondaryData: crossSymbolDataset.candles,
        } : undefined),
        dataFetcher: dataManager,
    });
    const matchesCurrentUiResult = compactMetricResultsMatch(currentResult, endpointRun.result);

    commitBacktestResult(endpointRun.result, "endpoint_preview", {
        reason: "endpoint_preview",
        endpointCopySnapshot: snapshot,
        endpointCopyCandles: candles,
    });

    return {
        strategyKey: snapshot.strategyKey,
        result: endpointRun.result,
        engineUsed: endpointRun.engineUsed,
        matchesCurrentUiResult,
        previousUiMetrics: toCompactMetrics(currentResult),
        endpointMetrics: toCompactMetrics(endpointRun.result),
    };
}

export async function buildLatestUiBacktestEndpointCopyBundle(baseUrl: string): Promise<{
    strategyKey: string;
    bundle: ReturnType<typeof buildBacktestEndpointCopyBundleFromSnapshot>;
    uiCapitalMatchesEndpoint: boolean;
    datasetRef: string;
    candleCount: number;
    datasetUploaded: boolean;
    datasetUploadError: string | null;
} | null> {
    const snapshot = getCurrentUiBacktestEndpointSnapshot();
    const candles = getCurrentUiBacktestEndpointCandles();
    if (!snapshot || !candles || !state.currentBacktestResult || !canUseCurrentChartForEndpointCopy(snapshot)) {
        return null;
    }

    const crossSymbolDataset = await resolveEndpointCrossSymbolDataset(snapshot);
    const preparedCopy = await prepareBacktestEndpointCopyBundleFromSnapshot(snapshot, baseUrl, candles, crossSymbolDataset);

    return {
        strategyKey: snapshot.strategyKey,
        bundle: preparedCopy.bundle,
        uiCapitalMatchesEndpoint: matchesEndpointCapitalProfile(snapshot.capitalSettings),
        datasetRef: preparedCopy.datasetRef,
        candleCount: preparedCopy.candleCount,
        datasetUploaded: preparedCopy.datasetUploaded,
        datasetUploadError: preparedCopy.datasetUploadError,
    };
}
