/**
 * Execution context resolution for backtests.
 *
 * This module replaces implicit reads of DOM state, global `state.*`, and
 * environment-derived values with explicit parameters that both the UI and
 * the HTTP endpoint can supply through the exact same path.
 */

import type { OHLCVData } from "./types/strategies";
import type { CapitalSettings } from "./types/backtest";
import { sliceOhlcvByBlock } from "./block-selector";
import { selectExecutionAwareClosedCandles } from "./alert-evaluation-window";
import { getIntervalSeconds } from "./dataProviders/utils";
import type { BacktestExecutionContext } from "./backtest-endpoint-contract";

// ============================================================================
// Context builder
// ============================================================================

export type ResolvedBacktestContext = {
    nowSec: number;
    blockRange: { from: number; to: number } | null;
    annotatePolymarket: boolean;
    engineMode: "auto" | "typescript" | "rust_preferred";
    intervalSeconds: number;
};

export function resolveContext(
    partialCtx: Partial<BacktestExecutionContext>,
    interval: string,
    defaults?: {
        defaultNowSec?: number;
        blockRange?: { from: number; to: number } | null;
        annotatePolymarket?: boolean;
        engineMode?: "auto" | "typescript" | "rust_preferred";
    }
): ResolvedBacktestContext {
    const nowSec = partialCtx.nowSec ?? defaults?.defaultNowSec ?? Math.floor(Date.now() / 1000);
    const blockRange = partialCtx.blockRange ?? defaults?.blockRange ?? null;
    const annotatePolymarket = partialCtx.annotatePolymarket ?? defaults?.annotatePolymarket ?? false;
    const engineMode = partialCtx.engineMode ?? defaults?.engineMode ?? "auto";

    return {
        nowSec,
        blockRange,
        annotatePolymarket,
        engineMode,
        intervalSeconds: getIntervalSeconds(interval),
    };
}

// ============================================================================
// Candle selection (pure, no global state)
// ============================================================================

/**
 * Selects closed candles with block-range slicing applied, using the same
 * logic that `backtestService.selectClosedCandleData(...)` used but without
 * reading `state.blockRange`, `state.currentInterval`, or `Date.now()`.
 */
export function selectClosedCandleData(
    ohlcvData: OHLCVData[],
    interval: string,
    settings: Record<string, unknown>,
    ctx: ResolvedBacktestContext
): OHLCVData[] {
    // Only attempt execution-aware window trimming when we have enough bars
    // and the caller has not disabled the behavior.
    const executionAware = selectExecutionAwareClosedCandles(
        ohlcvData,
        interval,
        settings,
        {
            nowSec: ctx.nowSec,
            minClosedCandles: 1,
            fallbackToTrimmedClosed: true,
        }
    );

    const base = executionAware ?? ohlcvData;
    return sliceOhlcvByBlock(base, ctx.blockRange);
}

// ============================================================================
// Capital settings resolution (pure)
// ============================================================================

import { resolveCapitalSettingsFromRaw } from "./backtest-capital-settings";

export function resolveCapitalSettings(
    raw: CapitalSettings | Record<string, unknown>,
    defaults?: {
        initialCapital?: number;
        positionSize?: number;
        commission?: number;
        fixedTradeAmount?: number;
    }
): CapitalSettings {
    // If already a resolved CapitalSettings object with all required fields,
    // return it directly.
    const maybeResolved = raw as CapitalSettings;
    if (
        typeof maybeResolved.initialCapital === "number" &&
        typeof maybeResolved.positionSize === "number" &&
        typeof maybeResolved.commission === "number" &&
        typeof maybeResolved.sizingMode === "string" &&
        typeof maybeResolved.fixedTradeAmount === "number"
    ) {
        return maybeResolved;
    }

    // Otherwise treat as a raw record and resolve through the shared resolver.
    const rawWithDefaults: Record<string, unknown> = { ...raw };
    if (defaults?.initialCapital !== undefined && rawWithDefaults.initialCapital === undefined) {
        rawWithDefaults.initialCapital = defaults.initialCapital;
    }
    if (defaults?.positionSize !== undefined && rawWithDefaults.positionSize === undefined) {
        rawWithDefaults.positionSize = defaults.positionSize;
    }
    if (defaults?.commission !== undefined && rawWithDefaults.commission === undefined) {
        rawWithDefaults.commission = defaults.commission;
    }
    if (defaults?.fixedTradeAmount !== undefined && rawWithDefaults.fixedTradeAmount === undefined) {
        rawWithDefaults.fixedTradeAmount = defaults.fixedTradeAmount;
    }

    return resolveCapitalSettingsFromRaw(rawWithDefaults);
}
