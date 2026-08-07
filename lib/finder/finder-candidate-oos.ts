/**
 * Current-chart candidate out-of-sample gate, extracted as a leaf module so
 * both the browser `FinderManager` and the Asset Opportunity server job can
 * run the identical OOS pass without duplicating its semantics.
 *
 * This is a faithful lift of the prior private
 * `FinderManager.applyOosValidationIfNeeded` body. All runtime dependencies
 * are injected: candidates, resolved strategies, exit-strategy candidates,
 * settings, capital settings, interval, OOS window data, cancellation,
 * progress, and yield callbacks. The module reads no browser DOM, no `state`,
 * no `backtestService`, and no `dataManager`.
 *
 * Behavior preserved 1:1 from the prior method:
 *   - early-exit (returns `{ oosRemoved: 0 }`) when OOS is disabled, no OOS
 *     slice resolves, no candidates, or empty OOS window
 *   - per-candidate: resolve strategy + exit strategy, build a ParamJob, run
 *     `generateSignalsForJob` + `runStrategyBacktest` on the OOS window data,
 *     attach `oosResult` + `oosVerdict`; on throw, mark inconclusive
 *   - filter out `fail` verdicts and return the survivors + removed count.
 *
 * Leaf import hygiene: only depends on type imports plus the existing
 * `./finder-runner-shared`, `./finder-runner-core`, `./exit-strategy-param-prefix`,
 * `./finder-manager-logic`, `../rust-settings-sanitizer`, and
 * `../strategies/index` helpers — none of which transitively reach
 * `lightweight-charts`, so this module is safe for the Vite config bundle.
 */

import type { OHLCVData, BacktestResult, BacktestSettings, Strategy, StrategyParams } from "../types/strategies";
import type { CapitalSettings } from "../types/backtest";
import type { FinderOptions, FinderResult, FinderOosVerdict } from "../types/finder";
import { precomputeIndicators, runBacktest } from "../strategies/index";
import { sanitizeBacktestSettingsForRust } from "../rust-settings-sanitizer";
import {
    resolveFinderRiskOverrides,
    resolveFinderCandidateBacktestSettings,
    normalizeFinderCandidateParams,
    type FinderPreparedDataCache,
} from "./finder-runner-core";
import {
    generateSignalsForJob,
    runStrategyBacktest,
    type ParamJob,
} from "./finder-runner-shared";
import { withExitStrategyBaseParams } from "./exit-strategy-param-prefix";
import {
    computeFinderOosVerdict,
    resolveOosDataSlice,
    sliceFinderDataWindow,
} from "./finder-manager-logic";

/**
 * Strategy + exit-strategy resolution for the candidate OOS pass. Built once by
 * the caller from the selected strategies; the OOS pass uses it to resolve the
 * `Strategy` for each candidate without re-reading browser state.
 */
export interface CandidateOosStrategyLookup {
    /** Resolved entry strategies, keyed by strategy key. */
    strategyByKey: Map<string, Strategy>;
    /** Optional pre-loaded exit-strategy candidates. */
    exitStrategyByKey?: Map<string, Strategy>;
}

export interface CandidateOosDeps extends CandidateOosStrategyLookup {
    /** Top-N survivors (already sorted). Mutated in place: OOS fields attached. */
    results: FinderResult[];
    /** Base backtest settings (IS settings, before risk overrides). */
    settings: BacktestSettings;
    /** Finder options (sort priority, topN, minTrades, dataSlice). */
    options: FinderOptions;
    /** Capital settings (identical for every OOS candidate). */
    capitalSettings: CapitalSettings;
    /** Current chart interval (used for prepared-data cache + signal generation). */
    interval: string;
    /**
     * OOS window data — the complementary half of the data window. The caller
     * computes this once via `resolveOosDataSlice` + `sliceFinderDataWindow`
     * plus `buildFinderEvaluationData`; this module does not re-slice.
     */
    oosData: OHLCVData[];
    /** Cooperative cancellation — polled per candidate. */
    isCancelled: () => boolean;
    /** Progress reporter (percent 0-100, status text). */
    onProgress: (percent: number, text: string) => void;
    /** Yield to the event loop between candidates. */
    yieldControl: () => Promise<void>;
}

export interface CandidateOosResult {
    /** Survivors (the input array, filtered in place). */
    filtered: FinderResult[];
    /** Number of candidates removed by the `fail` filter. */
    removedCount: number;
    /** True iff the OOS gate was applicable (toggle on, half-window, etc.). */
    applied: boolean;
}

/**
 * Run the candidate OOS pass over finalized IS survivors, mirroring the prior
 * `FinderManager.applyOosValidationIfNeeded` exactly. Returns the survivors +
 * removed count; the `deps.results` array is filtered in place. Returns
 * `{ applied: false }` when the gate is not applicable.
 */
