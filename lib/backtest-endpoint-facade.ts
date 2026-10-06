import { state } from "./state";
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

/**
 * Build the endpoint copy snapshot from an explicitly captured request
 * identity. Callers must pass the symbol/interval/strategy the result was
 * actually computed for — never current UI state, which may already describe
 * a different market by the time the result is published.
 */
export function createEndpointCopySnapshot(args: {
    symbol: string;
    interval: string;
    strategyKey: string;
    strategyParams: StrategyParams;
    backtestSettings: BacktestSettings;
    capitalSettings: CapitalSettings;
    engineUsed: 'rust' | 'typescript';
    nowSec: number;
    blockRange: { from: number; to: number } | null;
    datasetForFingerprint?: OHLCVData[];
}): UiBacktestEndpointSnapshot {
    return {
        symbol: args.symbol,
        interval: args.interval,
        strategyKey: args.strategyKey,
        strategyParams: { ...args.strategyParams },
        backtestSettings: { ...args.backtestSettings },
        capitalSettings: {
            ...args.capitalSettings,
            advancedSizing: args.capitalSettings.advancedSizing ? { ...args.capitalSettings.advancedSizing } : undefined,
        },
        nowSec: args.nowSec,
        blockRange: args.blockRange ? { ...args.blockRange } : null,
        engineUsed: args.engineUsed,
        datasetFingerprint: computeBacktestEndpointDatasetFingerprint(args.datasetForFingerprint ?? []),
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
    const endpointRun = await executeBacktest({
        ...buildBacktestEndpointExecutorRequestFromSnapshot(snapshot, candles),
    });

    // Ownership check after the await: a result clear, a newer manual run,
    // or a competing preview invalidates this preview's publication even if
    // its own cancellation never arrived.
    if (state.currentBacktestResult !== currentResult || !canUseCurrentChartForEndpointCopy(snapshot)) {
        return null;
    }

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
    const preparedCopy = await prepareBacktestEndpointCopyBundleFromSnapshot(snapshot, baseUrl, candles);

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
