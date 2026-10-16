import { executeBacktest, prepareClosedCandleData } from "../backtest-executor";
import { selectClosedCandleWindow } from "../alert-evaluation-window";
import { parseTimeToUnixSeconds } from "../time-normalization";
import { computeProfitNowConfidenceWeight } from "./open-score-replay/statistics";
import { strategies } from "../strategies/library";
import { loadServerBatchDataset } from "./server-batch-data-loader";
import type { ScanExecutionRequest, ScanPair, ScanVote } from "./top-raw-scan-contract";
import type { OHLCVData, Trade } from "../types/strategies";

/** All end-of-data positions count, including offsetting/multiple positions.
 *
 * profitNow/profitNowConf reproduce the OPEN_SCORE causal PROFIT_NOW semantics
 * (open-score-replay/artifact-scan.ts): each trade's vote applies only when the
 * pair's realized net PnL from trades closed BEFORE its entry was strictly
 * positive (all PnL known; exits at a timestamp count before entries at that
 * timestamp), and the confidence weight of that closed history is
 * n/(n+1) × realizedNet/Σ|pnl| clamped to [0,1]. */
export function scanEndpointVote(trades: ReadonlyArray<Pick<Trade, "type" | "exitReason" | "pnl" | "entryTime" | "exitTime">>): { vote: number; active: number; profitNow: number; profitNowConf: number } {
    const ledger: Array<{ t: number; out: boolean; idx: number }> = [];
    trades.forEach((trade, idx) => {
        const entrySec = parseTimeToUnixSeconds(trade.entryTime);
        if (entrySec === null) return;
        ledger.push({ t: entrySec, out: false, idx });
        if (trade.exitReason === "end_of_data") return;
        const exitSec = parseTimeToUnixSeconds(trade.exitTime);
        if (exitSec === null) return;
        ledger.push({ t: exitSec, out: true, idx });
    });
    ledger.sort((a, b) => a.t - b.t || (a.out === b.out ? 0 : a.out ? -1 : 1));
    let realized = 0, grossAbsPnl = 0, closedTradeCount = 0, pnlKnown = true;
    const applied = new Array<boolean>(trades.length).fill(false), weights = new Array<number>(trades.length).fill(0);
    for (const step of ledger) {
        const pnl = trades[step.idx]!.pnl;
        if (!Number.isFinite(pnl)) pnlKnown = false;
        if (step.out) {
            if (Number.isFinite(pnl)) { realized += pnl!; grossAbsPnl += Math.abs(pnl!); closedTradeCount += 1; }
        } else {
            applied[step.idx] = pnlKnown && realized > 0;
            weights[step.idx] = pnlKnown ? computeProfitNowConfidenceWeight(closedTradeCount, realized, grossAbsPnl) : 0;
        }
    }
    let vote = 0, active = 0, profitNow = 0, profitNowConf = 0;
    trades.forEach((trade, idx) => {
        if (trade.exitReason !== "end_of_data" || (trade.type !== "long" && trade.type !== "short")) return;
        const sign = trade.type === "long" ? 1 : -1;
        vote += sign; active++;
        if (applied[idx]!) profitNow += sign;
        profitNowConf += sign * weights[idx]!;
    });
    return { vote, active, profitNow, profitNowConf };
}
export async function executeScanPair(
    pair: ScanPair, request: ScanExecutionRequest, asOf: number, evaluationCutoff: number,
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
