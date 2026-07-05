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
import { parsePortfolioSyntheticPairSymbol } from "../portfolioLab/portfolio-lab-synthetic";

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
    | "run_failed";

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
}

export interface BatchBacktestRunCallbacks {
    setProgress: (percent: number, text: string) => void;
    setStatus: (text: string) => void;
    onSymbolComplete?: (index: number, result: BatchBacktestSymbolResult) => void;
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

/**
 * Normalize a raw symbol list: trim, uppercase, split on newlines / commas /
 * whitespace, drop empties, dedupe while preserving first-seen order.
 *
 * Mirrors the Finder universe textarea contract so a user can paste the same
 * list in either place.
 */
export function parseBatchSymbols(raw: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const piece of raw.split(/[\s,]+/)) {
        const normalized = piece.trim().toUpperCase();
        if (!normalized) continue;
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        out.push(normalized);
    }
    return out;
}

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
                callbacks.onSymbolComplete?.(i, failure);
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
                callbacks.onSymbolComplete?.(i, failure);
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
            callbacks.onSymbolComplete?.(i, failure);
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
            results[i] = result;
            callbacks.onSymbolComplete?.(i, result);
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
            callbacks.onSymbolComplete?.(i, failure);
        }
    }

    callbacks.setProgress(100, "Done");
    callbacks.setStatus("Idle");

    // Fill any unset slots (loop broke early on cancel) so the array is dense.
    for (let i = 0; i < results.length; i += 1) {
        if (!results[i]) {
            results[i] = {
                symbol: symbols[i],
                status: "no_trades",
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

    // `signals` is only consumed by Mine Timing, and Mine only runs on
    // synthetic pair rows (parsePortfolioSyntheticPairSymbol gates it in
    // buildMinerPairArtifacts / hasMineableArtifacts). For non-synthetic
    // rows the array has no remaining reader, so drop it to free the
    // per-row Signal[] allocation across large batches.
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

    const holdBars: number[] = [];
    const holdDays: number[] = [];
    for (const trade of result.trades) {
        const entryIndex = timeIndex.get(timeKey(trade.entryTime));
        const exitIndex = timeIndex.get(timeKey(trade.exitTime));
        if (entryIndex === undefined || exitIndex === undefined || exitIndex < entryIndex) {
            continue;
        }
        holdBars.push(exitIndex - entryIndex);

        const entrySec = parseTimeToUnixSeconds(trade.entryTime);
        const exitSec = parseTimeToUnixSeconds(trade.exitTime);
        if (entrySec !== null && exitSec !== null && exitSec >= entrySec) {
            holdDays.push((exitSec - entrySec) / 86_400);
        }
    }

    if (holdBars.length === 0) {
        return {
            avgHoldBars: null,
            maxHoldBars: null,
            avgHoldDays: null,
            maxHoldDays: null,
            exposurePercent: null,
        };
    }

    const totalHoldBars = holdBars.reduce((sum, value) => sum + value, 0);
    const totalHoldDays = holdDays.reduce((sum, value) => sum + value, 0);
    return {
        avgHoldBars: totalHoldBars / holdBars.length,
        maxHoldBars: Math.max(...holdBars),
        avgHoldDays: holdDays.length > 0 ? totalHoldDays / holdDays.length : null,
        maxHoldDays: holdDays.length > 0 ? Math.max(...holdDays) : null,
        exposurePercent: Math.min(100, (totalHoldBars / Math.max(1, data.length - 1)) * 100),
    };
}
