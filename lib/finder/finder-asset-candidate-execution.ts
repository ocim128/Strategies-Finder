/**
 * Shared candidate-execution helper for the Finder Asset Opportunity scope.
 *
 * Both the browser runner (`executeAssetCandidate` in
 * `finder-asset-opportunity-runner.ts`) and the server IS search
 * (`runServerAssetIsSearch` in `server-asset-is-search.ts`) previously
 * re-implemented the same block — sanitize for Rust, apply Finder risk
 * overrides, inject the Exit Strategy Override settings, pre-resolve executor
 * settings, and call `executeBacktest` with a compact/trade-history/endpoint
 * option matrix — and the two copies had already drifted (e.g. the runner's
 * `useCompactBacktest` flag vs the IS search's implicit compact path).
 *
 * This leaf is the single source of truth for that execution. Callers keep
 * their own parameter-set generation/normalization, candidate construction,
 * and engine-usage accounting; they pass the *resolved* inputs here.
 *
 * The `needs` matrix maps to the exact per-path behavior:
 *
 * - IS search candidate loop:  compact, no trades, endpoint selection "auto"
 *   (compact endpoint-adjusted scalars unless the trade direction is
 *   `combined`, which retains trades instead), full analytics only when the
 *   sort priority requires them.
 * - Fresh-entry recheck (signal_close): full engine, trade history retained
 *   (`detectFreshEntry` reads `latestTrade`), no full analytics.
 * - Fresh-entry recheck (next_open/next_close, fixed-horizon mode): same as
 *   above plus `signalsOnly` (trades are empty; retained in-sample signals
 *   drive fresh detection).
 * - Fresh-entry recheck (next_exit): full engine replay with trade history;
 *   freshness must honor execution gates such as max-open-trades and cooldown.
 * - OOS validation pass: full engine, trade history retained.
 * - Winner analytics recompute: compact engine, trade history, Sharpe +
 *   drawdown.
 *
 * Leaf import hygiene: reaches only `backtest-executor`,
 * `backtest-capital-settings`, `rust-settings-sanitizer`, and
 * `finder-runner-core` — none of which pull `lightweight-charts`, so this
 * module is safe for both the browser and the Vite config bundle.
 */

import type {
    BacktestResult,
    BacktestSettings,
    OHLCVData,
    Signal,
    Strategy,
    StrategyParams,
} from "../types/strategies";
import type { CapitalSettings } from "../types/backtest";
import type { CrossSymbolDataFetcher } from "../cross-symbol-runtime";
import type { FinderOptions } from "../types/finder";
import {
    executeBacktest,
    resolveExecutorBacktestSettings,
    type BacktestExitSignalCache,
} from "../backtest-executor";
import type { BacktestExecutorRequest } from "../backtest-executor";
import type {
    TypescriptFallbackGate,
    TypescriptSimulationConcurrencyTracker,
} from "../backtest-endpoint-contract";
import type { BacktestEndpointSelection } from "../strategies/backtest/backtest-engine";
import { resolveCapitalSettingsFromRaw } from "../backtest-capital-settings";
import { sanitizeBacktestSettingsForRust } from "../rust-settings-sanitizer";
import type { RustCapabilities, RustDiagnosticPhase } from "../rust-engine-client";
import { resolveFinderRiskOverrides } from "./finder-runner-core";

export type AssetCandidateEndpointSelection = "auto" | boolean;

/**
 * The execution surface the caller needs from this candidate run. See the
 * module header for the per-path matrix.
 */
export interface AssetCandidateBacktestNeeds {
    /** Use the compact scalar engine. */
    compact: boolean;
    /** Retain per-exit trade history (fresh recheck needs trades for `latestTrade`). */
    trades: boolean;
    /** Include Sharpe ratio + drawdown computation. */
    fullAnalytics: boolean;
    /** Generate signals without running trade simulation (non-`signal_close` fresh recheck). */
    signalsOnly?: boolean;
    /**
     * Compact endpoint-adjusted selection. `"auto"` enables it unless the
     * resolved trade direction is `combined` (which then retains trades
     * instead), mirroring the server IS search. `false` disables it.
     */
    endpointSelection?: AssetCandidateEndpointSelection;
}

