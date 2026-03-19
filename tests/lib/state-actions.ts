import { debugLogger } from "./debug-logger";
import { state, type BacktestResultSource, type TwoHourParityBacktestResults } from "./state";
import type { BacktestResult, OHLCVData } from "./strategies/index";

export function commitBacktestResult(
    result: BacktestResult,
    source: BacktestResultSource,
    options?: {
        parityResults?: TwoHourParityBacktestResults | null;
        reason?: string;
    }
): void {
    const parityResults = options?.parityResults ?? null;
    debugLogger.event('state.commit.backtest_result', {
        source,
        trades: result.totalTrades,
        parity: Boolean(parityResults),
        reason: options?.reason,
    });
    state.set('twoHourParityBacktestResults', parityResults);
    state.set('currentBacktestResultSource', source);
    state.set('currentBacktestResult', result);
}

export function commitParityBacktestResults(
    parityResults: TwoHourParityBacktestResults | null,
    reason?: string
): void {
    debugLogger.event('state.commit.parity_results', {
        parity: Boolean(parityResults),
        baseline: parityResults?.baseline ?? null,
        reason,
    });
    state.set('twoHourParityBacktestResults', parityResults);
}

export function commitOhlcvData(
    data: OHLCVData[],
    reason?: string
): void {
    debugLogger.event('state.commit.ohlcv', {
        symbol: state.currentSymbol,
        interval: state.currentInterval,
        candles: data.length,
        reason,
    });
    state.set('ohlcvData', data);
}
