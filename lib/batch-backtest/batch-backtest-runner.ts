/**
 * Pure Batch Backtest runner.
 *
 * Runs ONE strategy + ONE param set + ONE backtest/capital settings tuple
 * across many symbols, producing one per-symbol result row per pair. This is
 * NOT a search (Finder does that). It is a deterministic replay of the current
 * UI strategy/params/settings across a symbol list.
 *
 * Reuses `executeBacktest(...)` so fill/exit/capital semantics are identical
 * to the normal Run Backtest button and to Finder's universe runner.
 *
 * Cancellation mirrors Finder universe Pattern B: a boolean flag for the loop
 * head plus an AbortController whose signal is threaded into dataset loads.
 */

import { executeBacktest, resolveExecutorBacktestSettings } from "../backtest-executor";
import { resolveCapitalSettingsFromRaw } from "../backtest-capital-settings";
import { ensureConfirmationStrategiesLoaded } from "../confirmation-signal-filter";
import type {
    BacktestResult,
    BacktestSettings,
    OHLCVData,
    Signal,
    Strategy,
    StrategyParams,
    Time,
} from "../types/strategies";
import type { CapitalSettings } from "../types/backtest";
import { timeKey } from "../strategies";
import { parseTimeToUnixSeconds } from "../time-normalization";
import { parsePortfolioSyntheticPairSymbol } from "../synthetic-pair-parser";
export { parseBatchSymbols } from "./batch-run-contract";

// ============================================================================
// Public types
// ============================================================================

/**
 * Minimum bar count a loaded dataset must reach to be considered usable for a
 * batch backtest. Real Binance datasets are capped at ~65k bars; a dataset well
 * below this threshold is almost always a stale fragment left in the offline
 * cache by a prior streaming/gap-fill session (e.g. 16 bars covering a single
 * day). Running a strategy on such a fragment produces a misleading "No Trades"
 * row, so the runner refuses it and surfaces a load failure instead.
 *
 * 200 is comfortably above every built-in strategy's lookback window (max ~30)
 * and comfortably below any real full-length dataset.
 */
export const BATCH_MIN_USABLE_BARS = 200;

export type BatchBacktestSymbolStatus =
    | "profitable"
    | "losing"
    | "flat"
    | "no_trades"
    | "load_failed"
    | "run_failed"
    // Audit finding (benchmark rows): a slot that was never attempted because
    // the loop broke early on cancel. Distinct from `no_trades` (which means the
    // strategy actually ran and produced zero trades) so the benchmark can
    // classify cancelled tail rows accurately instead of counting them as
    // successfully loaded.
    | "skipped";

export interface BatchBacktestSymbolResult {
    symbol: string;
    status: BatchBacktestSymbolStatus;
    barCount: number;
    firstTime?: Time;
    lastTime?: Time;
    result?: BacktestResult;
    data?: OHLCVData[];
    signals?: Signal[];
    tradeSummary?: BatchBacktestTradeSummary;
    buyHoldPct?: number | null;
    openTradeAssetScores?: { asset: string; score: number }[];
    error?: string;
}

export interface BatchBacktestTradeSummary {
    avgHoldBars: number | null;
    maxHoldBars: number | null;
    avgHoldDays: number | null;
    maxHoldDays: number | null;
    exposurePercent: number | null;
}

export interface BatchBacktestRunInput {
    interval: string;
    strategyKey: string;
    strategy: Strategy;
    strategyParams: StrategyParams;
    backtestSettings: BacktestSettings;
    capitalSettings: CapitalSettings;
    symbols: string[];
    /**
     * Optional verified pair-list provenance (Phase 3 MAX_ACTIVE research).
     * The request carries it from the browser when the textarea matches the
     * generator's emitted hash; the server verifies and retains it on the
     * run snapshot. Optional — older clients / manual pair lists omit it.
     */
    pairListProvenance?: import("./balanced-pair-list-generator").PairListProvenanceV1 | null;
    /**
     * Optional MAX_ACTIVE research registration. Verified against the
     * committed server-side constant; mismatches are retained as
     * manual/unverified metadata and never produce a HOLDOUT verdict.
     */
    maxActiveResearchRegistration?: import("./max-active-research-contract").MaxActiveResearchRegistrationV1 | null;
    /**
     * Server-side Rust engine opt-in. Mirrors the browser DOM toggle so the
     * server-side path can use the Rust engine when the user has it enabled.
     * Browser callers leave this undefined; `engineMode: "auto"` falls back to
     * `shouldUseRustEngine()` (DOM toggle) in the executor. See
     * `shouldAttemptRust` in `lib/backtest-executor.ts` for the full rationale.
     */
    useRustEnginePreference?: boolean;
    /** Loads one symbol's OHLCV series without touching the live chart. */
    loadDataset: (symbol: string, interval: string, signal?: AbortSignal) => Promise<OHLCVData[]>;
    /**
     * Minimum bar count for a loaded dataset to be considered usable. Loads
     * that return a positive but smaller number of bars (typical of a stale
     * streaming gap-fill fragment held in the offline cache) are reported as
     * `load_failed` instead of silently running a degenerate backtest.
     *
     * Defaults to {@link BATCH_MIN_USABLE_BARS}. Tests may inject a smaller
     * value to keep deterministic fixtures compact.
     */
    minUsableBars?: number;
    /**
     * Store scalar-only rows in the returned `results` array after
     * `onSymbolComplete` has seen the full row. Server-side Batch uses this so
     * completed rows can be garbage-collected during very large runs.
     */
    pruneResultArtifacts?: boolean;
}