export interface AssetCandidateExitOverride {
    key: string;
    params: StrategyParams;
}

export type AssetCandidateExitSignalCache = BacktestExitSignalCache;

export interface AssetCandidateBacktestOutput {
    result: BacktestResult;
    signals: Signal[];
    engineUsed: "rust" | "typescript";
    engineDiagnostics?: {
        rustAttempted: boolean;
        typescriptReason?: string;
    };
    /**
     * The final backtest settings after risk overrides + exit override
     * injection. Callers that feed settings into a prepared-strategy settings
     * provider (the IS search's `currentBacktestSettings`) must adopt this so
     * `prepareFinderData` caching sees the same settings the run used.
     */
    backtestSettings: BacktestSettings;
    /**
     * Compact endpoint-adjusted selection result, present when the compact
     * endpoint-selection path ran (see the `needs.endpointSelection` modes).
     * The IS search uses it as the preferred selection over a rebuilt one.
     */
    endpointSelection?: BacktestEndpointSelection;
}

/**
 * Resolve the `backtestRunOptions` for a candidate run. Pure (given the
 * resolved trade direction, which only `"auto"` endpoint selection consumes)
 * so the parity spec can lock the exact per-needs matrix without executing a
 * backtest.
 */
export function resolveAssetCandidateBacktestRunOptions(
    needs: AssetCandidateBacktestNeeds,
    data: OHLCVData[],
    resolvedTradeDirection: string | undefined,
): NonNullable<BacktestExecutorRequest["backtestRunOptions"]> {
    let endpointEnabled = false;
    let retainTrades = needs.trades;
    if (needs.endpointSelection === "auto") {
        endpointEnabled = resolvedTradeDirection !== "combined";
        if (!endpointEnabled) retainTrades = true;
    } else if (needs.endpointSelection === true) {
        endpointEnabled = true;
    }
    return {
        includeAdvancedAnalytics: false,
        includeSharpeRatio: needs.fullAnalytics,
        useCompactBacktest: needs.compact,
        omitEquityCurve: true,
        skipDrawdown: needs.fullAnalytics !== true,
        requireTradeHistory: retainTrades,
        ...(needs.signalsOnly === true ? { signalsOnly: true } : {}),
        ...(endpointEnabled
            ? {
                endpointSelectionLastDataTime: data[data.length - 1]?.time ?? null,
            }
            : {}),
        skipResultPostProcessing: true,
    };
}

/**
 * Execute one candidate's backtest with the Asset Opportunity run-option
 * matrix. `riskOverrideParams` feeds Finder risk overrides (the runner passes
 * its normalized combined params; the IS search passes its pre-normalized
 * merged params); `strategyParams` is what `executeBacktest` receives (entry
 * params only — the exit override is injected through `backtestSettings`).
 */