export async function runCandidateOosPass(deps: CandidateOosDeps): Promise<CandidateOosResult> {
    const { results, options, settings } = deps;
    const dataSlice = options.dataSlice ?? "all";
    if (!options.oosValidationEnabled) {
        return { filtered: results, removedCount: 0, applied: false };
    }
    const oosSlice = resolveOosDataSlice(dataSlice);
    if (!oosSlice) {
        return { filtered: results, removedCount: 0, applied: false };
    }
    if (results.length === 0) {
        return { filtered: results, removedCount: 0, applied: true };
    }
    if (deps.oosData.length === 0) {
        return { filtered: results, removedCount: 0, applied: true };
    }

    const rustSettings = sanitizeBacktestSettingsForRust(settings);
    const precomputed = precomputeIndicators(deps.oosData, settings);
    const minTrades = options.tradeFilterEnabled ? options.minTrades : 0;
    // Reuse prepared Finder data across OOS survivors (mirrors the IS path in
    // finder-runner-single.ts). Without this, generateSignalsForJob falls back
    // to executeBacktestStrategySignals and re-does any strategy-internal
    // indicator math that prepareFinderData was designed to hoist.
    const preparedDataCache: FinderPreparedDataCache = new WeakMap();

    deps.onProgress(0, "Validating survivors out-of-sample...");

    for (let candidateIndex = 0; candidateIndex < results.length; candidateIndex += 1) {
        if (deps.isCancelled()) break;
        const candidate = results[candidateIndex]!;
        deps.onProgress(
            (candidateIndex / results.length) * 100,
            `OOS validation ${candidateIndex + 1}/${results.length}: ${candidate.name}`,
        );
        const strategy = deps.strategyByKey.get(candidate.key);
        if (!strategy) {
            candidate.oosVerdict = "inconclusive";
            continue;
        }
        try {
            const exitStrategy = candidate.exitStrategyKey
                ? deps.exitStrategyByKey?.get(candidate.exitStrategyKey)
                : undefined;
            const combinedParams = withExitStrategyBaseParams(
                candidate.params,
                candidate.exitStrategyParams ?? {},
            );
            const normalizedParams = injectNormalizedParams(strategy, combinedParams, exitStrategy);
            const { backtestSettings } = resolveFinderRiskOverrides(settings, rustSettings, normalizedParams, options);
            const job: ParamJob = {
                id: 0,
                key: candidate.key,
                name: candidate.name,
                params: normalizedParams,
                backtestSettings,
                rustBacktestSettings: sanitizeBacktestSettingsForRust(backtestSettings),
                strategy,
                ...(candidate.exitStrategyKey && exitStrategy
                    ? { exitStrategy, exitStrategyKey: candidate.exitStrategyKey }
                    : {}),
            };
            const signals = generateSignalsForJob(job, deps.oosData, deps.interval, preparedDataCache, settings);
            const oosResult = runStrategyBacktest({
                strategy,
                data: deps.oosData,
                signals,
                params: normalizedParams,
                capitalSettings: deps.capitalSettings,
                backtestSettings: resolveFinderCandidateBacktestSettings(backtestSettings, undefined),
                backtestFn: runBacktest,
                precomputed,
                ...(exitStrategy ? { exitStrategy } : {}),
            });
            candidate.oosResult = oosResult;
            candidate.oosVerdict = computeFinderOosVerdict({
                oosNetProfit: oosResult.netProfit,
                oosProfitFactor: oosResult.profitFactor,
                oosTotalTrades: oosResult.totalTrades,
                minTrades,
            });
        } catch {
            candidate.oosResult = undefined;
            candidate.oosVerdict = "inconclusive";
        }
        await deps.yieldControl();
    }

    const filtered = results.filter((candidate) => candidate.oosVerdict !== "fail");
    return { filtered, removedCount: results.length - filtered.length, applied: true };
}

/**
 * Resolve candidate params through the entry strategy's normalizer (and the
 * exit strategy's normalizer when Exit Strategy Override is active). Lifted from
 * the inline call in the prior method body.
 */
function injectNormalizedParams(
    strategy: Strategy,
    combinedParams: StrategyParams,
    exitStrategy?: Strategy,
): StrategyParams {
    if (!strategy.normalizeParams && !exitStrategy?.normalizeParams) {
        return combinedParams;
    }
    return normalizeFinderCandidateParams(
        strategy,
        combinedParams,
        exitStrategy?.normalizeParams ? { normalizeExitParams: exitStrategy.normalizeParams } : undefined,
    );
}

/**
 * Resolve the OOS window data for the current-chart candidate pass. Caller-side
 * convenience wrapper that mirrors the exact OOS data resolution the prior
 * `applyOosValidationIfNeeded` used (slice the block-sliced data, then take
 * execution-aware closed candles). Returns `null` when the OOS slice is not
 * applicable.
 */
export function buildCandidateOosWindowData(args: {
    blockSlicedData: OHLCVData[];
    dataSlice: FinderOptions["dataSlice"];
    interval: string;
    settings: BacktestSettings;
    buildClosedData: (windowData: OHLCVData[], interval: string, settings: BacktestSettings) => OHLCVData[];
}): OHLCVData[] | null {
    const { blockSlicedData, dataSlice, interval, settings, buildClosedData } = args;
    const oosSlice = resolveOosDataSlice(dataSlice ?? "all");
    if (!oosSlice) return null;
    const oosWindowData = sliceFinderDataWindow(blockSlicedData, oosSlice);
    return buildClosedData(oosWindowData, interval, settings);
}

/**
 * Convenience: derive a verdict from a raw OOS BacktestResult. Mirrors the
 * exact gate the in-loop path uses, for callers that compute their own OOS
 * result outside the per-candidate loop (Asset Opportunity server pass).
 */
export function deriveCandidateOosVerdict(args: {
    oosResult: BacktestResult;
    minTrades: number;
}): FinderOosVerdict {
    return computeFinderOosVerdict({
        oosNetProfit: args.oosResult.netProfit,
        oosProfitFactor: args.oosResult.profitFactor,
        oosTotalTrades: args.oosResult.totalTrades,
        minTrades: args.minTrades,
    });
}