export interface BatchBacktestRunCallbacks {
    setProgress: (percent: number, text: string) => void;
    setStatus: (text: string) => void;
    /**
     * Allowed to return a Promise. The runner awaits it before starting the
     * next symbol so a slow consumer (e.g. server-side artifact persistence)
     * can apply backpressure instead of unbounded queueing (audit Finding 2).
     * Synchronous return values remain valid; the await is a no-op for them.
     */
    onSymbolComplete?: (index: number, result: BatchBacktestSymbolResult) => void | Promise<void>;
    /**
     * Fired once per attempted symbol at the top of the iteration, before
     * load/backtest. Lets a caller (the server-side plugin) surface which pair
     * is currently active for reattach UI. Skipped on cancel-bail at the loop
     * head. Fires for every symbol the runner actually attempts, including
     * `load_failed` / `run_failed` branches.
     */
    onSymbolStart?: (index: number, symbol: string) => void;
    isCancelled: () => boolean;
}

export interface BatchBacktestRunOutput {
    results: BatchBacktestSymbolResult[];
    loadedSymbols: number;
    failedSymbols: string[];
}

// ============================================================================
// Public API
// ============================================================================

export async function runBatchBacktest(
    input: BatchBacktestRunInput,
    callbacks: BatchBacktestRunCallbacks,
): Promise<BatchBacktestRunOutput> {
    const symbols = input.symbols;
    const total = Math.max(1, symbols.length);
    const results: BatchBacktestSymbolResult[] = new Array(symbols.length);
    const failedSymbols: string[] = [];
    let loadedSymbols = 0;

    const abort = new AbortController();
    const nowSec = Math.floor(Date.now() / 1000);
    const cancelCheck = () => callbacks.isCancelled();
    // Settings + capital are identical for every item in a batch (the contract
    // is "read once, replay everywhere"). Resolve them once so executeBacktest
    // skips per-item normalization (mirrors Finder universe's IS path).
    const preResolvedSettings = resolveExecutorBacktestSettings(
        { ...(input.backtestSettings as Record<string, unknown>), interval: input.interval } as BacktestSettings,
        input.interval,
    );
    await ensureConfirmationStrategiesLoaded(preResolvedSettings);
    const preResolvedCapital = resolveCapitalSettingsFromRaw(input.capitalSettings as unknown as Record<string, unknown>);
    const minUsableBars = Math.max(1, Math.floor(input.minUsableBars ?? BATCH_MIN_USABLE_BARS));

    // Prefetch window: kick off dataset loads ahead of the serial consumer so
    // I/O overlaps with the current backtest's CPU work. Execution stays serial
    // (no engine contention); only loads are pipelined, and onSymbolComplete
    // still fires in strict input order because the consumer loop is serial.
    // The Finder universe runner parallelizes loads the same way via
    // mapWithConcurrencyLimit.
    const PREFETCH_AHEAD = 4;
    const inflight: Promise<OHLCVData[]>[] = [];
    const startPrefetch = (idx: number) => {
        // The promise is consumed by the serial loop in order. Attach a
        // no-op catch so that if the loop breaks early on cancel (leaving
        // up to PREFETCH_AHEAD promises unawaited) and one of them later
        // rejects on a network error, it doesn't surface as an unhandled
        // rejection. The consumer path handles errors itself via try/catch.
        const p = input.loadDataset(symbols[idx], input.interval, abort.signal);
        p.catch(() => { /* abandoned prefetch; error surfaced by consumer path */ });
        inflight.push(p);
    };
    for (let p = 0; p < Math.min(PREFETCH_AHEAD, symbols.length); p += 1) {
        startPrefetch(p);
    }

    for (let i = 0; i < symbols.length; i += 1) {
        if (cancelCheck()) {
            abort.abort();
            break;
        }

        const symbol = symbols[i];
        callbacks.onSymbolStart?.(i, symbol);
        callbacks.setProgress((i / total) * 100, `Running ${symbol} (${i + 1}/${total})...`);
        callbacks.setStatus(`Backtesting ${symbol}...`);

        // The prefetched load for this index sits at the head of the window.
        // (Loads are started and consumed strictly in increasing index order,
        // so inflight[0] always corresponds to i.)
        const loadPromise = inflight.shift()!;

        let data: OHLCVData[] = [];
        try {
            data = await loadPromise;
            if (cancelCheck() || abort.signal.aborted) break;
            if (!Array.isArray(data) || data.length === 0) {
                const failure: BatchBacktestSymbolResult = {
                    symbol,
                    status: "load_failed",
                    barCount: 0,
                    error: "No candles returned.",
                };
                results[i] = failure;
                failedSymbols.push(symbol);
                await callbacks.onSymbolComplete?.(i, failure);
                // Refill the prefetch window before continuing.
                const nextIdx = i + PREFETCH_AHEAD;
                if (nextIdx < symbols.length) startPrefetch(nextIdx);
                continue;
            }
            // Refuse an implausibly small fragment. The offline cache can hold
            // a handful of bars left over from a prior streaming/gap-fill
            // session (e.g. 16 bars spanning a single day); backtesting on that
            // is meaningless and historically surfaced as a confusing "No
            // Trades" row. Treat it as a load failure with an explicit reason.
            if (data.length < minUsableBars) {
                const failure: BatchBacktestSymbolResult = {
                    symbol,
                    status: "load_failed",
                    barCount: data.length,
                    firstTime: data[0]?.time,
                    lastTime: data[data.length - 1]?.time,
                    error: `Insufficient bars (${data.length} < ${minUsableBars}); likely a stale cache fragment. Reload the pair on the chart to refresh.`,
                };
                results[i] = failure;
                failedSymbols.push(symbol);
                await callbacks.onSymbolComplete?.(i, failure);
                const nextIdx = i + PREFETCH_AHEAD;
                if (nextIdx < symbols.length) startPrefetch(nextIdx);
                continue;
            }
            loadedSymbols += 1;
        } catch (error) {
            if (cancelCheck()) {
                abort.abort();
                break;
            }
            const message = error instanceof Error ? error.message : String(error);
            const failure: BatchBacktestSymbolResult = {
                symbol,
                status: "load_failed",
                barCount: 0,
                error: message,
            };
            results[i] = failure;
            failedSymbols.push(symbol);
            await callbacks.onSymbolComplete?.(i, failure);
            const nextIdx = i + PREFETCH_AHEAD;
            if (nextIdx < symbols.length) startPrefetch(nextIdx);
            continue;
        }

        // Kick off the next prefetch BEFORE the backtest so the load overlaps
        // with execution.
        const nextIdx = i + PREFETCH_AHEAD;
        if (nextIdx < symbols.length) startPrefetch(nextIdx);

        try {
            const output = await executeBacktest({
                ohlcvData: data,
                interval: input.interval,
                primarySymbol: symbol,
                strategyKey: input.strategyKey,
                strategy: input.strategy,
                strategyParams: input.strategyParams,
                backtestSettings: input.backtestSettings,
                capitalSettings: input.capitalSettings,
                preResolvedSettings,
                preResolvedCapital,
                context: {
                    blockRange: null,
                    annotatePolymarket: false,
                    engineMode: "auto",
                    useRustEnginePreference: input.useRustEnginePreference,
                    nowSec,
                },
                backtestRunOptions: {
                    includeAdvancedAnalytics: false,
                    omitEquityCurve: true,
                    skipDrawdown: false,
                    skipResultPostProcessing: true,
                },
            });
            if (cancelCheck()) break;
            const result = buildSymbolResult(symbol, data, output.result, output.signals);
            await callbacks.onSymbolComplete?.(i, result);
            results[i] = input.pruneResultArtifacts ? pruneResultArtifacts(result) : result;
        } catch (error) {
            if (cancelCheck()) break;
            const message = error instanceof Error ? error.message : String(error);
            const failure: BatchBacktestSymbolResult = {
                symbol,
                status: "run_failed",
                barCount: data.length,
                firstTime: data[0]?.time,
                lastTime: data[data.length - 1]?.time,
                error: message,
            };
            results[i] = failure;
            failedSymbols.push(symbol);
            await callbacks.onSymbolComplete?.(i, failure);
        }
    }

    callbacks.setProgress(100, "Done");
    callbacks.setStatus("Idle");

    // Fill any unset slots (loop broke early on cancel) so the array is dense.
    for (let i = 0; i < results.length; i += 1) {
        if (!results[i]) {
            results[i] = {
                symbol: symbols[i],
                // Distinct from `no_trades`: this slot was never attempted, so
                // the benchmark must not count it as successfully loaded.
                status: "skipped",
                barCount: 0,
                error: "Skipped (cancelled).",
            };
        }
    }

    return {
        results,
        loadedSymbols,
        failedSymbols,
    };
}

