/**
 * Shared synthetic-pair artifact types.
 *
 * Extracted from `batch-synthetic-state-miner.ts` so the data contract used by
 * OPEN_SCORE USD Replay and S&P 500 TOP_MEAN can be imported
 * without pulling in a separate analysis engine. The OPEN_SCORE USD analysis
 * uses these artifacts; the artifacts themselves are still produced
 * by the Batch server plugin's per-symbol artifact store and consumed by the
 * surviving analysis features.
 */

import type { BacktestResult, OHLCVData, Signal, Trade } from "../types/strategies";

/**
 * One synthetic pair's full per-run artifact: the OHLCV legs aggregated into
 * the pair ratio series, the strategy signals emitted on it, and the resulting
 * backtest. General callers can supply full arrays. Temporary Batch replay
 * artifacts keep complete trades and scalars, with empty candle, signal,
 * and equity-curve arrays because OPEN_SCORE does not read those fields.
 */
export interface BatchSyntheticPairArtifact {
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    /**
     * Marked forms of the legs (e.g. `AAPL•`, `NVDA♦`) when the pair came
     * from a non-crypto source. Forwarded so the analysis target loader can
     * resolve the correct provider symbol instead of blindly appending
     * `USDT`. Optional because legacy callers/tests construct artifacts
     * directly with only the stripped asset names.
     */
    baseSymbol?: string;
    quoteSymbol?: string;
    data: OHLCVData[];
    signals: Signal[];
    result: BacktestResult & { trades: Array<Trade & { directionalMaturityTimeSec?: number | null }> };
}
