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

import { executeBacktest } from "../backtest-executor";
import type {
    BacktestResult,
    BacktestSettings,
    OHLCVData,
    Strategy,
    StrategyParams,
    Time,
} from "../types/strategies";
import type { CapitalSettings } from "../types/backtest";

// ============================================================================
// Public types
// ============================================================================

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
    error?: string;
}

export interface BatchBacktestRunInput {
    interval: string;
    strategyKey: string;
    strategy: Strategy;
    strategyParams: StrategyParams;
    backtestSettings: BacktestSettings;
    capitalSettings: CapitalSettings;
    symbols: string[];
    /** Loads one symbol's OHLCV series without touching the live chart. */
    loadDataset: (symbol: string, interval: string, signal?: AbortSignal) => Promise<OHLCVData[]>;
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

    for (let i = 0; i < symbols.length; i += 1) {
        if (cancelCheck()) {
            abort.abort();
            break;
        }

        const symbol = symbols[i];
        callbacks.setProgress((i / total) * 100, `Running ${symbol} (${i + 1}/${total})...`);
        callbacks.setStatus(`Backtesting ${symbol}...`);

        let data: OHLCVData[] = [];
        try {
            data = await input.loadDataset(symbol, input.interval, abort.signal);
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
            continue;
        }

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
                context: {
                    blockRange: null,
                    annotatePolymarket: false,
                    engineMode: "auto",
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
            const result = buildSymbolResult(symbol, data, output.result);
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

    return {
        symbol,
        status,
        barCount: data.length,
        firstTime: data[0]?.time,
        lastTime: data[data.length - 1]?.time,
        result,
    };
}