export async function runAssetCandidateBacktest(args: {
    data: OHLCVData[];
    symbol: string;
    interval: string;
    strategy: Strategy;
    strategyKey: string;
    strategyParams: StrategyParams;
    riskOverrideParams: StrategyParams;
    settings: BacktestSettings;
    capitalSettings: CapitalSettings;
    options: FinderOptions;
    exitOverride?: AssetCandidateExitOverride;
    dataFetcher?: CrossSymbolDataFetcher;
    useRustEnginePreference?: boolean;
    rustCapabilities?: RustCapabilities;
    rustDiagnosticPhase?: RustDiagnosticPhase;
    signal?: AbortSignal;
    typescriptFallbackGate?: TypescriptFallbackGate;
    typescriptSimulationConcurrency?: TypescriptSimulationConcurrencyTracker;
    /**
     * Closed-candle view the executor should use. Omitted for cross-symbol
     * strategies (the cross-symbol runtime owns its closed view).
     */
    closedCandleDataOverride?: OHLCVData[];
    /** Fully prepared primary signals; skips strategy signal generation. */
    preGeneratedSignals?: Signal[];
    /** Per-asset cache for deterministic Exit Strategy Override signals. */
    exitSignalCache?: AssetCandidateExitSignalCache;
    needs: AssetCandidateBacktestNeeds;
}): Promise<AssetCandidateBacktestOutput> {
    const rustSettings = sanitizeBacktestSettingsForRust(args.settings, args.rustCapabilities);
    const { backtestSettings: riskAdjustedSettings } = resolveFinderRiskOverrides(
        args.settings,
        rustSettings,
        args.riskOverrideParams,
        args.options,
    );
    const backtestSettings: BacktestSettings = args.exitOverride
        ? {
            ...riskAdjustedSettings,
            disableSignalExits: true,
            exitStrategyOverrideEnabled: true,
            exitStrategyKey: args.exitOverride.key,
            exitStrategyParams: { ...(args.exitOverride.params ?? {}) },
        }
        : riskAdjustedSettings;
    const preResolvedSettings = resolveExecutorBacktestSettings(
        { ...(backtestSettings as Record<string, unknown>), interval: args.interval } as BacktestSettings,
        args.interval,
    );
    const preResolvedCapital = resolveCapitalSettingsFromRaw(
        args.capitalSettings as unknown as Record<string, unknown>,
    );
    const backtestRunOptions = resolveAssetCandidateBacktestRunOptions(
        args.needs,
        args.data,
        preResolvedSettings.tradeDirection,
    );
    if (args.needs.endpointSelection === true || args.needs.endpointSelection === "auto") {
        // Only the "auto" path can enable endpoint selection here; the
        // resolved-options builder decides. Attach initial capital so the
        // compact engine's endpoint adjustment is capital-accurate.
        if (backtestRunOptions.endpointSelectionLastDataTime !== undefined) {
            backtestRunOptions.endpointSelectionInitialCapital = preResolvedCapital.initialCapital;
        }
    }
    const output = await executeBacktest({
        ohlcvData: args.data,
        interval: args.interval,
        primarySymbol: args.symbol,
        strategyKey: args.strategyKey,
        strategy: args.strategy,
        strategyParams: args.strategyParams,
        backtestSettings,
        capitalSettings: args.capitalSettings,
        preResolvedSettings,
        preResolvedCapital,
        context: {
            blockRange: null,
            annotatePolymarket: false,
            engineMode: "auto",
            nowSec: Math.floor(Date.now() / 1000),
            useRustEnginePreference: args.useRustEnginePreference,
            rustCapabilities: args.rustCapabilities,
            rustDiagnosticPhase: args.rustDiagnosticPhase ?? "is_candidate",
            signal: args.signal,
            typescriptFallbackGate: args.typescriptFallbackGate,
            typescriptSimulationConcurrency: args.typescriptSimulationConcurrency,
        },
        ...(args.dataFetcher ? { dataFetcher: args.dataFetcher } : {}),
        ...(args.closedCandleDataOverride ? { closedCandleDataOverride: args.closedCandleDataOverride } : {}),
        ...(args.preGeneratedSignals ? { preGeneratedSignals: args.preGeneratedSignals } : {}),
        ...(args.exitSignalCache ? { exitSignalCache: args.exitSignalCache } : {}),
        backtestRunOptions,
    });
    return {
        result: output.result,
        signals: output.signals,
        engineUsed: output.engineUsed,
        engineDiagnostics: output.engineDiagnostics,
        backtestSettings,
        ...(output.endpointSelection ? { endpointSelection: output.endpointSelection } : {}),
    };
}