function pruneResultArtifacts(row: BatchBacktestSymbolResult): BatchBacktestSymbolResult {
    return {
        ...row,
        data: undefined,
        signals: undefined,
        result: row.result ? { ...row.result, trades: [] } : undefined,
    };
}

// ============================================================================
// Internal helpers
// ============================================================================

function buildSymbolResult(
    symbol: string,
    data: OHLCVData[],
    result: BacktestResult,
    signals: Signal[],
): BatchBacktestSymbolResult {
    let status: BatchBacktestSymbolStatus;
    if (result.totalTrades <= 0) {
        status = "no_trades";
    } else if (result.netProfit > 0.0001) {
        status = "profitable";
    } else if (result.netProfit < -0.0001) {
        status = "losing";
    } else {
        status = "flat";
    }

    // `signals` is retained only on synthetic pair rows because server-side
    // analysis features (OPEN_SCORE USD Replay) consume the retained
    // per-row artifacts (parsePortfolioSyntheticPairSymbol gates which rows
    // are eligible). For non-synthetic rows the array has no remaining reader,
    // so drop it to free the per-row Signal[] allocation across large batches.
    const isSyntheticPair = parsePortfolioSyntheticPairSymbol(symbol) !== null;

    return {
        symbol,
        status,
        barCount: data.length,
        firstTime: data[0]?.time,
        lastTime: data[data.length - 1]?.time,
        result,
        data,
        signals: isSyntheticPair ? signals : undefined,
        tradeSummary: buildTradeSummary(data, result),
    };
}

