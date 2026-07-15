/**
 * Universe out-of-sample validation pass, extracted as a leaf module so the
 * server-owned Finder job can run OOS in Node without importing the
 * browser-bound `FinderManager`.
 *
 * This is a faithful lift of the prior private
 * `FinderManager.applyUniverseOosValidationIfNeeded` body (and the
 * `backtestResultToUniverseMetrics` helper). All runtime dependencies are
 * injected: candidates, resolved strategies, settings, capital settings,
 * interval, data loader, provider resolver, Rust preference, cancellation
 * callback, progress callback, and yield callback. The module reads no
 * browser DOM, no `state`, no `backtestService`, and no `dataManager`.
 *
 * Behavior preserved 1:1 (see the prior method for the rationale of each
 * step):
 *   - early-exit when OOS is disabled, no OOS slice resolves, or no survivors
 *   - per-candidate: resolve entry+exit strategies, risk overrides, executor
 *     settings (with interval forced in), and the cross-symbol data fetcher
 *   - per-symbol: skip load_failed/run_failed rows, load the OOS slice, run
 *     `executeBacktest` with the lightweight result options
 *     (omitEquityCurve / skipDrawdown / skipResultPostProcessing, no advanced
 *     analytics), attach `oosResult` + `oosVerdict`; on throw, mark
 *     inconclusive and continue
 *   - per-candidate aggregate + score refresh
 *   - filter out aggregate failures, re-sort, slice to topN (mutates the
 *     results array in place like the prior method did)
 *
 * Leaf import hygiene: only depends on type imports plus the existing
 * `./finder-universe-metrics`, `./finder-runner-core`,
 * `./exit-strategy-param-prefix`, `../backtest-executor`,
 * `../backtest-capital-settings`, `../rust-settings-sanitizer`, and
 * `./finder-manager-logic` helpers — none of which transitively reach
 * `lightweight-charts`, so this module is safe for the Vite config bundle.
 */

import type { OHLCVData, BacktestResult, BacktestSettings, Strategy } from "../types/strategies";
import type { CapitalSettings } from "../types/backtest";
import type {
    FinderDataSlice,
    FinderOptions,
    FinderUniverseCandidate,
    FinderUniverseSymbolMetrics,
} from "../types/finder";
import {
    computeUniverseOosAggregate,
    computeUniverseSymbolOosVerdict,
    sortFinderUniverseCandidates,
    updateFinderUniverseCandidateScores,
} from "./finder-universe-metrics";
import { resolveFinderRiskOverrides } from "./finder-runner-core";
import { withExitStrategyBaseParams, splitExitStrategyParams } from "./exit-strategy-param-prefix";
import { executeBacktest, resolveExecutorBacktestSettings } from "../backtest-executor";
import { resolveCapitalSettingsFromRaw } from "../backtest-capital-settings";
import { sanitizeBacktestSettingsForRust } from "../rust-settings-sanitizer";
import { resolveOosDataSlice, sliceFinderDataWindow } from "./finder-manager-logic";

/**
 * Per-symbol trade floor for the Universe OOS pass. Mirrors the IS intent
 * without reusing the cross-strategy `minTrades` knob. Kept as a module
 * constant (not an option) to match the prior hardcoded value exactly.
 */
const UNIVERSE_OOS_PER_SYMBOL_MIN_TRADES = 5;

/**
 * Map a `BacktestResult` into the scalar `FinderUniverseSymbolMetrics`
 * shape attached to per-symbol OOS results. Lifted verbatim from the prior
 * `FinderManager.backtestResultToUniverseMetrics`.
 */
export function backtestResultToUniverseMetrics(result: BacktestResult): FinderUniverseSymbolMetrics {
    return {
        netProfit: result.netProfit,
        netProfitPercent: result.netProfitPercent,
        expectancy: result.expectancy,
        avgTrade: result.avgTrade,
        winRate: result.winRate,
        profitFactor: result.profitFactor,
        totalTrades: result.totalTrades,
        maxDrawdownPercent: result.maxDrawdownPercent,
        winningTrades: result.winningTrades,
        losingTrades: result.losingTrades,
        avgWin: result.avgWin,
        avgLoss: result.avgLoss,
        sharpeRatio: result.sharpeRatio,
    };
}

/**
 * Resolved entry strategy lookup keyed by strategy key. Built once by the
 * caller from the selected strategies; the OOS pass uses it to resolve the
 * `Strategy` for each candidate without re-reading browser state.
 */
export type UniverseOosStrategyLookup = Map<string, Strategy>;

