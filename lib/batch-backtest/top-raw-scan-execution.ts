import { executeBacktest, prepareClosedCandleData } from "../backtest-executor";
import { selectClosedCandleWindow } from "../alert-evaluation-window";
import { parseTimeToUnixSeconds } from "../time-normalization";
import { strategies } from "../strategies/library";
import { loadServerBatchDataset } from "./server-batch-data-loader";
import type { ScanPair, ScanRequest, ScanVote } from "./top-raw-scan-contract";
import type { OHLCVData, Trade } from "../types/strategies";

/** All end-of-data positions count, including offsetting/multiple positions. */
export function scanEndpointVote(trades: ReadonlyArray<Pick<Trade, "type" | "exitReason">>): { vote: number; active: number } {
    let vote = 0, active = 0;
    for (const trade of trades) if (trade.exitReason === "end_of_data" && (trade.type === "long" || trade.type === "short")) {
        vote += trade.type === "long" ? 1 : -1; active++;
    }
    return { vote, active };
}
export async function executeScanPair(
    pair: ScanPair, request: ScanRequest, asOf: number, evaluationCutoff: number,
    load: typeof loadServerBatchDataset = loadServerBatchDataset,
    execute: typeof executeBacktest = executeBacktest,
): Promise<ScanVote> {
    const candles: OHLCVData[] = await load(pair.symbol, request.interval, undefined, { preferInMemorySyntheticPairs: true });
    const window = selectClosedCandleWindow(candles, request.interval, evaluationCutoff);
    if (!window || window.closedCandleTimeSec !== asOf || !window.candles.some(c => parseTimeToUnixSeconds(c.time) === asOf)) throw new Error(`Pair does not contain frozen endpoint ${asOf}.`);
    const strategy = strategies[request.strategyKey];
    if (!strategy) throw new Error("Unknown built-in strategy.");
    const output = await execute({
        ohlcvData: candles, closedCandleDataOverride: prepareClosedCandleData(candles, request.interval, request.backtestSettings, evaluationCutoff),
        interval: request.interval, primarySymbol: pair.symbol, strategyKey: request.strategyKey,
        strategy, strategyParams: request.strategyParams, backtestSettings: request.backtestSettings, capitalSettings: request.capitalSettings,
        context: { blockRange: null, engineMode: "auto", useRustEnginePreference: request.useRustEnginePreference, nowSec: evaluationCutoff },
        backtestRunOptions: { includeAdvancedAnalytics: false, includeSharpeRatio: false, useCompactBacktest: false, omitEquityCurve: true, skipDrawdown: true, skipResultPostProcessing: true },
    });
    return { key: pair.key, ...scanEndpointVote(output.result.trades), engine: output.engineUsed === "rust" ? "rust" : "typescript" };
}