function buildTradeSummary(
    data: OHLCVData[],
    result: BacktestResult,
): BatchBacktestTradeSummary {
    const timeIndex = new Map<string, number>();
    data.forEach((bar, index) => {
        timeIndex.set(timeKey(bar.time), index);
    });

    // Single pass over trades accumulating count / sum / max for both hold-bars
    // and hold-days. Avoids the prior per-trade `number[]` allocations and the
    // `Math.max(...holdBars)` spread, which throws RangeError above ~120k trades
    // (dense-trade strategies can exceed that). The hold-days pool may be
    // smaller than the hold-bars pool when a trade's timestamps don't parse,
    // so it carries its own count.
    let holdBarsCount = 0;
    let totalHoldBars = 0;
    let maxHoldBars = Number.NEGATIVE_INFINITY;
    let holdDaysCount = 0;
    let totalHoldDays = 0;
    let maxHoldDays = Number.NEGATIVE_INFINITY;
    for (const trade of result.trades) {
        const entryIndex = timeIndex.get(timeKey(trade.entryTime));
        const exitIndex = timeIndex.get(timeKey(trade.exitTime));
        if (entryIndex === undefined || exitIndex === undefined || exitIndex < entryIndex) {
            continue;
        }
        const bars = exitIndex - entryIndex;
        holdBarsCount += 1;
        totalHoldBars += bars;
        if (bars > maxHoldBars) maxHoldBars = bars;

        const entrySec = parseTimeToUnixSeconds(trade.entryTime);
        const exitSec = parseTimeToUnixSeconds(trade.exitTime);
        if (entrySec !== null && exitSec !== null && exitSec >= entrySec) {
            const days = (exitSec - entrySec) / 86_400;
            holdDaysCount += 1;
            totalHoldDays += days;
            if (days > maxHoldDays) maxHoldDays = days;
        }
    }

    if (holdBarsCount === 0) {
        return {
            avgHoldBars: null,
            maxHoldBars: null,
            avgHoldDays: null,
            maxHoldDays: null,
            exposurePercent: null,
        };
    }

    return {
        avgHoldBars: totalHoldBars / holdBarsCount,
        maxHoldBars,
        avgHoldDays: holdDaysCount > 0 ? totalHoldDays / holdDaysCount : null,
        maxHoldDays: holdDaysCount > 0 ? maxHoldDays : null,
        exposurePercent: Math.min(100, (totalHoldBars / Math.max(1, data.length - 1)) * 100),
    };
}