export interface UniverseOosDeps {
    /** Finalized IS survivors (topN). Mutated in place: OOS fields attached,
     * aggregate failures removed, re-sorted + sliced to topN. */
    results: FinderUniverseCandidate[];
    /** Resolved entry strategies, keyed by strategy key. */
    strategyByKey: UniverseOosStrategyLookup;
    /** Base backtest settings (IS settings, before risk overrides). */
    settings: BacktestSettings;
    /** Finder options (sort priority, topN, minActiveSymbols, dataSlice). */
    options: FinderOptions;
    /** Capital settings (identical for every OOS candidate × symbol). */
    capitalSettings: CapitalSettings;
    /** Current chart interval (forced into pre-resolved executor settings). */
    interval: string;
    /**
     * Load the RAW OOS dataset for a symbol+interval. The caller applies the
     * OOS data slice (`resolveOosDataSlice` + `sliceFinderDataWindow`)
     * EXACTLY ONCE here; this module does not re-slice. Returns `[]` on load
     * failure so the symbol is skipped (matching the prior `loadOosData`
     * closure which cached `[]` on error).
     */
    loadOosData: (symbol: string, interval: string) => Promise<OHLCVData[]>;
    /**
     * Provider label resolver for cross-symbol strategies. Mirrors the
     * browser `dataManager.getProvider` (server callers pass the
     * `providerBySymbol`-backed resolver).
     */
    getProvider?: (symbol: string) => string;
    /** Rust preference threaded into `executeBacktest` context. */
    useRustEnginePreference?: boolean;
    /** Cooperative cancellation — polled per candidate and per symbol. */
    isCancelled: () => boolean;
    /** Progress reporter (percent 0-100, status text). */
    onProgress: (percent: number, text: string) => void;
    /** Yield to the event loop between symbols (server) / to the browser. */
    yieldControl: () => Promise<void>;
}

/**
 * Result of the OOS pass: the number of candidates removed by the aggregate
 * `fail` filter. The `results` array passed in `deps` is mutated in place.
 */
export interface UniverseOosResult {
    oosRemoved: number;
    cancelled: boolean;
}

/**
 * Run the per-symbol Universe OOS pass over finalized IS survivors.
 *
 * Mirrors `FinderManager.applyUniverseOosValidationIfNeeded` exactly. Returns
 * the number of candidates removed by the aggregate `fail` filter; the
 * `deps.results` array is mutated in place (OOS fields attached, failures
 * filtered out, survivors re-sorted + sliced to topN).
 */
export async function runUniverseOosPass(deps: UniverseOosDeps): Promise<UniverseOosResult> {
    const { results, options } = deps;
    if (!options.oosValidationEnabled) {
        return { oosRemoved: 0, cancelled: false };
    }
    const oosSlice = resolveOosDataSlice(options.dataSlice ?? "all");
    if (!oosSlice) {
        return { oosRemoved: 0, cancelled: false };
    }
    if (results.length === 0) {
        return { oosRemoved: 0, cancelled: false };
    }

    const minActiveSymbols = options.universe?.minActiveSymbols ?? 1;
    const perSymbolMinTrades = UNIVERSE_OOS_PER_SYMBOL_MIN_TRADES;
    const rustSettings = sanitizeBacktestSettingsForRust(deps.settings);
    const preResolvedCapital = resolveCapitalSettingsFromRaw(
        deps.capitalSettings as unknown as Record<string, unknown>,
    );
    const runNowSec = Math.floor((Date.now()) / 1000);

    deps.onProgress(0, "Validating universe survivors out-of-sample...");

    let cancelled = false;

    for (let candidateIndex = 0; candidateIndex < results.length; candidateIndex += 1) {
        if (deps.isCancelled()) {
            cancelled = true;
            break;
        }
        const candidate = results[candidateIndex]!;
        deps.onProgress(
            (candidateIndex / results.length) * 100,
            `OOS validation ${candidateIndex + 1}/${results.length}: ${candidate.strategyName}`,
        );

        const strategy = deps.strategyByKey.get(candidate.strategyKey);
        if (!strategy) {
            candidate.oosAggregate = {
                verdict: "inconclusive",
                activeSymbols: 0,
                profitableSymbols: 0,
                profitableActiveRatio: 0,
                worstNetProfit: 0,
            };
            continue;
        }
        // Match the universe IS path: split exit params out and inject the
        // exit descriptor into per-candidate backtest settings.
        const combinedParams = withExitStrategyBaseParams(candidate.params, candidate.exitStrategyParams ?? {});
        const { entryParams } = candidate.exitStrategyKey
            ? splitExitStrategyParams(combinedParams)
            : { entryParams: combinedParams };
        const { backtestSettings: riskAdjustedSettings } = resolveFinderRiskOverrides(
            deps.settings,
            rustSettings,
            combinedParams,
            options,
        );
        const oosBacktestSettings: BacktestSettings = candidate.exitStrategyKey
            ? {
                ...riskAdjustedSettings,
                disableSignalExits: true,
                exitStrategyOverrideEnabled: true,
                exitStrategyKey: candidate.exitStrategyKey,
                exitStrategyParams: { ...(candidate.exitStrategyParams ?? {}) },
            }
            : riskAdjustedSettings;
        const preResolvedSettings = resolveExecutorBacktestSettings(
            { ...(oosBacktestSettings as Record<string, unknown>), interval: deps.interval } as BacktestSettings,
            deps.interval,
        );
        const crossSymbolDataFetcher = strategy.crossSymbolConfig
            ? {
                getProvider: deps.getProvider ?? (() => "binance"),
                fetchDataDetached: deps.loadOosData,
            }
            : undefined;

        for (const symbolResult of candidate.symbols) {
            if (deps.isCancelled()) {
                cancelled = true;
                break;
            }
            if (symbolResult.status === "load_failed" || symbolResult.status === "run_failed") {
                continue;
            }
            const oosData = await deps.loadOosData(symbolResult.symbol, deps.interval);
            if (oosData.length === 0) continue;

            try {
                const output = await executeBacktest({
                    ohlcvData: oosData,
                    interval: deps.interval,
                    primarySymbol: symbolResult.symbol,
                    strategyKey: candidate.strategyKey,
                    strategy,
                    strategyParams: entryParams,
                    backtestSettings: oosBacktestSettings,
                    capitalSettings: deps.capitalSettings,
                    preResolvedSettings,
                    preResolvedCapital,
                    dataFetcher: crossSymbolDataFetcher,
                    context: {
                        blockRange: null,
                        annotatePolymarket: false,
                        engineMode: "auto",
                        nowSec: runNowSec,
                        useRustEnginePreference: deps.useRustEnginePreference,
                    },
                    backtestRunOptions: {
                        includeAdvancedAnalytics: false,
                        omitEquityCurve: true,
                        skipDrawdown: true,
                        skipResultPostProcessing: true,
                    },
                });
                const oosMetrics = backtestResultToUniverseMetrics(output.result);
                symbolResult.oosResult = oosMetrics;
                symbolResult.oosVerdict = computeUniverseSymbolOosVerdict({
                    oosNetProfit: oosMetrics.netProfit,
                    oosProfitFactor: oosMetrics.profitFactor,
                    oosTotalTrades: oosMetrics.totalTrades,
                    minTrades: perSymbolMinTrades,
                });
            } catch {
                symbolResult.oosResult = undefined;
                symbolResult.oosVerdict = "inconclusive";
            }
            await deps.yieldControl();
        }

        candidate.oosAggregate = computeUniverseOosAggregate({
            symbols: candidate.symbols,
            isProfitableActiveRatio: candidate.profitableActiveRatio,
            minActiveSymbols,
        });
        updateFinderUniverseCandidateScores(candidate);
    }

    const initialCount = results.length;
    const survivors = results.filter((candidate) => candidate.oosAggregate?.verdict !== "fail");
    const removedCount = initialCount - survivors.length;
    // Always re-publish + re-sort after the OOS pass: even when nothing is
    // filtered out, per-symbol oosResult/oosAggregate were attached and the
    // caller must re-render so OOS chips/badges appear. The caller owns the
    // actual publish/render step; this module only mutates the array.
    if (removedCount > 0) {
        results.length = 0;
        results.push(...survivors);
    }
    const sortedResults = sortFinderUniverseCandidates(
        results,
        options.universe?.sortPriority ?? [],
    ).slice(0, options.topN);
    results.length = 0;
    results.push(...sortedResults);
    return { oosRemoved: removedCount, cancelled };
}

/**
 * Resolve the OOS data slice string for a given data-slice mode, for callers
 * that need to apply it once at their loader wrapper. Re-exported so the
 * server plugin does not import `finder-manager-logic` directly for this one
 * constant (it already imports `sliceFinderDataWindow` for IS slicing).
 */
export function resolveUniverseOosSlice(dataSlice: FinderDataSlice | undefined): FinderDataSlice | null {
    return resolveOosDataSlice(dataSlice ?? "all");
}

/** Apply the OOS data slice to a raw dataset. */
export function applyUniverseOosSlice(data: OHLCVData[], oosSlice: FinderDataSlice): OHLCVData[] {
    return sliceFinderDataWindow(data, oosSlice);
}

// Re-export the verdict type for callers that need to read OOS outcomes.
